"""Verify playback variants without touching original media or running a desktop app."""
import asyncio
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import preview_media

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from test_update import load_source_backend


class PreviewMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory(prefix="studio-preview-")
        cls.addClassCleanup(directory.cleanup)
        cls.backend = load_source_backend(directory.name)
        cls.cache = cls.backend.preview_cache
        if not all(shutil.which(tool) for tool in (cls.backend.FFMPEG_BIN, cls.backend.FFPROBE_BIN)):
            raise unittest.SkipTest("FFmpeg and FFprobe are required")
        cls.uploads = Path(cls.backend.UPLOAD_DIR)
        cls.generate("prores.mov", "prores_ks", audio=True)
        cls.generate("lossless.mkv", "ffv1", audio=True)
        cls.generate("small.mp4", "libx264")
        cls.generate("large.mp4", "libx264", size="1280x720")
        cls.generate("portrait-source.mov", "prores_ks", size="640x360")
        cls.ffmpeg("-display_rotation:v:0", "90", "-i", str(cls.uploads / "portrait-source.mov"),
                   "-c", "copy", str(cls.uploads / "portrait.mov"))

        cover = cls.uploads / "cover.jpg"
        Image.new("RGB", (80, 80), "blue").save(cover)
        cls.ffmpeg(
            "-i", str(cover), "-i", str(cls.uploads / "small.mp4"),
            "-f", "lavfi", "-i", "sine=f=441:r=48000:d=1,volume=0.01",
            "-f", "lavfi", "-i", "sine=f=882:r=48000:d=1",
            "-map", "0:v", "-map", "1:v", "-map", "2:a", "-map", "3:a",
            "-c:v", "copy", "-c:a", "aac", "-disposition:v:0", "attached_pic",
            "-disposition:a:0", "0", "-disposition:a:1", "default", str(cls.uploads / "annotated.mp4"),
        )

    @classmethod
    def ffmpeg(cls, *options):
        return subprocess.run(
            [cls.backend.FFMPEG_BIN, "-v", "error", "-nostdin", "-y", *options],
            capture_output=True, check=True, timeout=30,
        ).stdout

    @classmethod
    def generate(cls, name, codec, *, audio=False, size="320x192"):
        inputs = ["-f", "lavfi", "-i", f"color=red:s={size}:r=30:d=1"]
        if audio:
            inputs.extend(["-f", "lavfi", "-i", "sine=f=440:r=48000:d=1", "-c:a", "aac"])
        cls.ffmpeg(*inputs, "-c:v", codec, "-threads", "2", str(cls.uploads / name))

    def probe(self, media):
        return json.loads(subprocess.check_output([
            self.backend.FFPROBE_BIN, "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,width,height,sample_aspect_ratio:stream_side_data=rotation",
            "-of", "json", str(media),
        ], timeout=20))["streams"]

    def test_single_flight_preserves_original_and_serves_ranges(self):
        original = (self.uploads / "prores.mov").read_bytes()

        async def exercise():
            with patch.object(self.cache, "_encode", wraps=self.cache._encode) as encoder:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=self.backend.app), base_url="http://editor"
                ) as client:
                    responses = await asyncio.gather(*[
                        client.get("/preview/prores.mov", headers={"Range": "bytes=0-39"}) for _ in range(3)
                    ])
                    self.assertEqual(encoder.call_count, 1)
                    for response in responses:
                        self.assertEqual(response.status_code, 206)
                        self.assertEqual(response.headers["x-studio-preview"], "compatible")
                        self.assertTrue(response.headers["content-range"].startswith("bytes 0-39/"))
                    self.assertNotEqual(responses[0].content, original[:40])
                    self.assertEqual((await client.get("/video/prores.mov")).content, original)
                    self.assertEqual((await client.get("/preview/prores.mov")).status_code, 200)
                    self.assertEqual(encoder.call_count, 1)
        asyncio.run(exercise())
        self.assertEqual((self.uploads / "prores.mov").read_bytes(), original)

    def test_native_light_portrait_and_silent_variants(self):
        with TestClient(self.backend.app) as client:
            original = client.get("/preview/small.mp4?mode=light")
            self.assertEqual(original.headers["X-Studio-Preview"], "original")
            self.assertEqual(original.content, (self.uploads / "small.mp4").read_bytes())
            light = client.get("/preview/large.mp4?mode=light")
            self.assertEqual(light.headers["X-Studio-Preview"], "light")
            portrait = client.get("/preview/portrait.mov")
            self.assertEqual(portrait.headers["X-Studio-Preview"], "compatible")
            lossless = client.get("/preview/lossless.mkv")
            self.assertEqual(lossless.headers["X-Studio-Preview"], "compatible")
        for name, response, dimensions, codecs in (
            ("light", light, (960, 540), ["h264"]),
            ("portrait", portrait, (360, 640), ["h264"]),
            ("lossless", lossless, (320, 192), ["h264", "aac"]),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "output.mp4"
                output.write_bytes(response.content)
                streams = self.probe(output)
                self.assertEqual((streams[0]["width"], streams[0]["height"]), dimensions)
                self.assertEqual([item["codec_name"] for item in streams], codecs)
                self.assertFalse(streams[0].get("side_data_list"))

    def test_native_metadata_does_not_wait_for_a_long_encoder(self):
        self.generate("slow-prores.mov", "prores_ks")
        self.generate("direct-h264.mp4", "libx264")
        original = self.cache._encode

        async def exercise():
            began, proceed = asyncio.Event(), asyncio.Event()

            async def delayed(*args):
                began.set()
                await proceed.wait()
                return await original(*args)

            with patch.object(self.cache, "_encode", delayed):
                pending = asyncio.create_task(self.cache.resolve(self.uploads / "slow-prores.mov", "normal"))
                try:
                    await asyncio.wait_for(began.wait(), timeout=3)
                    original_path, mode = await asyncio.wait_for(
                        self.cache.resolve(self.uploads / "direct-h264.mp4", "light"), timeout=3,
                    )
                    self.assertEqual(original_path.name, "direct-h264.mp4")
                    self.assertEqual(mode, "original")
                    self.assertFalse(pending.done())
                finally:
                    proceed.set()
                    await pending

        asyncio.run(exercise())

    def test_abandoned_preview_work_releases_lifecycle_slot(self):
        self.generate("abandoned.mov", "prores_ks")

        async def exercise():
            began, cancelled = asyncio.Event(), asyncio.Event()

            async def delayed(*args):
                began.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

            with patch.object(self.cache, "_encode", delayed), patch.object(preview_media, "IDLE_GRACE_SECONDS", .01):
                pending = asyncio.create_task(self.cache.resolve(self.uploads / "abandoned.mov", "normal"))
                await asyncio.wait_for(began.wait(), timeout=3)
                self.assertEqual(self.backend.desktop_update_state.active_requests, 1)
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await asyncio.wait_for(cancelled.wait(), timeout=3)
                await asyncio.sleep(0)
                self.assertEqual(self.backend.desktop_update_state.active_requests, 0)

        asyncio.run(exercise())

    def test_proxy_render_snapshot_and_waveform_share_default_streams(self):
        filename = "annotated.mp4"
        source = self.uploads / filename
        video, audio = self.backend.source_playback_streams(source)
        self.assertEqual((video["width"], video["height"]), (320, 192))
        self.assertEqual(audio["disposition"]["default"], 1)
        form = {"file_id": filename, "segments": json.dumps([{"start": 0, "end": .9, "fileId": filename}]),
                "hardware": "cpu", "timeline_time": ".4"}
        with TestClient(self.backend.app) as client:
            proxy = client.get(f"/preview/{filename}")
            self.assertEqual(proxy.headers["x-studio-preview"], "compatible")
            def export(endpoint):
                response = client.post(endpoint, data=form)
                self.assertEqual(response.status_code, 200, response.text)
                event_stream = client.get("/stream-events/" + response.json()["job_id"])
                last = [json.loads(line[6:]) for line in event_stream.text.splitlines() if line.startswith("data: ")][-1]
                self.assertEqual(last["type"], "result", last)
                return client.get(last["download_url"]).content

            rendered = export("/start-render")
            snapshot = Image.open(io.BytesIO(export("/start-snapshot"))).convert("RGB")
            self.assertGreater(snapshot.getpixel((100, 100))[0], 200)
            wave = client.get(f"/waveform/{filename}?start=0&end=0.9&width=320&height=44")
            self.assertEqual(wave.headers["content-type"], "image/png")

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name, content in [("preview", proxy.content), ("rendered", rendered)]:
                file = directory / (name + ".mp4")
                file.write_bytes(content)
                streams = self.probe(file)
                self.assertEqual((streams[0]["width"], streams[0]["height"]), (320, 192))
                pcm = self.ffmpeg("-ss", "0.2", "-i", str(file), "-t", "0.5", "-vn",
                                  "-ac", "1", "-ar", "48000", "-f", "s16le", "-")
                samples = [value for (value,) in struct.iter_unpack("<h", pcm)]
                positive_crossings = sum(left < 0 <= right for left, right in zip(samples, samples[1:]))
                self.assertAlmostEqual(positive_crossings * 2, 882, delta=20, msg=name)
                frame = self.ffmpeg("-i", str(file), "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-")
                self.assertGreater(Image.open(io.BytesIO(frame)).convert("RGB").getpixel((100, 100))[0], 200)
            for audio_type, index in [("default", audio["index"]), ("commentary", audio["index"] - 1)]:
                expected = directory / (audio_type + ".png")
                self.ffmpeg(
                    "-ss", "0.000", "-t", "0.900", "-i", str(source), "-filter_complex",
                    f"[0:{index}]aformat=channel_layouts=mono,showwavespic=s=320x44:colors=0x4ade80:draw=full",
                    "-frames:v", "1", str(expected),
                )
                if audio_type == "default":
                    self.assertEqual(wave.content, expected.read_bytes())
                else:
                    self.assertNotEqual(wave.content, expected.read_bytes())

    def test_failure_leaves_no_partial_variant_and_can_retry(self):
        self.generate("retry.mov", "prores_ks")
        original_spawn = self.cache.spawn

        class FailedProcess:
            returncode = 1
            async def communicate(self):
                return None, None

        async def failing_spawn(*args, **kwargs):
            if args[0] == self.backend.FFMPEG_BIN:
                return FailedProcess()
            return await original_spawn(*args, **kwargs)

        with TestClient(self.backend.app) as client:
            with patch.object(self.cache, "spawn", failing_spawn):
                self.assertEqual(client.get("/preview/retry.mov").status_code, 422)
                self.assertFalse(list(self.cache.directory.glob(".pending-*.mp4")))
            self.assertEqual(client.get("/preview/retry.mov").status_code, 200)
