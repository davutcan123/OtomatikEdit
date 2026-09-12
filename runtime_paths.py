"""Separate installed resources from writable desktop projects and media."""

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from urllib.parse import unquote


@dataclass(frozen=True)
class RuntimePaths:
    source_dir: Path
    resources_dir: Path
    data_dir: Path
    desktop: bool


def resolve_runtime_paths(source_file, environ=None, platform=None, bundle_dir=None):
    env = os.environ if environ is None else environ
    platform = sys.platform if platform is None else platform
    source_dir = Path(source_file).resolve().parent
    desktop = env.get("SMART_EDITOR_DESKTOP", "").strip().lower() in {"1", "true", "yes", "on"}
    bundle_dir = getattr(sys, "_MEIPASS", None) if bundle_dir is None else bundle_dir
    resources_dir = Path(env.get("SMART_EDITOR_RESOURCES_DIR") or bundle_dir or source_dir).resolve()
    if not desktop:
        return RuntimePaths(source_dir, resources_dir, source_dir, False)

    configured = env.get("SMART_EDITOR_DATA_DIR", "").strip()
    if configured:
        data_dir = Path(configured).expanduser().resolve()
    else:
        user_home = Path.home()
        if platform == "win32":
            parent = Path(env.get("LOCALAPPDATA") or env.get("APPDATA") or user_home / "AppData" / "Local")
        elif platform == "darwin":
            parent = user_home / "Library" / "Application Support"
        else:
            parent = Path(env.get("XDG_DATA_HOME") or user_home / ".local" / "share")
        data_dir = parent / "OtomatikEdit"
    return RuntimePaths(source_dir, resources_dir, data_dir, True)


def _copy_new_file(source, destination):
    """Publish a complete copy atomically, without ever replacing an existing file."""
    if destination.exists():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".import-", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as incoming:
            shutil.copyfileobj(incoming, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            return False
        return True
    finally:
        temporary.unlink(missing_ok=True)


def _referenced_media(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from _referenced_media(child)
    elif isinstance(value, list):
        for child in value:
            yield from _referenced_media(child)
    elif isinstance(value, str):
        candidate = unquote(value[7:]) if value.startswith("/video/") else value
        # Upload IDs are basenames on all supported platforms.
        if candidate and candidate not in {".", ".."} and "/" not in candidate and "\\" not in candidate:
            yield candidate


def import_legacy_projects(paths, legacy_dir):
    """Import saved projects and their referenced uploads once, leaving originals intact.

    Existing destination projects/media always win. Interrupted copies are never
    exposed as final files; failed imports may safely be retried on the next start.
    Outputs and unreferenced uploads can be large and are deliberately not copied.
    """
    report = {"projects": 0, "media": 0, "errors": 0}
    if not paths.desktop or not legacy_dir:
        return report
    legacy = Path(legacy_dir).expanduser().resolve()
    if legacy == paths.data_dir.resolve() or not (legacy / "projects").is_dir():
        return report
    marker_id = hashlib.sha256(str(legacy).encode("utf-8")).hexdigest()[:16]
    marker = paths.data_dir / f".legacy-import-{marker_id}.json"
    if marker.exists():
        return report
    paths.data_dir.mkdir(parents=True, exist_ok=True)
    uploads = legacy / "uploads"
    for project in sorted((legacy / "projects").glob("*.json")):
        try:
            if project.is_symlink():
                continue
            payload = json.loads(project.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or not isinstance(payload.get("timelines"), list):
                continue
            for file_id in set(_referenced_media(payload)):
                source = uploads / file_id
                if source.is_file() and not source.is_symlink():
                    report["media"] += _copy_new_file(source, paths.data_dir / "uploads" / file_id)
            report["projects"] += _copy_new_file(project, paths.data_dir / "projects" / project.name)
        except (OSError, ValueError):
            report["errors"] += 1
    if not report["errors"]:
        try:
            with marker.open("x", encoding="utf-8") as handle:
                json.dump(report, handle)
        except FileExistsError:
            pass
    return report


def release_download_url(assets, desktop=False, platform=None, machine=None):
    """Never offer a desktop archive to the legacy source-code updater."""
    import platform as platform_module
    import re
    platform = sys.platform if platform is None else platform
    machine = platform_module.machine().lower() if machine is None else machine.lower()
    if not desktop:
        return next((asset.get("browser_download_url", "") for asset in assets
                     if re.fullmatch(r"OtomatikEdit-v\d+(?:\.\d+)+\.zip", asset.get("name", ""))), "")
    extensions = {"win32": (".exe", ".msi"), "darwin": (".dmg",), "linux": (".appimage", ".deb")}
    supported = extensions.get(platform, ())
    matches = [asset for asset in assets if asset.get("name", "").lower().endswith(supported)]
    architecture = "arm64" if machine in {"aarch64", "arm64"} else "x64"
    for asset in matches:
        if architecture in asset.get("name", "").lower():
            return asset.get("browser_download_url", "")
    return matches[0].get("browser_download_url", "") if matches else ""
