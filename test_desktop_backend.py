"""Run with the normal app dependencies; all writable data stays in a temp folder."""
import asyncio
import base64
import hashlib
import importlib.util
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient


class DesktopBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.environ = patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name,
            "SMART_EDITOR_DESKTOP_TOKEN": "test-desktop-token",
            "SMART_EDITOR_LEGACY_DIR": "",
        })
        cls.environ.start()
        spec = importlib.util.spec_from_file_location("desktop_test_app", Path(__file__).with_name("app.py"))
        cls.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.backend)

    @classmethod
    def tearDownClass(cls):
        cls.environ.stop()
        cls.temporary.cleanup()

    def test_health_requires_desktop_token_and_never_exposes_paths(self):
        with TestClient(self.backend.app) as client:
            self.assertEqual(client.get("/api/health").status_code, 403)
            self.assertEqual(client.get("/api/health", headers={"X-Desktop-Token": "incorrect"}).status_code, 403)
            response = client.get("/api/health", headers={"X-Desktop-Token": "test-desktop-token"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(set(response.json()), {"status", "version", "desktop", "active_jobs",
                                                    "active_requests", "preparing", "update_ready"})
            self.assertEqual(response.json()["active_jobs"], 0)
            self.assertIs(response.json()["desktop"], True)
            self.assertEqual(Path(self.backend.DATA_DIR), Path(self.temporary.name).resolve())

    def test_frozen_backend_rejects_source_update_before_reading_body(self):
        with TestClient(self.backend.app) as client:
            response = client.post("/api/apply-update", content=b"not JSON", headers={"X-Desktop-Token": "test-desktop-token"})
            self.assertEqual(response.status_code, 409)
            self.assertIn("kurulum dosyası", response.json()["detail"])

    def test_desktop_csp_only_allows_actual_rendered_inline_scripts(self):
        class Scripts(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=False)
                self.inside_script = False
                self.scripts = []
                self.inline_handlers = []

            def handle_starttag(self, tag, attrs):
                self.inline_handlers.extend(name for name, _ in attrs if name.lower().startswith("on"))
                if tag == "script":
                    self.inside_script = True
                    self.scripts.append("")

            def handle_data(self, data):
                if self.inside_script:
                    self.scripts[-1] += data

            def handle_endtag(self, tag):
                if tag == "script":
                    self.inside_script = False

        with TestClient(self.backend.app) as client:
            response = client.get("/", headers={"X-Desktop-Token": "test-desktop-token"})
            self.assertEqual(response.status_code, 200)
            policy = response.headers["Content-Security-Policy"]
            parser = Scripts()
            parser.feed(response.text)
            self.assertTrue(parser.scripts)
            self.assertFalse(parser.inline_handlers)
            directives = dict(item.strip().split(" ", 1) for item in policy.split(";") if item.strip())
            allowed_scripts = set(directives["script-src"].split())
            bundled_scripts = {"http://testserver/static/video_tracks.js", "http://testserver/static/timeline_tools.js"}
            self.assertEqual(allowed_scripts, {
                "'sha256-" + base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii") + "'"
                for script in parser.scripts
            } | bundled_scripts)
            self.assertNotIn("'self'", allowed_scripts)
            self.assertNotIn("'unsafe-inline'", allowed_scripts)
            for url in bundled_scripts:
                self.assertEqual(client.get(url, headers={"X-Desktop-Token": "test-desktop-token"}).status_code, 200)
            self.assertNotIn("'unsafe-eval'", policy)
            for name in ["object-src", "frame-src", "frame-ancestors", "base-uri"]:
                self.assertEqual(directives[name], "'none'")
            self.assertEqual(directives["connect-src"], "'self'")

            with patch.object(self.backend, "DESKTOP_MODE", False):
                self.assertNotIn("Content-Security-Policy", client.get("/").headers)

    def test_shutdown_terminates_owned_process(self):
        async def exercise():
            process = await self.backend.create_media_process(sys.executable, "-c", "import time; time.sleep(60)")
            self.assertIsNone(process.returncode)
            await self.backend.stop_media_processes()
            self.assertIsNotNone(process.returncode)
        asyncio.run(exercise())

    def test_native_import_copies_projects_without_mutating_legacy(self):
        with tempfile.TemporaryDirectory() as source, TestClient(self.backend.app) as client:
            source_path = Path(source)
            (source_path / "projects").mkdir()
            (source_path / "projects" / "imported.json").write_text(json.dumps({"timelines": []}))
            response = client.post("/api/desktop/import-projects", json={"directory": source}, headers={"X-Desktop-Token": "test-desktop-token"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["projects"], 1)
            self.assertTrue((source_path / "projects" / "imported.json").exists())
            self.assertTrue((Path(self.backend.PROJECT_DIR) / "imported.json").exists())

    def test_health_counts_queued_running_but_not_completed_or_cancelled_jobs(self):
        async def exercise():
            with patch.dict(self.backend.jobs, {}, clear=True):
                ready = asyncio.Event()
                self.backend.jobs["render"] = {"q": asyncio.Queue()}
                task = self.backend.schedule_job("render", ready.wait())
                self.assertEqual((await self.backend.api_health())["active_jobs"], 1)
                await asyncio.sleep(0)
                self.assertEqual((await self.backend.api_health())["active_jobs"], 1)
                ready.set()
                await task
                await self.backend.jobs["render"]["q"].put({"type": "result"})
                self.assertEqual((await self.backend.api_health())["active_jobs"], 0)
                self.backend.jobs["analysis"] = {"q": asyncio.Queue()}
                cancelled = self.backend.schedule_job("analysis", asyncio.Event().wait())
                cancelled.cancel()
                await asyncio.gather(cancelled, return_exceptions=True)
                self.assertEqual((await self.backend.api_health())["active_jobs"], 0)
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
