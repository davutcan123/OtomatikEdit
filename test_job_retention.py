"""Exercise bounded SSE replay and completed job lifetime in isolation."""
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from test_update import load_source_backend


class JobRetentionTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.backend = load_source_backend(cls.temporary.name)

    async def asyncSetUp(self):
        self.backend.jobs.clear()

    async def collect(self, job_id):
        response = await self.backend.stream_events(job_id)
        return [message async for message in response.body_iterator]

    async def test_two_connected_clients_and_a_late_client_see_the_result(self):
        with patch.object(self.backend, "_JOB_EVENT_LIMIT", 3):
            events = self.backend.JobEvents()

        async def work():
            await proceed.wait()
            for percent in range(8):
                await events.put({"type": "progress", "percent": percent})
            await events.put({"type": "result", "download_url": "/download/test/mp4"})
            await events.put(None)

        proceed = asyncio.Event()
        self.backend.jobs["job"] = {"q": events}
        task = self.backend.schedule_job("job", work())
        clients = [asyncio.create_task(self.collect("job")) for _ in range(2)]
        await asyncio.sleep(0)
        proceed.set()
        await task
        expected = await self.collect("job")
        self.assertEqual(expected, await clients[0])
        self.assertEqual(expected, await clients[1])
        self.assertEqual(len(expected), 3)
        self.assertIn("/download/test/mp4", expected[-1])
        self.assertEqual(self.backend.active_job_count(), 0)

    async def test_reconnect_requests_missing_ids_and_does_not_cancel_job(self):
        events = self.backend.JobEvents()
        self.backend.jobs["job"] = {"q": events}
        proceed = asyncio.Event()

        async def work():
            await events.put({"type": "progress", "percent": 10})
            await events.put({"type": "log", "message": "started"})
            await proceed.wait()
            await events.put({"type": "result", "download_url": "/download/job/mp4"})
            await events.put(None)

        task = self.backend.schedule_job("job", work())
        stream = (await self.backend.stream_events("job")).body_iterator
        try:
            self.assertTrue((await anext(stream)).startswith("id: 1\n"))
            self.assertTrue((await anext(stream)).startswith("id: 2\n"))
            await stream.aclose()
            self.assertFalse(task.done())
        finally:
            proceed.set()
            await task

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.backend.app), base_url="http://editor"
        ) as client:
            resumed = await client.get("/stream-events/job", headers={"Last-Event-ID": "2"})
            self.assertEqual(resumed.status_code, 200)
            self.assertEqual(resumed.text.splitlines()[0], "id: 3")
            self.assertIn("/download/job/mp4", resumed.text)
            self.assertNotIn("started", resumed.text)
            self.assertEqual((await client.get("/stream-events/job", headers={"Last-Event-ID": "3"})).text, "")
            for invalid in ("99", "-1", "broken"):
                response = await client.get("/stream-events/job", headers={"Last-Event-ID": invalid})
                self.assertEqual(response.status_code, 400)
            self.backend.forget_completed_job("job")
            expired = await client.get("/stream-events/job", headers={"Last-Event-ID": "2"})
            self.assertEqual(expired.status_code, 404)

    async def test_heartbeat_does_not_shift_ids_and_unreported_finish_is_terminal(self):
        events = self.backend.JobEvents()
        self.backend.jobs["job"] = {"q": events}
        stream = (await self.backend.stream_events("job")).body_iterator
        with patch.object(self.backend, "_JOB_HEARTBEAT_SECONDS", .001):
            self.assertEqual(await anext(stream), "event: heartbeat\ndata: {}\n\n")
        events.finish()
        self.assertTrue((await anext(stream)).startswith('id: 1\ndata: {"type": "error"'))
        with self.assertRaises(StopAsyncIteration):
            await anext(stream)

    async def test_eviction_keeps_existing_stream_and_output(self):
        output = Path(self.backend.OUTPUT_DIR) / "out_old.mp4"
        output.write_bytes(b"completed output")

        def start(job_id, proceed=None):
            events = self.backend.JobEvents()
            self.backend.jobs[job_id] = {"q": events}

            async def complete():
                if proceed is not None:
                    await proceed.wait()
                await events.put({"type": "result"})
                await events.put(None)

            return self.backend.schedule_job(job_id, complete())

        with (
            patch.object(self.backend, "_COMPLETED_JOB_LIMIT", 1),
            patch.object(self.backend, "time", wraps=self.backend.time) as clock,
        ):
            # Both jobs finish on the same timer tick, in reverse start order.
            clock.monotonic.return_value = 123
            proceed = asyncio.Event()
            new = start("new", proceed)
            await start("old")
            old_stream = await self.backend.stream_events("old")
            wait = asyncio.Event()
            self.backend.jobs["running"] = {"q": self.backend.JobEvents()}
            running = self.backend.schedule_job("running", wait.wait())
            try:
                proceed.set()
                await new
                self.assertEqual(set(self.backend.jobs), {"running", "new"})
                self.assertEqual(len([line async for line in old_stream.body_iterator]), 1)
                self.assertEqual(output.read_bytes(), b"completed output")
            finally:
                wait.set()
                await running

    async def test_ttl_removes_inactive_job_without_a_subsequent_request(self):
        self.backend.jobs["expired"] = {"q": self.backend.JobEvents()}
        with patch.object(self.backend, "_COMPLETED_JOB_TTL", 0):
            await self.backend.schedule_job("expired", asyncio.sleep(0))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertEqual(self.backend.jobs, {})
