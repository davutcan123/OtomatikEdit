"""Verify the source release notice using synthetic GitHub metadata."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from fastapi.testclient import TestClient
from runtime_paths import RuntimePaths


def load_source_backend(data_dir):
    root = Path(__file__).resolve().parent
    paths = RuntimePaths(root, root, Path(data_dir), False)
    spec = importlib.util.spec_from_file_location("source_update_test_app", root / "app.py")
    backend = importlib.util.module_from_spec(spec)
    with patch("runtime_paths.resolve_runtime_paths", return_value=paths):
        spec.loader.exec_module(backend)
    return backend


class SourceUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.backend = load_source_backend(cls.temporary.name)

    def check(self, release):
        with patch.object(self.backend, "_latest_release", return_value=release):
            with TestClient(self.backend.app) as client:
                return client.get("/api/check-update").json()

    def test_source_release_uses_official_release_page(self):
        result = self.check({
            "tag_name": "v9.20.30",
            "html_url": "https://example.com",
            "assets": [{"name": "OtomatikEdit-v9.20.30.zip", "state": "uploaded"}],
        })
        self.assertTrue(result["update_available"])
        self.assertTrue(result["source_available"])
        self.assertEqual(result["release_url"], "https://github.com/davutcan123/OtomatikEdit/releases/tag/v9.20.30")

    def test_release_missing_source_archive_still_links_to_release(self):
        result = self.check({"tag_name": "v9.20.30", "assets": [
            {"name": "OtomatikEdit-9.20.30-mac-arm64.zip", "state": "uploaded"},
            {"name": "OtomatikEdit-v9.20.30.zip", "state": "new"},
            {"name": "OtomatikEdit-v1.0.0.zip", "state": "uploaded"},
        ]})
        self.assertTrue(result["update_available"])
        self.assertFalse(result["source_available"])

    def test_only_new_published_version_is_reported(self):
        version = self.backend.APP_VERSION
        for release in ({"tag_name": "v" + version}, {"tag_name": "latest"},
                        {"tag_name": "v9.20.30", "draft": True},
                        {"tag_name": "v9.20.30", "prerelease": True}):
            with self.subTest(release=release):
                self.assertFalse(self.check(release)["update_available"])

    def test_certificate_errors_leave_the_notice_unavailable(self):
        with patch.object(self.backend, "_latest_release", side_effect=URLError("TLS validation failed")):
            with TestClient(self.backend.app) as client:
                self.assertFalse(client.get("/api/check-update").json()["update_available"])

    def test_legacy_in_place_update_returns_gone(self):
        with TestClient(self.backend.app) as client:
            response = client.post("/api/apply-update")
            self.assertEqual(response.status_code, 410)
            self.assertEqual(self.backend.jobs, {})


if __name__ == "__main__":
    unittest.main()
