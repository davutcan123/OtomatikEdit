import json
from pathlib import Path
import tempfile
import unittest

from runtime_paths import import_legacy_projects, release_download_url, resolve_runtime_paths


class RuntimePathsTests(unittest.TestCase):
    def test_browser_mode_keeps_source_data(self):
        source = Path(tempfile.gettempdir()).resolve() / "workspace"
        paths = resolve_runtime_paths(source / "app.py", {"SMART_EDITOR_DATA_DIR": "/other"})
        self.assertEqual(paths.data_dir, source)
        self.assertFalse(paths.desktop)

    def test_frozen_resources_are_separate_from_writable_data(self):
        root = Path(tempfile.gettempdir()).resolve()
        paths = resolve_runtime_paths(
            root / "installed" / "backend" / "app.py",
            {"SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DATA_DIR": str(root / "user" / "project-data")},
            bundle_dir=root / "installed" / "backend" / "_internal",
        )
        self.assertEqual(paths.resources_dir, root / "installed" / "backend" / "_internal")
        self.assertEqual(paths.data_dir, root / "user" / "project-data")

    def test_windows_default_uses_per_user_data(self):
        local_app_data = Path(tempfile.gettempdir()).resolve() / "users" / "brother" / "AppData" / "Local"
        paths = resolve_runtime_paths(
            "/installed/app.py",
            {"SMART_EDITOR_DESKTOP": "1", "LOCALAPPDATA": str(local_app_data)},
            platform="win32",
        )
        self.assertEqual(paths.data_dir, local_app_data / "OtomatikEdit")

    def test_import_only_copies_referenced_media_and_never_replaces_projects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            legacy = root / "legacy"
            (legacy / "projects").mkdir(parents=True)
            (legacy / "uploads").mkdir()
            data = root / "data"
            paths = resolve_runtime_paths(legacy / "app.py", {
                "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DATA_DIR": str(data),
            })
            old_project = {"name": "Eski", "timelines": [{"state": {
                "clips": [{"fileId": "video.mov"}], "imageLayers": [{"fileId": "foto.png"}],
            }}]}
            (legacy / "projects" / "test.json").write_text(json.dumps(old_project))
            (legacy / "uploads" / "video.mov").write_bytes(b"legacy video")
            (legacy / "uploads" / "foto.png").write_bytes(b"legacy image")
            (legacy / "uploads" / "unused.mov").write_bytes(b"unused")
            (data / "uploads").mkdir(parents=True)
            (data / "projects").mkdir()
            (data / "uploads" / "video.mov").write_bytes(b"new video")
            (data / "projects" / "test.json").write_text("current project")

            report = import_legacy_projects(paths, legacy)
            self.assertEqual(report, {"projects": 0, "media": 1, "errors": 0})
            self.assertEqual((data / "uploads" / "video.mov").read_bytes(), b"new video")
            self.assertEqual((data / "uploads" / "foto.png").read_bytes(), b"legacy image")
            self.assertEqual((data / "projects" / "test.json").read_text(), "current project")
            self.assertFalse((data / "uploads" / "unused.mov").exists())
            self.assertTrue((legacy / "uploads" / "foto.png").exists())
            self.assertEqual(import_legacy_projects(paths, legacy), {"projects": 0, "media": 0, "errors": 0})

    def test_failed_import_can_be_retried_without_overwriting_successful_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "legacy" / "projects").mkdir(parents=True)
            project = root / "legacy" / "projects" / "sample.json"
            project.write_text("unfinished JSON")
            paths = resolve_runtime_paths(root / "app.py", {
                "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DATA_DIR": str(root / "data"),
            })
            self.assertEqual(import_legacy_projects(paths, root / "legacy")["errors"], 1)
            project.write_text(json.dumps({"timelines": []}))
            self.assertEqual(import_legacy_projects(paths, root / "legacy")["projects"], 1)

    def test_installer_is_not_mistaken_for_source_update(self):
        assets = [
            {"name": "OtomatikEdit-1.1.0-mac-arm64.zip", "browser_download_url": "desktop archive"},
            {"name": "OtomatikEdit-v1.1.0-win-x64.zip", "browser_download_url": "another desktop archive"},
            {"name": "OtomatikEdit-v1.1.0.zip", "browser_download_url": "source archive"},
            {"name": "OtomatikEdit-1.1.0-mac-arm64.dmg", "browser_download_url": "arm installer"},
            {"name": "OtomatikEdit-1.1.0-mac-x64.dmg", "browser_download_url": "intel installer"},
            {"name": "OtomatikEdit-1.1.0-win-x64.exe", "browser_download_url": "windows installer"},
        ]
        self.assertEqual(release_download_url(assets), "source archive")
        self.assertEqual(release_download_url(assets, True, "darwin", "arm64"), "arm installer")
        self.assertEqual(release_download_url(assets, True, "darwin", "x86_64"), "intel installer")
        self.assertEqual(release_download_url(assets, True, "win32", "AMD64"), "windows installer")
        self.assertEqual(release_download_url(assets[:2]), "")


if __name__ == "__main__":
    unittest.main()
