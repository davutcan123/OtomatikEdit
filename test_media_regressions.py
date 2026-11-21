"""Export and upload regressions exercised through the editor's HTTP routes."""
from array import array
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import quote
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image


class MediaRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "media-test",
            "SMART_EDITOR_DATA_DIR": temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
            "SMART_EDITOR_LOW_MEMORY_RENDER": "1",
        }):
            spec = importlib.util.spec_from_file_location("media_test_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)
        if not all(shutil.which(tool) for tool in (cls.backend.FFMPEG_BIN, cls.backend.FFPROBE_BIN)):
            raise unittest.SkipTest("FFmpeg and FFprobe are needed for media integration tests")
        cls.uploads = Path(cls.backend.UPLOAD_DIR)
        cls.outputs = Path(cls.backend.OUTPUT_DIR)
        cls.headers = {"X-Desktop-Token": "media-test"}
        cls.ffmpeg(
            "-f", "lavfi", "-i",
            "color=red:s=160x96:r=30:d=4,drawbox=x=0:y=0:w=iw:h=ih:c=blue:t=fill:enable='gte(t,2.3)'",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.uploads / "changing.mp4"),
        )
        for name, video_duration, audio_duration, frequency in (
            ("short-audio", 3, 1, 440), ("full-audio", 2, 2, 880),
        ):
            cls.ffmpeg(
                "-f", "lavfi", "-i", f"color=black:s=160x96:r=30:d={video_duration}",
                "-f", "lavfi", "-i", f"sine=f={frequency}:r=48000:d={audio_duration}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(cls.uploads / f"{name}.mp4"),
            )
        cls.ffmpeg("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1", str(cls.uploads / "silence.wav"))
        first, second = Image.new("RGB", (48, 48), "yellow"), Image.new("RGB", (48, 48), "lime")
        first.save(cls.uploads / "animated.gif", save_all=True, append_images=[second], duration=[300, 300], loop=0)
        first.save(cls.uploads / "static.gif")
        first.save(cls.uploads / "still.png")

    @classmethod
    def ffmpeg(cls, *args):
        return subprocess.run(
            [cls.backend.FFMPEG_BIN, "-nostdin", "-loglevel", "error", "-y", *args],
            capture_output=True, check=True, timeout=30,
        ).stdout

    def setUp(self):
        self.client = self.enterContext(TestClient(self.backend.app, headers=self.headers))

    def events(self, route, payload):
        start = self.client.post(route, data=payload)
        self.assertEqual(start.status_code, 200, start.text)
        job_id = start.json()["job_id"]
        response = self.client.get(f"/stream-events/{job_id}")
        return job_id, [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]

    def export(self, clips, *, snapshot_time=None, fps=30, multitrack=False, **layers):
        snapshot = snapshot_time is not None
        payload = {
            "file_id": clips[0]["fileId"], "segments": json.dumps(clips), "width": 160, "height": 96,
            "canvas_width": 1800, "canvas_height": 1080, "fps": fps, "quality": "draft", "hardware": "cpu",
            "fmt": "mp4", "timeline_composite": str(multitrack).lower(),
            **{name: json.dumps(items) for name, items in layers.items()},
        }
        if snapshot:
            payload["timeline_time"] = snapshot_time
        job_id, events = self.events("/start-snapshot" if snapshot else "/start-render", payload)
        self.assertFalse([item for item in events if item["type"] == "error"], events)
        self.assertTrue(any(item["type"] == "result" for item in events), events)
        return self.outputs / f"out_{job_id}.{'png' if snapshot else 'mp4'}"

    def frame(self, output, time=None):
        if time is None:
            return Image.open(output).convert("RGB")
        data = self.ffmpeg("-ss", str(time), "-i", str(output), "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-")
        return Image.open(io.BytesIO(data)).convert("RGB")

    def assert_video_stream(self, output, frames, duration):
        result = subprocess.run(
            [self.backend.FFPROBE_BIN, "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=nb_frames,duration", "-of", "json", str(output)],
            capture_output=True, check=True, timeout=10,
        )
        stream, = json.loads(result.stdout)["streams"]
        self.assertEqual(int(stream["nb_frames"]), frames)
        self.assertAlmostEqual(float(stream["duration"]), duration, delta=.001)

    def test_zoom_preserves_speed_frame_count_and_source_samples_in_both_renderers(self):
        frames = [{"time": 0, "scale": 100}, {"time": 1.75, "scale": 145}]
        for multitrack in (False, True):
            for speed, fps in ((2, 30), (1, 24)):
                for effect in ({}, {"animation": "zoom"}, {"zoomKeyframes": frames},
                               {"animation": "zoom", "zoomKeyframes": frames}):
                    with self.subTest(multitrack=multitrack, speed=speed, fps=fps, effect=effect):
                        clip = {"fileId": "changing.mp4", "start": 0, "end": 4, "speed": speed,
                                "videoTrack": 2 if multitrack else 1, **effect}
                        output = self.export([clip], fps=fps, multitrack=multitrack)
                        self.assert_video_stream(output, round(4 * fps / speed), 4 / speed)
                        for elapsed, channel in ((1 / speed, 0), (3 / speed, 2)):
                            pixel = self.frame(output, elapsed).getpixel((80, 48))
                            self.assertGreater(pixel[channel], 210, pixel)
                        snapshot = self.export([clip], snapshot_time=3 / speed, fps=fps, multitrack=multitrack)
                        pixel = self.frame(snapshot).getpixel((80, 48))
                        self.assertGreater(pixel[2], 210, pixel)

    def audio_samples(self, output):
        pcm = array("h")
        pcm.frombytes(self.ffmpeg("-i", str(output), "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"))
        if sys.byteorder != "little":
            pcm.byteswap()
        return pcm

    @staticmethod
    def rms(pcm, time):
        start = round(time * 48000)
        window = pcm[start:start + 2400]
        return math.sqrt(sum(sample * sample for sample in window) / len(window))

    def test_short_audio_does_not_advance_the_next_clip(self):
        for multitrack in (False, True):
            for speed, gap in ((1, 0), (2, .5)):
                with self.subTest(multitrack=multitrack, speed=speed, gap=gap):
                    boundary = 3 / speed + gap
                    clips = [
                        {"fileId": "short-audio.mp4", "start": 0, "end": 3, "speed": speed,
                         "videoTrack": 2 if multitrack else 1},
                        {"fileId": "full-audio.mp4", "start": 0, "end": 2, "timelineStart": boundary,
                         "videoTrack": 2 if multitrack else 1},
                    ]
                    output = self.export(clips, multitrack=multitrack)
                    pcm = self.audio_samples(output)
                    self.assertGreater(self.rms(pcm, .25), 1000)
                    self.assertLess(self.rms(pcm, 1 / speed + .2), 10)
                    self.assertLess(self.rms(pcm, boundary - .25), 10)
                    self.assertGreater(self.rms(pcm, boundary + .2), 1000)
                    self.assert_video_stream(output, round((boundary + 2) * 30), boundary + 2)

    def test_short_audio_stays_aligned_with_crossfade_and_incoming_handle(self):
        for multitrack in (False, True):
            with self.subTest(multitrack=multitrack):
                track = 2 if multitrack else 1
                clips = [
                    {"fileId": "short-audio.mp4", "start": 0, "end": 3, "videoTrack": track},
                    {"fileId": "full-audio.mp4", "start": .5, "end": 2, "timelineStart": 3, "videoTrack": track},
                ]
                output = self.export(clips, multitrack=multitrack, transitions=[
                    {"boundary": 0, "duration": .5, "type": "fade"},
                ])
                pcm = self.audio_samples(output)
                self.assertGreater(self.rms(pcm, .25), 1000)
                self.assertLess(self.rms(pcm, 2.4), 10)
                self.assertGreater(self.rms(pcm, 2.75), 400)
                self.assertGreater(self.rms(pcm, 3.25), 1000)

    def test_gif_layers_use_local_playback_time_and_keep_brush_and_static_support(self):
        clip = {"fileId": "changing.mp4", "start": 0, "end": 2.2}
        for name, brush in (("animated.gif", False), ("animated.gif", True), ("static.gif", False)):
            with self.subTest(name=name, brush=brush):
                item = {"fileId": name, "start": 1, "end": 2.2, "x": 50, "y": 50, "scale": 50}
                if brush:
                    item.update(backgroundMode="brush", brushStrokes=[{
                        "size": 30, "points": [{"x": .5, "y": .5}],
                    }])
                output = self.export([clip], images=[item])
                for time, is_yellow in ((1.1, True), (1.4, name == "static.gif"), (1.75, True)):
                    frame = self.frame(output, time)
                    red, green, blue = frame.getpixel((80, 48))
                    self.assertGreater(green, 215, (time, red, green, blue))
                    self.assertLess(blue, 35)
                    self.assertEqual(red > 180, is_yellow, (time, red, green, blue))
                    if brush:
                        self.assertLess(frame.getpixel((55, 48))[1], 25)
                snapshot = self.export([clip], snapshot_time=1.4, images=[item])
                pixel = self.frame(snapshot).getpixel((80, 48))
                self.assertGreater(pixel[1], 215, pixel)
                self.assertEqual(pixel[0] > 180, name == "static.gif", pixel)

    def test_text_scale_and_opacity_match_snapshot_at_delayed_layer_time(self):
        clip = {"fileId": "full-audio.mp4", "start": 0, "end": 2}
        item = {"text": "TEST", "start": .8, "end": 2, "size": 220, "x": 50, "y": 50,
                "color": "#ffffff", "outlineWidth": 0, "shadow": False,
                "transformKeyframes": [
                    {"time": 0, "scale": 50, "opacity": 0, "x": 50, "y": 50},
                    {"time": .8, "scale": 150, "opacity": 100, "x": 50, "y": 50, "easing": "linear"},
                ]}
        output = self.export([clip], texts=[item])
        for time in (1.1, 1.6):
            snapshot = self.export([clip], snapshot_time=time, texts=[item])
            video_pixels = self.frame(output, time).getchannel("G")
            snapshot_pixels = self.frame(snapshot).getchannel("G")
            self.assertAlmostEqual(video_pixels.getextrema()[1], snapshot_pixels.getextrema()[1], delta=16)
            video_area = sum(video_pixels.histogram()[25:])
            snapshot_area = sum(snapshot_pixels.histogram()[25:])
            self.assertGreater(snapshot_area, 10)
            self.assertAlmostEqual(video_area, snapshot_area, delta=max(10, snapshot_area * .12))

    def test_upload_quotes_paths_and_discards_unreadable_or_wrong_stream_files(self):
        for source, filename, content_type, expected_kind in (
            ("changing.mp4", "Örnek #1?.mp4", "video/mp4", "video"),
            ("silence.wav", "audio.wav", "audio/wav", "audio"),
            ("animated.gif", "animated.gif", "image/gif", "image"),
            ("still.png", "still.png", "image/png", "image"),
        ):
            with self.subTest(filename=filename):
                data = (self.uploads / source).read_bytes()
                response = self.client.post("/upload", files={"file": (filename, data, content_type)})
                self.assertEqual(response.status_code, 200, response.text)
                result = response.json()
                self.assertEqual(result["name"], filename)
                self.assertEqual(result["media_kind"], expected_kind)
                self.assertEqual(result["url"], "/video/" + quote(result["file_id"], safe=""))
                self.assertEqual(self.client.get(result["url"]).content, data)
                if expected_kind != "image":
                    self.assertGreater(result["duration"], 0)
        before = set(self.uploads.iterdir())
        for filename, data, content_type in (
            ("broken.mp4", b"bad media", "video/mp4"), ("broken.png", b"bad media", "image/png"),
            ("audio-as-video.mp4", (self.uploads / "silence.wav").read_bytes(), "video/mp4"),
            ("video-as-audio.wav", (self.uploads / "changing.mp4").read_bytes(), "audio/wav"),
        ):
            with self.subTest(filename=filename):
                response = self.client.post("/upload", files={"file": (filename, data, content_type)})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(set(self.uploads.iterdir()), before)

    def test_analysis_checks_silencedetect_errors_and_accepts_video_without_audio(self):
        _, events = self.events("/start-analysis", {"file_id": "silence.wav", "duration": .2})
        result = next(item["data"] for item in events if item["type"] == "result")
        self.assertEqual(len(result["silences"]), 1)
        self.assertAlmostEqual(result["silences"][0]["end"], 1, delta=.01)
        _, events = self.events("/start-analysis", {"file_id": "silence.wav", "duration": -1})
        self.assertTrue(any(item["type"] == "error" and "Sessizlik tespiti başarısız" in item["message"]
                            for item in events), events)
        self.assertFalse(any(item["type"] == "result" for item in events), events)
        _, events = self.events("/start-analysis", {"file_id": "changing.mp4", "keywords": "test"})
        result = next(item["data"] for item in events if item["type"] == "result")
        self.assertEqual(result["silences"], [])
        self.assertEqual(result["valid_segments"], [{"start": 0.0, "end": 4.0}])


if __name__ == "__main__":
    unittest.main()
