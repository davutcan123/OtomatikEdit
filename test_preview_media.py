"""Verify playback variants without touching original media or running a desktop app."""
import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

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

    @classmethod
    def ffmpeg(cls, *options):
        subprocess.run(
            [cls.backend.FFMPEG_BIN, "-v", "error", "-nostdin", "-y", *options],
            capture_output=True, check=True, timeout=30,
        )

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
