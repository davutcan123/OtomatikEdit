"""Real FFmpeg regression: stickers remain visible for their complete timeline range."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient


class StickerTimingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "sticker-timing-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
            "SMART_EDITOR_LOW_MEMORY_RENDER": "1",
        }):
            spec = importlib.util.spec_from_file_location("sticker_timing_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)
        if not shutil.which(cls.backend.FFMPEG_BIN):
            raise unittest.SkipTest("FFmpeg is required for sticker timing integration tests")
        cls.headers = {"X-Desktop-Token": "sticker-timing-test"}
        cls.file_id = "black-source.mp4"
        subprocess.run([
            cls.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
            "-i", "color=black:s=160x90:r=24:d=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y",
            str(Path(cls.backend.UPLOAD_DIR) / cls.file_id),
        ], check=True, timeout=20)

    def render(self, clips, sticker, transitions=None):
        with TestClient(self.backend.app) as client:
            response = client.post("/start-render", headers=self.headers, data={
                "file_id": self.file_id, "segments": json.dumps(clips),
                "stickers": json.dumps([{"preset": "star", "x": 50, "y": 50, "scale": 30, **sticker}]),
                "transitions": json.dumps(transitions or []), "width": "160", "height": "90",
                "fps": "24", "fmt": "mp4", "quality": "draft",
            })
            self.assertEqual(response.status_code, 200, response.text)
            job_id = response.json()["job_id"]
            events = client.get("/stream-events/" + job_id, headers=self.headers)
            messages = [json.loads(line[6:]) for line in events.text.splitlines() if line.startswith("data: ")]
            self.assertFalse([item for item in messages if item.get("type") == "error"], messages)
            self.assertTrue(any(item.get("download_url") == f"/download/{job_id}/mp4" for item in messages))
        output = Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.mp4"
        # Decode every output frame, not a few thumbnails; a transient loss in
        # the middle of a sticker's duration must also fail the regression.
        decoded = subprocess.run([
            self.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-i", str(output),
            "-an", "-vf", "crop=8:8:76:40", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20).stdout
        frame_size = 8 * 8 * 3
        self.assertEqual(len(decoded) % frame_size, 0)
        visible = [sum(decoded[index:index + frame_size]) / frame_size > 80
                   for index in range(0, len(decoded), frame_size)]
        return visible, self.backend.jobs[job_id]

    def assert_visible_range(self, visible, start, end, total):
        self.assertEqual(len(visible), round(total * 24))
        for frame, actual in enumerate(visible):
            time = frame / 24
            # FFmpeg overlay's end boundary is inclusive. Leave one-frame
            # tolerance only at endpoints, never during the active interval.
            if start <= time < end:
                self.assertTrue(actual, f"Sticker vanished at {time:.3f}s; expected {start}–{end}s")
            elif time < start - 1 / 24 or time > end + 1 / 24:
                self.assertFalse(actual, f"Sticker leaked outside its range at {time:.3f}s")

    def test_long_sticker_does_not_disappear_after_two_seconds(self):
        visible, job = self.render([{"fileId": self.file_id, "start": 0, "end": 10}], {"start": 0, "end": 9})
        self.assertEqual(job["stickers"][0]["end"], 9)
        self.assert_visible_range(visible, 0, 9, 10)

    def test_nonzero_start_on_source_trim_keeps_extended_and_shortened_duration(self):
        clip = {"fileId": self.file_id, "start": 6, "end": 16, "timelineStart": 0}
        for end in (8.5, 6.25):
            with self.subTest(end=end):
                visible, job = self.render([clip], {"start": 2.25, "end": end})
                self.assertEqual((job["stickers"][0]["start"], job["stickers"][0]["end"]), (2.25, end))
                self.assert_visible_range(visible, 2.25, end, 10)

    def test_sticker_remains_continuous_across_cut_and_transition(self):
        clips = [{"fileId": self.file_id, "start": 3, "end": 8, "timelineStart": 0},
                 {"fileId": self.file_id, "start": 10, "end": 15, "timelineStart": 5}]
        for transitions in ([], [{"boundary": 0, "type": "fade", "duration": 1}]):
            with self.subTest(transitions=bool(transitions)):
                visible, job = self.render(clips, {"start": 1.25, "end": 8.75}, transitions)
                overlap = sum(item["duration"] for item in job["transitions"])
                self.assert_visible_range(visible, 1.25, 8.75 - overlap, 10 - overlap)


if __name__ == "__main__":
    unittest.main()
