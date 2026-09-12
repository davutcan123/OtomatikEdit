"""Freeze all server dependencies and media tools without copying user data.

Run with the build environment's Python. Requires requirements.txt and
requirements-build.txt. Builds for the current platform only; use CI for the
other OS. FFmpeg/FFprobe are accepted via SMART_EDITOR_FFMPEG/FFPROBE, the local
tools directory, or PATH. No runtime installation or administrator access is
needed by the resulting application.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "build" / "backend"


def media_binary(name: str) -> Path:
    configured = os.environ.get(f"SMART_EDITOR_{name.upper()}")
    suffix = ".exe" if os.name == "nt" else ""
    local = ROOT / "tools" / "ffmpeg" / "bin" / f"{name}{suffix}"
    candidate = configured or (str(local) if local.is_file() else shutil.which(name))
    if not candidate:
        raise RuntimeError(f"{name} is missing. Install FFmpeg or set SMART_EDITOR_{name.upper()}.")
    path = Path(candidate).resolve()
    if not path.is_file():
        raise RuntimeError(f"{name} executable does not exist: {path}")
    subprocess.run([str(path), "-version"], check=True, capture_output=True, timeout=30)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check prerequisites without building")
    args = parser.parse_args()
    try:
        missing = [name for name in (
            "PyInstaller", "fastapi", "uvicorn", "multipart", "jinja2",
            "faster_whisper", "argostranslate", "PIL",
        ) if importlib.util.find_spec(name) is None]
        if missing:
            raise RuntimeError(
                f"Missing build dependencies: {', '.join(missing)}. "
                "Run python -m pip install -r requirements.txt -r requirements-build.txt."
            )
        for asset in ("templates/index.html", "static/editor.css", "version.json"):
            if not (ROOT / asset).is_file():
                raise RuntimeError(f"Missing asset {asset}; run npm run build:css before packaging.")
        tools = {name: media_binary(name) for name in ("ffmpeg", "ffprobe")}
        if args.check:
            print("Backend build prerequisites are ready.")
            return 0

        env = dict(os.environ)
        env.update({f"SMART_EDITOR_{name.upper()}": str(path) for name, path in tools.items()})
        notices = ROOT / "build" / "backend-notices"
        notices.mkdir(parents=True, exist_ok=True)
        # Keep codec build/license details and dependency versions with the
        # generated package. Only explicitly listed resources enter the bundle.
        license_text = subprocess.check_output(
            [str(tools["ffmpeg"]), "-L"], stderr=subprocess.STDOUT, text=True,
        )
        (notices / "ffmpeg-license.txt").write_text(license_text, encoding="utf-8")
        (notices / "ffmpeg-source.txt").write_text(
            "FFmpeg source and license: https://ffmpeg.org/download.html\n"
            "Windows build source: https://www.gyan.dev/ffmpeg/builds/\n"
            "macOS build formula: https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/f/ffmpeg.rb\n",
            encoding="utf-8",
        )
        versions = {dist.metadata["Name"]: dist.version for dist in importlib.metadata.distributions()}
        (notices / "python-dependencies.json").write_text(
            json.dumps(versions, indent=2, sort_keys=True), encoding="utf-8",
        )
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
            "--distpath", str(DESTINATION), "--workpath", str(ROOT / "build" / "pyinstaller"),
            str(ROOT / "desktop" / "backend.spec"),
        ], cwd=ROOT, env=env, check=True)
        suffix = ".exe" if os.name == "nt" else ""
        executable = DESTINATION / "OtomatikEditBackend" / f"OtomatikEditBackend{suffix}"
        # Strip developer paths before testing so missing bundled binaries do
        # not accidentally pass via a locally installed FFmpeg.
        check_env = dict(os.environ)
        check_env.pop("SMART_EDITOR_FFMPEG", None)
        check_env.pop("SMART_EDITOR_FFPROBE", None)
        check_env.pop("SMART_EDITOR_RESOURCES_DIR", None)
        check_env["SMART_EDITOR_DESKTOP"] = "1"
        check_env["SMART_EDITOR_DESKTOP_TOKEN"] = secrets.token_urlsafe(32)
        check_env["SMART_EDITOR_OPEN_BROWSER"] = "0"
        with tempfile.TemporaryDirectory(prefix="otomatik-edit-smoke-") as temporary:
            check_env["SMART_EDITOR_DATA_DIR"] = temporary
            subprocess.run(
                [str(executable), "--self-test"], cwd=temporary, env=check_env,
                check=True, timeout=180,
            )
        print(f"Backend ready: {executable.parent}")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Backend packaging failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
