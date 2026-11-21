"""Exercise selected timeline output through the real FFmpeg renderer."""
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from test_update import load_source_backend


class StudioRangeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory(prefix="studio-range-")
        cls.addClassCleanup(temporary.cleanup)
        cls.backend = load_source_backend(temporary.name)
        if not all(shutil.which(tool) for tool in (cls.backend.FFMPEG_BIN, cls.backend.FFPROBE_BIN)):
            raise unittest.SkipTest("FFmpeg and FFprobe are required")
        for color, frequency in (("red", 440), ("blue", 880)):
            cls.ffmpeg(
                "-f", "lavfi", "-i", f"color={color}:s=320x180:r=30:d=2",
                "-f", "lavfi", "-i", f"sine=f={frequency}:r=48000:d=2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                str(Path(cls.backend.UPLOAD_DIR) / f"{color}.mp4"),
            )

    @classmethod
    def ffmpeg(cls, *args):
        return subprocess.run(
            [cls.backend.FFMPEG_BIN, "-nostdin", "-v", "error", "-y", *args],
            capture_output=True, check=True, timeout=30,
        ).stdout

    def options(self, **options):
        clips = [{"fileId": f"{color}.mp4", "start": 0, "end": 2, "timelineStart": index * 2}
                 for index, color in enumerate(("red", "blue"))]
        return {"segments": json.dumps(clips), "fmt": "mp4", "hardware": "cpu",
                "width": "320", "height": "180", "fps": "30", **options}

    def start(self, client, **options):
        response = client.post("/start-render", data=self.options(**options))
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()["job_id"]
        events = client.get(f"/stream-events/{job_id}")
        self.assertEqual(events.status_code, 200)
        messages = [json.loads(line[6:]) for line in events.text.splitlines() if line.startswith("data: ")]
        self.assertEqual(messages[-1]["type"], "result", messages)
        self.assertEqual([item["percent"] for item in messages if item["type"] == "progress"][-1], 100)
        return Path(self.backend.OUTPUT_DIR) / f'out_{job_id}.{options.get("fmt", "mp4")}'

    def duration(self, file):
        return float(subprocess.check_output(
            [self.backend.FFPROBE_BIN, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(file)], timeout=20, text=True,
        ).strip())

    def frame(self, file, time):
        png = self.ffmpeg("-ss", str(time), "-i", str(file), "-frames:v", "1",
                          "-f", "image2pipe", "-c:v", "png", "-")
        return Image.open(io.BytesIO(png)).convert("RGB")

    def test_range_keeps_single_channel_transition_and_rebases_audio_video(self):
        transitions = json.dumps([{"boundary": 0, "type": "fade", "duration": .5}])
        text = json.dumps([{"start": 1.50, "end": 1.87, "text": "RANGE", "size": 85, "x": 50, "y": 50}])
        with TestClient(self.backend.app) as client:
            full = self.start(client, transitions=transitions, texts=text)
            part = self.start(client, transitions=transitions, texts=text, range_in="1.5", range_out="3")
        self.assertAlmostEqual(self.duration(full), 3.5, delta=.05)
        self.assertAlmostEqual(self.duration(part), 1.0, delta=.05)
        for time in (.10, .27, .75):
            original, cut = self.frame(full, 1.5 + time), self.frame(part, time)
            for point in ((10, 10), (100, 90), (150, 85), (310, 150)):
                self.assertLessEqual(max(abs(a - b) for a, b in zip(original.getpixel(point), cut.getpixel(point))), 24)
        early = self.frame(part, .10).crop((110, 60, 210, 120))
        late = self.frame(part, .75).crop((110, 60, 210, 120))
        self.assertGreater(sum(min(rgb) > 180 for rgb in early.getdata()), 10)
        self.assertEqual(sum(min(rgb) > 180 for rgb in late.getdata()), 0)
        pcm = self.ffmpeg("-ss", "0.7", "-i", str(part), "-t", "0.2", "-vn", "-ac", "1",
                          "-ar", "48000", "-f", "s16le", "-")
        samples = [item[0] for item in struct.iter_unpack("<h", pcm)]
        crossings = sum(left < 0 <= right for left, right in zip(samples, samples[1:]))
        self.assertAlmostEqual(crossings / .2, 880, delta=25)

    def test_range_includes_bounded_gif_and_mp3_outputs(self):
        with TestClient(self.backend.app) as client:
            for fmt in ("gif", "mp3"):
                with self.subTest(fmt=fmt):
                    output = self.start(client, fmt=fmt, range_in="2.5", range_out="3.5")
                    self.assertAlmostEqual(self.duration(output), 1.0, delta=.11)
                    if fmt == "gif":
                        self.assertGreater(self.frame(output, .3).getpixel((8, 8))[2], 200)

    def test_range_rejects_non_finite_reversed_and_out_of_bounds_points(self):
        with TestClient(self.backend.app) as client:
            for points in ({"range_in": "NaN", "range_out": "2"},
                           {"range_in": "2", "range_out": "1"},
                           {"range_in": "1"},
                           {"range_in": "-1", "range_out": "1"},
                           {"range_in": "3", "range_out": "9"},
                           {"range_in": "1", "range_out": "1.01"}):
                with self.subTest(points=points):
                    response = client.post("/start-render", data=self.options(**points))
                    self.assertEqual(response.status_code, 400, response.text)
