"""Cancellation of real FFmpeg children and atomically published render outputs."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import httpx
from render_encoder import EncoderChoice, nvenc_h264_args


class RenderCancellationTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="render-cancellation-")
        cls.addClassCleanup(tmp.cleanup)
        cls.headers = {"X-Desktop-Token": "render-cancellation-test"}
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": cls.headers["X-Desktop-Token"],
            "SMART_EDITOR_DATA_DIR": tmp.name, "SMART_EDITOR_LEGACY_DIR": "",
        }):
            spec = importlib.util.spec_from_file_location("render_cancellation_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)
        if not shutil.which(cls.backend.FFMPEG_BIN) or not shutil.which(cls.backend.FFPROBE_BIN):
            raise unittest.SkipTest("FFmpeg and FFprobe are required for render cancellation tests")
        cls.output_dir = Path(cls.backend.OUTPUT_DIR)
        cls.source = "cancel-source.mp4"
        subprocess.run([
            cls.backend.FFMPEG_BIN, "-v", "error", "-y",
            "-f", "lavfi", "-i", "color=tomato:s=320x180:r=24:d=4",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
            "-c:v", "libx264", "-threads:v", "2", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-shortest", str(Path(cls.backend.UPLOAD_DIR) / cls.source),
        ], check=True, capture_output=True, timeout=25)

    async def asyncSetUp(self):
        self.backend.jobs.clear()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.backend.app), base_url="http://editor", headers=self.headers,
        )
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):
        for job_id, job in list(self.backend.jobs.items()):
            task = job.get("task")
            if task is None or task.done():
                continue
            if job["type"] in {"render", "snapshot"}:
                await self.cancel({"job_id": job_id, "cancel_token": job["cancel_token"]})
            else:
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self.client.aclose()

    async def start(self, fmt="mp4", *, duration=3):
        response = await self.client.post("/start-snapshot" if fmt == "png" else "/start-render", data={
            "file_id": self.source, "segments": json.dumps([{"start": 0, "end": duration}]),
            "hardware": "cpu", "width": 320, "height": 180, "fps": 24,
            "fmt": "mp4" if fmt == "png" else fmt, "timeline_time": .85, "canvas_height": 180, "canvas_width": 320,
            "texts": json.dumps([{"text": "Sabit başlık", "start": 0, "end": duration, "size": 28}]),
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def cancel(self, job, *, token=None):
        return await self.client.post("/cancel-render/" + job["job_id"], headers={
            "X-Render-Cancel-Token": job["cancel_token"] if token is None else token,
        })

    async def events(self, job, after=None):
        response = await asyncio.wait_for(self.client.get("/stream-events/" + job["job_id"], headers={
            **({"Last-Event-ID": str(after)} if after is not None else {}),
        }), 10)
        self.assertEqual(response.status_code, 200, response.text)
        return [(int(lines[0][4:]), json.loads(lines[1][6:]))
                for item in response.text.split("\n\n") if (lines := item.splitlines()) and lines[0].startswith("id: ")]

    def slow_first(self, output_basename, *, fail_gpu=False):
        real_spawn = self.backend.create_media_process
        started = asyncio.Future()
        attempts = []

        async def spawn(*args, **kwargs):
            if fail_gpu and "h264_nvenc" in args:
                stderr = asyncio.StreamReader()
                stderr.feed_data(b"[h264_nvenc] OpenEncodeSessionEx failed: no capable devices found\n")
                stderr.feed_eof()

                class UnavailableGPU:
                    returncode = 1
                    async def wait(self):
                        return self.returncode

                process = UnavailableGPU()
                process.stderr = stderr
                attempts.append((args[-1], process))
                return process
            first_match = Path(args[-1]).name == output_basename and not started.done()
            if first_match:
                input_index = args.index("-i")
                args = (*args[:input_index], "-readrate", "0.08", *args[input_index:])
            process = await real_spawn(*args, **kwargs)
            attempts.append((args[-1], process))
            if first_match:
                started.set_result((Path(args[-1]).parent, process))
            return process

        return started, attempts, patch.object(self.backend, "create_media_process", side_effect=spawn)

    async def assert_stopped(self, job, process, scratch, fmt):
        seen = await self.events(job)
        terminal = [(event_id, message) for event_id, message in seen
                    if message["type"] in {"result", "cancelled", "error"}]
        self.assertEqual([message["type"] for _, message in terminal], ["cancelled"], seen)
        self.assertEqual(await self.events(job, terminal[0][0] - 1), terminal)
        self.assertEqual(await self.events(job, terminal[0][0]), [])
        self.assertIsNotNone(process.returncode)
        self.assertFalse(scratch.exists(), "Filter scripts, overlays and incomplete outputs are removed")
        self.assertFalse((self.output_dir / f"out_{job['job_id']}.{fmt}").exists())
        response = await self.client.get(f"/download/{job['job_id']}/{fmt}")
        self.assertEqual(response.status_code, 404)
        self.assertEqual((await self.cancel(job)).json(), {"status": "cancelled"})

    async def assert_working_output(self, job, fmt):
        messages = [message for _, message in await self.events(job)]
        self.assertEqual(messages[-1]["type"], "result", messages)
        response = await self.client.get(messages[-1]["download_url"])
        self.assertEqual(response.status_code, 200)
        self.assertGreater(len(response.content), 100)
        self.assertEqual((await self.cancel(job)).json(), {"status": "finished"})
        self.assertEqual((await self.client.get(messages[-1]["download_url"])).content, response.content)

    async def test_stop_live_render_with_its_own_capability_while_a_second_job_finishes(self):
        started, attempts, intercept = self.slow_first("output.mp4")
        with intercept:
            stopped = await self.start()
            scratch, process = await asyncio.wait_for(started, 5)
            self.assertIsNone(process.returncode)
            self.assertTrue(any(scratch.glob("text_*.png")))
            self.assertTrue((scratch / "filter.txt").is_file())
            other = await self.start(duration=.5)
            self.assertEqual((await self.cancel(stopped, token=other["cancel_token"])).status_code, 404)
            self.assertEqual((await self.cancel(other, token=stopped["cancel_token"])).status_code, 404)
            untrusted = await self.client.post("/cancel-render/" + stopped["job_id"], headers={
                "X-Desktop-Token": "untrusted", "X-Render-Cancel-Token": stopped["cancel_token"],
            })
            self.assertEqual(untrusted.status_code, 403)
            nonrender = "analysis"
            self.backend.jobs[nonrender] = {"type": "analysis", "cancel_token": stopped["cancel_token"]}
            self.assertEqual((await self.cancel({**stopped, "job_id": nonrender})).status_code, 404)
            self.assertEqual((await self.cancel(stopped)).status_code, 202)
            await self.assert_stopped(stopped, process, scratch, "mp4")
            await self.assert_working_output(other, "mp4")
            self.assertEqual(len(attempts), 2, "Intentional termination must not take a CPU/memory retry branch")
        await self.assert_working_output(await self.start(duration=.5), "mp4")

    async def test_stop_final_gif_and_mp3_conversion_and_snapshot_encoder(self):
        for fmt in ("gif", "mp3", "png"):
            with self.subTest(format=fmt):
                started, attempts, intercept = self.slow_first(f"output.{fmt}")
                with intercept:
                    job = await self.start(fmt)
                    scratch, process = await asyncio.wait_for(started, 5)
                    self.assertIsNone(process.returncode)
                    if fmt != "png":
                        self.assertTrue((scratch / "intermediate.mp4").is_file())
                    self.assertEqual((await self.cancel(job)).status_code, 202)
                    await self.assert_stopped(job, process, scratch, fmt)
                self.assertEqual(len(attempts), 1 if fmt == "png" else 2)
                await self.assert_working_output(await self.start(fmt, duration=1), fmt)


    async def test_cancel_during_real_cpu_fallback_after_gpu_failure(self):
        started, attempts, intercept = self.slow_first("output.mp4", fail_gpu=True)
        choice = EncoderChoice("h264_nvenc", nvenc_h264_args(), True)
        with (intercept, patch.object(self.backend, "select_video_encoder", return_value=choice),
              patch.object(self.backend, "invalidate_nvenc")):
            job = await self.start()
            scratch, process = await asyncio.wait_for(started, 5)
            self.assertEqual(len(attempts), 2)
            self.assertIsNone(process.returncode)
            self.assertEqual((await self.cancel(job)).status_code, 202)
            await self.assert_stopped(job, process, scratch, "mp4")
            self.assertEqual(len(attempts), 2, "A deliberate stop cannot start a third attempt")
        await self.assert_working_output(await self.start(duration=.5), "mp4")

    async def test_cancel_during_overlay_preparation_waits_for_cleanup_without_launching_ffmpeg(self):
        ready = threading.Event()
        release = threading.Event()
        scratch = []
        real_overlay = self.backend.create_text_overlay

        def prepare(path, *args):
            result = real_overlay(path, *args)
            scratch.append(Path(path).parent)
            ready.set()
            release.wait(5)
            return result

        with (patch.object(self.backend, "create_text_overlay", side_effect=prepare),
              patch.object(self.backend, "create_media_process") as spawn):
            job = await self.start()
            try:
                self.assertTrue(await asyncio.to_thread(ready.wait, 4))
                self.assertEqual((await self.cancel(job)).status_code, 202)
                self.assertTrue(scratch[0].exists())
            finally:
                release.set()
            messages = [message["type"] for _, message in await self.events(job)]
            self.assertEqual(messages[-1], "cancelled")
            self.assertFalse(scratch[0].exists())
            spawn.assert_not_called()
