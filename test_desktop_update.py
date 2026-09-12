"""The desktop installer must never race an upload, saved project, or job."""
import asyncio
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import httpx
from fastapi.responses import Response
from starlette.background import BackgroundTask


class DesktopUpdateTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "update-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
        }):
            spec = importlib.util.spec_from_file_location("update_test_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)
        (Path(cls.backend.UPLOAD_DIR) / "source.mp4").write_bytes(b"test source; probes are stubbed")
        cls.headers = {"X-Desktop-Token": "update-test"}

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    async def asyncSetUp(self):
        self.backend.jobs.clear()
        self.backend.desktop_update_state.preparing = False
        self.assertEqual(self.backend.desktop_update_state.active_requests, 0)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.backend.app), base_url="http://editor", headers=self.headers,
        )

    async def asyncTearDown(self):
        self.backend.desktop_update_state.preparing = False
        tasks = [job["task"] for job in self.backend.jobs.values() if job.get("task") is not None]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()
        self.assertEqual(self.backend.desktop_update_state.active_requests, 0)

    async def prepare(self):
        return await self.client.post("/api/desktop/prepare-update")

    async def test_prepared_gate_blocks_writes_before_body_and_cancel_reopens(self):
        response = await self.prepare()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "preparing": True, "update_ready": True, "active_jobs": 0, "active_requests": 0,
        })
        self.assertEqual((await self.prepare()).status_code, 200)  # Idempotent.
        body_read = False

        async def body():
            nonlocal body_read
            body_read = True
            yield b"must not be consumed"

        for method, url in [("POST", "/upload"), ("POST", "/projects"), ("POST", "/start-render"),
                            ("POST", "/start-snapshot"), ("POST", "/start-subtitles"),
                            ("POST", "/api/desktop/import-projects"), ("DELETE", "/projects/test"),
                            ("GET", "/waveform/source.mp4")]:
            response = await self.client.request(method, url, content=body())
            self.assertEqual(response.status_code, 409, url)
            self.assertEqual(response.json()["code"], "desktop_update_preparing")
        self.assertFalse(body_read)
        health = (await self.client.get("/api/health")).json()
        self.assertTrue(health["preparing"])
        self.assertTrue(health["update_ready"])
        self.assertEqual(health["active_requests"], 0)
        self.assertEqual((await self.client.get("/api/version")).status_code, 200)
        self.assertEqual((await self.client.post("/api/desktop/cancel-update")).json(),
                         {"preparing": False, "update_ready": False})
        self.assertEqual((await self.client.post("/api/desktop/cancel-update")).status_code, 200)
        self.assertEqual((await self.client.post("/projects", json={"timelines": []})).status_code, 200)

    async def test_prepare_refuses_streaming_upload_without_interrupting_it(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def upload_chunks():
            yield b'--sample\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n'
            entered.set()
            await release.wait()
            yield b"image bytes\r\n--sample--\r\n"

        upload = asyncio.create_task(self.client.post("/upload", content=upload_chunks(),
                                     headers={"Content-Type": "multipart/form-data; boundary=sample"}))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            response = await self.prepare()
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["code"], "desktop_update_busy")
            self.assertEqual(response.json()["active_requests"], 1)
            self.assertFalse(response.json()["preparing"])
            self.assertFalse(upload.done())
        finally:
            release.set()
        self.assertEqual((await upload).status_code, 200)
        self.assertEqual((await self.prepare()).status_code, 200)

    async def test_prepare_refuses_both_starting_and_running_job(self):
        probe_entered, release_probe = threading.Event(), threading.Event()
        release_job = asyncio.Event()

        def slow_probe(_):
            probe_entered.set()
            if not release_probe.wait(5):
                raise TimeoutError("test did not release probe")
            return 4

        async def render(_):
            await release_job.wait()

        with patch.object(self.backend, "get_video_duration", slow_probe), \
             patch.object(self.backend, "video_has_audio", return_value=False), \
             patch.object(self.backend, "get_video_dimensions", return_value=(320, 180)), \
             patch.object(self.backend, "run_render_job", render):
            starting = asyncio.create_task(self.client.post("/start-render", data={
                "file_id": "source.mp4", "segments": '[{"fileId":"source.mp4","start":0,"end":4}]',
            }))
            try:
                self.assertTrue(await asyncio.to_thread(probe_entered.wait, 2))
                response = await self.prepare()
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["active_requests"], 1)
                self.assertEqual(response.json()["active_jobs"], 0)
            finally:
                release_probe.set()
            response = await starting
            self.assertEqual(response.status_code, 200, response.text)
            task = self.backend.jobs[response.json()["job_id"]]["task"]
            response = await self.prepare()
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["active_jobs"], 1)
            self.assertEqual(response.json()["active_requests"], 0)
            self.assertFalse(task.done())
            release_job.set()
            await task
            self.assertFalse(task.cancelled())
            self.assertEqual((await self.prepare()).status_code, 200)

    async def test_response_background_work_remains_in_flight(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def finish_write():
            entered.set()
            await release.wait()

        async def route():
            return Response(background=BackgroundTask(finish_write))

        self.backend.app.add_api_route("/test/update-background", route, methods=["POST"])
        request = asyncio.create_task(self.client.post("/test/update-background"))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            response = await self.prepare()
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["active_requests"], 1)
        finally:
            release.set()
        self.assertEqual((await request).status_code, 200)
        self.assertEqual((await self.prepare()).status_code, 200)

    async def test_failed_request_and_disconnect_release_counter(self):
        self.assertEqual((await self.client.post("/projects", content="invalid JSON")).status_code, 400)

        async def disconnected():
            yield b'{"timelines":'
            raise RuntimeError("simulated client disconnect")

        with self.assertRaisesRegex(RuntimeError, "simulated client disconnect"):
            await self.client.post("/projects", content=disconnected())
        self.assertEqual((await self.prepare()).status_code, 200)

    async def test_token_and_webmode_restrictions_and_direct_job_guard(self):
        response = await self.client.post("/api/desktop/prepare-update", headers={"X-Desktop-Token": "wrong"})
        self.assertEqual(response.status_code, 403)
        self.assertFalse(self.backend.desktop_update_state.preparing)
        await self.prepare()
        response = await self.client.post("/api/desktop/cancel-update", headers={"X-Desktop-Token": ""})
        self.assertEqual(response.status_code, 403)
        self.assertTrue(self.backend.desktop_update_state.preparing)
        self.backend.jobs["new"] = {"q": asyncio.Queue()}
        with self.assertRaisesRegex(RuntimeError, "Güncelleme"):
            self.backend.schedule_job("new", asyncio.sleep(0))
        self.assertNotIn("task", self.backend.jobs["new"])
        with patch.object(self.backend, "DESKTOP_MODE", False):
            self.assertEqual((await self.prepare()).status_code, 404)
            self.assertEqual((await self.client.post("/api/desktop/cancel-update")).status_code, 404)
            self.assertEqual((await self.client.post("/projects", json={"timelines": []})).status_code, 200)
            self.assertFalse((await self.client.get("/api/health")).json()["update_ready"])


if __name__ == "__main__":
    unittest.main()
