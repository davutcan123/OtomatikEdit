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
import wave
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
        # Encode each original input frame number as eight binary blocks so
        # snapshot/export comparisons can identify the picture after compression.
        encoded_frames = ("color=black:s=160x96:r=25:d=4,"
                          "geq=lum='16+200*mod(floor(N/pow(2,floor(X*8/W))),2)':cb=128:cr=128")
        for mode in ("cfr", "vfr"):
            options = ["-vf", "select='not(eq(mod(n,5),3))'", "-fps_mode", "vfr"] if mode == "vfr" else []
            cls.ffmpeg("-f", "lavfi", "-i", encoded_frames, *options, "-c:v", "libx264", "-pix_fmt", "yuv420p",
                       str(cls.uploads / f"coded-{mode}.mp4"))
        cls.ffmpeg("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1", str(cls.uploads / "silence.wav"))
        first, second = Image.new("RGB", (48, 48), "yellow"), Image.new("RGB", (48, 48), "lime")
        first.save(cls.uploads / "animated.gif", save_all=True, append_images=[second], duration=[300, 300], loop=0)
        first.save(cls.uploads / "static.gif")
        first.save(cls.uploads / "fractional.gif", save_all=True, append_images=[second], duration=[80, 60], loop=0)
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

    def export(self, clips, *, snapshot_time=None, fps=30, multitrack=False, timeline_range=None, **layers):
        snapshot = snapshot_time is not None
        payload = {
            "file_id": clips[0]["fileId"], "segments": json.dumps(clips), "width": 160, "height": 96,
            "canvas_width": 1800, "canvas_height": 1080, "fps": fps, "quality": "draft", "hardware": "cpu",
            "fmt": "mp4", "timeline_composite": str(multitrack).lower(),
            **{name: json.dumps(items) for name, items in layers.items()},
        }
        if snapshot:
            payload["timeline_time"] = snapshot_time
        if timeline_range is not None:
            payload["range_in"], payload["range_out"] = timeline_range
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

    def frame_codes(self, path):
        raw = self.ffmpeg("-i", str(path), "-vf", "crop=160:2:0:48", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
        frame_size = 160 * 2 * 3
        return [
            sum(1 << bit for bit in range(8) if raw[offset + (bit * 20 + 10) * 3] > 100)
            for offset in range(0, len(raw), frame_size)
        ]

    def test_cfr_and_vfr_use_the_same_source_ticks_in_bounded_snapshots(self):
        for mode in ("cfr", "vfr"):
            for speed, reverse, animation in ((1, False, "none"), (1.3, False, "none"),
                                              (1.3, True, "none"), (1.3, False, "zoom")):
                with self.subTest(mode=mode, speed=speed, reverse=reverse, animation=animation):
                    clip = {"fileId": f"coded-{mode}.mp4", "start": .11, "end": 2.91, "speed": speed,
                            "reverse": reverse, "animation": animation}
                    output = self.export([clip])
                    codes = self.frame_codes(output)
                    self.assertEqual(len(codes), math.ceil((2.91 - .11) / speed * 30 - 1e-7))
                    self.assertGreater(len(set(codes)), 20)
                    for index in (0, 2, 16, 20, 30, 48, len(codes) - 1):
                        still = self.export([clip], snapshot_time=index / 30 + .005)
                        image = self.frame(still)
                        actual = sum(1 << bit for bit in range(8) if image.getpixel((bit * 20 + 10, 48))[0] > 100)
                        self.assertEqual(actual, codes[index], f"output frame {index}")

    def test_exact_output_span_for_mismatched_fps_and_frame_based_range(self):
        clip = {"fileId": "coded-cfr.mp4", "start": .4, "end": 2.9}
        for multitrack in (False, True):
            with self.subTest(multitrack=multitrack):
                output = self.export([clip], multitrack=multitrack)
                self.assert_video_stream(output, 75, 2.5)
                part = self.export([clip], multitrack=multitrack, range_in=.55, range_out=1.32)
                self.assertEqual(self.frame_codes(part), self.frame_codes(output)[17:40])
                exact = self.export([clip], multitrack=multitrack, range_in=.5, range_out=2.3)
                self.assert_video_stream(exact, 54, 1.8)
                self.assertEqual(self.frame_codes(exact), self.frame_codes(output)[15:69])

    def test_subframe_trim_still_holds_the_source_picture(self):
        # VFR fixture has a held frame over the entire interval .12–.15.
        clip = {"fileId": "coded-vfr.mp4", "start": .12, "end": .15}
        output = self.export([clip])
        self.assert_video_stream(output, 1, 1 / 30)
        self.assertEqual(self.frame_codes(output), [2])
        still = self.export([clip], snapshot_time=0)
        self.assertGreater(self.frame(still).getpixel((30, 48))[0], 160)

    def test_fractional_crossfade_has_planned_duration_in_both_layouts(self):
        for multitrack, frames in ((False, 32), (True, 39)):
            with self.subTest(multitrack=multitrack):
                clips = [
                    {"fileId": "changing.mp4", "start": 0, "end": .55},
                    {"fileId": "changing.mp4", "start": 2.55, "end": 3.27, "timelineStart": .55},
                ]
                options = {"transitions": [{"boundary": 0, "type": "fade", "duration": .23}]}
                output = self.export(clips, multitrack=multitrack, **options)
                self.assert_video_stream(output, frames, frames / 30)
                time = 13 / 30
                still = self.export(clips, snapshot_time=time, multitrack=multitrack, **options)
                rendered = self.frame(output, time - .001).getpixel((80, 48))
                captured = self.frame(still).getpixel((80, 48))
                for pixel in (rendered, captured):
                    self.assertTrue(pixel[0] > 60 and pixel[2] > 60, pixel)
                for a, b in zip(rendered, captured):
                    self.assertAlmostEqual(a, b, delta=16)

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

    def test_audio_layer_transients_stay_on_timeline_and_survive_the_export_tail(self):
        source = self.uploads / "audio-transients.wav"
        rate = 48000
        centers = (.123, .627, 2.097)
        pcm = array("h", [0]) * int(2.1 * rate)
        for center in centers:
            peak = round(center * rate)
            for index in range(peak - 320, min(peak + 320, len(pcm))):
                elapsed = (index - peak) / rate
                pcm[index] = round(22000 * math.exp(-(elapsed / .002) ** 2)
                                   * math.cos(math.tau * (970 * elapsed + 200000 * elapsed ** 2)))
        if sys.byteorder != "little":
            pcm.byteswap()
        with wave.open(str(source), "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes(pcm.tobytes())
        reference = self.audio_samples(source)

        clips = [{"fileId": "changing.mp4", "start": 0, "end": 2}]
        layers = [{"fileId": source.name, "start": 0, "end": 2, "sourceStart": .1, "volume": .6}]
        for multitrack in (False, True):
            for first in (0, .5):
                with self.subTest(multitrack=multitrack, range_start=first):
                    output = self.export(clips, multitrack=multitrack, audio_layers=layers,
                                         range_in=first, range_out=2)
                    samples = self.audio_samples(output)
                    expected_length = round((2 - first) * rate)
                    self.assertGreaterEqual(len(samples), expected_length)
                    self.assertLess(len(samples) - expected_length, 1024)
                    self.assertLess(self.rms(samples, .2), 10)
                    for center in centers:
                        timeline_time = center - .1 - first
                        if timeline_time < 0:
                            continue
                        source_start = round(center * rate) - 200
                        frame_start = round(timeline_time * rate) - 200
                        template = reference[source_start:source_start + 320]
                        energy = sum(value * value for value in template)
                        scores = []
                        for lag in range(-300, 301):
                            window = samples[frame_start + lag:frame_start + lag + len(template)]
                            window_energy = sum(value * value for value in window)
                            dot = sum(a * b for a, b in zip(template, window))
                            scores.append((dot / math.sqrt(energy * window_energy) if window_energy else 0, lag))
                        score, lag = max(scores)
                        self.assertGreater(score, .95, (timeline_time, lag, score))
                        self.assertLessEqual(abs(lag), 6, (timeline_time, lag, score))
                        self.assertGreater(max(abs(value) for value in samples[frame_start:frame_start + 320]), 6000)

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

    def test_gif_snapshot_matches_continuous_frames_through_off_grid_loops(self):
        clips = [
            {"fileId": "changing.mp4", "start": 0, "end": .5},
            {"fileId": "changing.mp4", "start": 0, "end": 1.5, "timelineStart": .5},
        ]
        for start, brush in ((0, False), (.021, True), (1 / 30, False)):
            start_us = round(start * 1_000_000)
            layer = {"fileId": "fractional.gif", "start": start, "end": .98, "scale": 50}
            if start == 1 / 30:
                layer["animation"] = "breathe"
            if brush:
                layer.update(backgroundMode="brush", brushStrokes=[{
                    "size": 30, "points": [{"x": .5, "y": .5}],
                }])
            output = self.export(clips, images=[layer])
            pixels = self.ffmpeg("-i", str(output), "-vf", "crop=2:2:80:48",
                                 "-pix_fmt", "rgb24", "-f", "rawvideo", "-")

            def classify(pixel):
                red, green, _ = pixel
                return "background" if green < 40 else "yellow" if red > 180 else "green"

            for frame_index in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 17, 21, 25, 29, 30):
                frame_us = frame_index * 1_000_000 // 30
                elapsed_us = frame_us - start_us
                color = ("background" if elapsed_us < 0 or frame_us > 980000
                         else "yellow" if elapsed_us % 140000 < 80000 else "green")
                with self.subTest(start=start, frame=frame_index):
                    offset = frame_index * 12
                    self.assertEqual(classify(pixels[offset:offset + 3]), color)
                    # Request a time within the displayed frame, including just
                    # after the written layer end when frame 29 is still visible.
                    snapshot_time = .027 if frame_index == 0 and brush else frame_index / 30 + .02
                    snapshot = self.export(clips, snapshot_time=snapshot_time, images=[layer])
                    self.assertEqual(classify(self.frame(snapshot).getpixel((80, 48))), color)

    def test_clip_owned_gif_uses_same_frame_timestamps_on_both_sides_of_track_overlay(self):
        clip = {"clipId": "owner", "fileId": "changing.mp4", "start": 0, "end": 2, "videoTrack": 1}
        image = {"fileId": "fractional.gif", "start": 0, "end": 2, "scale": 50,
                 "mask": "circle", "ownerClipId": "owner", "ownerVideoTrack": 1}
        output = self.export([clip], multitrack=True, images=[image])
        for frame_index in (5, 8, 11, 17, 20):
            elapsed = frame_index / 30
            expected_yellow = (frame_index * 1_000_000 // 30) % 140000 < 80000
            with self.subTest(frame_index=frame_index):
                snapshot = self.export([clip], snapshot_time=elapsed, multitrack=True, images=[image])
                # Seek slightly before the exact tick to include that frame.
                for pixels in (self.frame(output, elapsed - .001), self.frame(snapshot)):
                    red, green, _ = pixels.getpixel((80, 48))
                    self.assertGreater(green, 210)
                    self.assertEqual(red > 180, expected_yellow)

    def test_clip_owned_gif_uses_materialized_cut_after_variable_source_trim_and_speed(self):
        for start, end, speed, gap in ((0, .55, 1, 0), (0, .53, 1, 0),
                                        (.07, .55, 1.3, 0), (0, .55, 1, .24)):
            cut = (end - start) / speed + gap
            cut_frame = math.ceil(cut * 30 - 1e-7)
            clips = [
                {"fileId": "changing.mp4", "clipId": "first", "videoTrack": 1,
                 "start": start, "end": end, "speed": speed, "timelineStart": gap},
                {"fileId": "changing.mp4", "clipId": "owner", "videoTrack": 1,
                 "start": 0, "end": 1.4, "timelineStart": cut},
            ]
            mask = {"fileId": "fractional.gif", "start": cut, "end": cut + 1.4,
                    "scale": 50, "mask": "circle", "ownerClipId": "owner", "ownerVideoTrack": 1}
            with self.subTest(start=start, end=end, speed=speed, gap=gap):
                movie = self.export(clips, multitrack=True, images=[mask])
                pixels = self.ffmpeg("-i", str(movie), "-vf", "crop=2:2:80:48", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
                self.assertEqual(next(frame for frame in range(len(pixels) // 12) if pixels[frame * 12 + 1] > 150),
                                 cut_frame)
                for local_frame in (2, 3, 4, 5, 9, 13, 17, 21):
                    frame = cut_frame + local_frame
                    offset = frame * 12
                    expected_yellow = (local_frame * 1_000_000 // 30) % 140000 < 80000
                    snapshot = self.export(clips, snapshot_time=frame / 30 + .005, multitrack=True, images=[mask])
                    for red, green, _ in (pixels[offset:offset + 3], self.frame(snapshot).getpixel((80, 48))):
                        self.assertGreater(green, 210)
                        self.assertEqual(red > 180, expected_yellow, f"frame {frame}")

    def test_gif_snapshot_reduces_a_late_timeline_time_to_one_cycle(self):
        clip = {"fileId": "changing.mp4", "start": 0, "end": 2, "timelineStart": 10_000}
        layer = {"fileId": "fractional.gif", "start": .021, "end": 10_001, "scale": 50}
        for time, expected_yellow in ((10_000, True), (10_000 + 1 / 30, False)):
            with self.subTest(time=time):
                snapshot = self.export([clip], snapshot_time=time, images=[layer])
                red, green, _ = self.frame(snapshot).getpixel((80, 48))
                self.assertGreater(green, 200)
                self.assertEqual(red > 180, expected_yellow)

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

    def test_delayed_position_keyframes_move_sticker_text_and_image_in_video_and_snapshot(self):
        clip = {"fileId": "short-audio.mp4", "start": 0, "end": 3}
        layers = {
            "texts": [{"text": "I", "size": 180, "outlineWidth": 0, "shadow": False}],
            "stickers": [{"preset": "heart", "scale": 16}],
            "images": [{"fileId": "still.png", "scale": 10}],
        }
        for layer, y in zip(layers.values(), (22, 47, 72)):
            layer[0].update(start=1, end=2.5, x=50, y=50, transformKeyframes=[
                {"time": 0, "scale": 100, "opacity": 100, "x": 20, "y": y},
                {"time": 1, "scale": 100, "opacity": 100, "x": 80, "y": y + 6, "easing": "linear"},
            ])
        output = self.export([clip], **layers)
        self.assertIsNone(self.frame(output, .5).getbbox())
        self.assertIsNone(self.frame(output, 2.8).getbbox())

        initial_tops = {}
        for time, progress in ((1, 0), (1.5, .5), (2, 1), (2.4, 1)):
            snapshot = self.frame(self.export([clip], snapshot_time=time, **layers))
            rendered = self.frame(output, time)
            for kind, (top, bottom) in zip(layers, ((8, 34), (34, 60), (60, 92))):
                with self.subTest(time=time, layer=kind):
                    bounds = [frame.crop((0, top, 160, bottom)).convert("L")
                              .point(lambda value: 255 if value > 80 else 0).getbbox()
                              for frame in (snapshot, rendered)]
                    self.assertIsNotNone(bounds[0])
                    self.assertIsNotNone(bounds[1])
                    left, top_edge, right, _ = bounds[0]
                    self.assertAlmostEqual((left + right) / 2, 32 + 96 * progress, delta=2)
                    initial_top = initial_tops.setdefault(kind, top_edge)
                    self.assertAlmostEqual(top_edge - initial_top, 96 * .06 * progress, delta=2)
                    for actual, expected in zip(bounds[1], bounds[0]):
                        self.assertAlmostEqual(actual, expected, delta=2)

    def test_keyframed_sticker_at_canvas_edge_keeps_static_sprite_alignment(self):
        clip = {"fileId": "short-audio.mp4", "start": 0, "end": 3}
        for x, y in ((0, 0), (100, 100)):
            with self.subTest(x=x, y=y):
                sticker = {"preset": "target", "start": .8, "end": 2.5, "scale": 35,
                           "rotation": 30, "x": x, "y": y}
                keyed = {**sticker, "x": 50, "y": 50, "transformKeyframes": [{"time": 0, "x": x, "y": y}]}
                static, animated = [self.frame(self.export([clip], snapshot_time=1.5, stickers=[item]))
                                    .convert("L").point(lambda value: 255 if value > 80 else 0)
                                    for item in (sticker, keyed)]
                self.assertIsNotNone(static.getbbox())
                self.assertIsNotNone(animated.getbbox())
                for actual, expected in zip(animated.getbbox(), static.getbbox()):
                    self.assertAlmostEqual(actual, expected, delta=2)

    def test_sticker_supports_all_120_keyframes_in_video_and_snapshot(self):
        clip = {"fileId": "short-audio.mp4", "start": 0, "end": 3}
        sticker = {"preset": "target", "start": .5, "end": 4.6, "scale": 16,
                   "transformKeyframes": [{"time": index / 30, "x": 20 + 60 * index / 119, "y": 50}
                                          for index in range(120)]}
        output = self.export([clip], stickers=[sticker])
        for time, index in ((.5, 0), (2.5, 60), (4.5, 119)):
            with self.subTest(time=time):
                snapshot = self.export([clip], snapshot_time=time, stickers=[sticker])
                for frame in (self.frame(snapshot), self.frame(output, time)):
                    bounds = frame.convert("L").point(lambda value: 255 if value > 80 else 0).getbbox()
                    self.assertIsNotNone(bounds)
                    left, _, right, _ = bounds
                    self.assertAlmostEqual((left + right) / 2, 32 + 96 * index / 119, delta=2)

    def test_position_only_keyframes_preserve_text_and_image_scale_and_opacity(self):
        clip = {"fileId": "short-audio.mp4", "start": 0, "end": 3}
        styles = [{"time": 0, "scale": 100, "opacity": 50}, {"time": 1, "scale": 200, "opacity": 100}]
        for existing_style in ([], styles):
            with self.subTest(style=bool(existing_style)):
                baseline = {
                    "texts": [{"text": "TEST", "size": 125, "y": 25, "outlineWidth": 0, "shadow": False}],
                    "images": [{"fileId": "still.png", "scale": 9, "y": 75, "opacity": 60}],
                }
                keyed = {}
                for kind, (item,) in baseline.items():
                    item.update(start=.5, end=2.5, transformKeyframes=existing_style)
                    keyed[kind] = [{**item, "transformKeyframes": [*existing_style, {
                        "time": .5, "x": 75, "y": item["y"], "scale": 280, "opacity": 5, "positionOnly": True,
                    }]}]
                baseline_video = self.export([clip], **baseline)
                keyed_video = self.export([clip], **keyed)
                for time in (.75, 1.25):
                    before = self.export([clip], snapshot_time=time, **baseline)
                    after = self.export([clip], snapshot_time=time, **keyed)
                    for original, moved in ((self.frame(before), self.frame(after)),
                                            (self.frame(baseline_video, time), self.frame(keyed_video, time))):
                        for top, bottom in ((0, 48), (48, 96)):
                            original_layer = original.crop((0, top, 160, bottom)).convert("L")
                            moved_layer = moved.crop((0, top, 160, bottom)).convert("L")
                            bounds = [layer.point(lambda value: 255 if value > 70 else 0).getbbox()
                                      for layer in (original_layer, moved_layer)]
                            self.assertTrue(all(bounds), (time, top, bounds))
                            left, y1, right, y2 = bounds[0]
                            moved_left, moved_y1, moved_right, moved_y2 = bounds[1]
                            self.assertGreater((moved_left + moved_right - left - right) / 2, 10)
                            self.assertAlmostEqual(moved_right - moved_left, right - left, delta=2)
                            self.assertAlmostEqual(moved_y2 - moved_y1, y2 - y1, delta=2)
                            if top == 0:
                                self.assertAlmostEqual(moved_layer.getextrema()[1], original_layer.getextrema()[1], delta=13)
                            else:
                                original_color = original_layer.getpixel(((left + right) // 2, (y1 + y2) // 2))
                                moved_color = moved_layer.getpixel(((moved_left + moved_right) // 2, (moved_y1 + moved_y2) // 2))
                                self.assertAlmostEqual(moved_color, original_color, delta=7)

    def test_position_keyframes_use_ruler_time_across_overlaps_and_export_ranges(self):
        clips = [{"fileId": "short-audio.mp4", "start": 0, "end": 2, "timelineStart": index * 2}
                 for index in range(3)]
        transitions = [{"boundary": index, "type": "fade", "duration": .5} for index in range(2)]
        texts = [{"text": "I", "size": 180, "outlineWidth": 0, "shadow": False}]
        stickers = [{"preset": "target", "scale": 16}]
        images = [{"fileId": "still.png", "scale": 10}]
        for layer, y, start in ((texts, 22, 1), (stickers, 47, 1), (images, 75, 2.5)):
            layer[0].update(start=start, end=5.5, y=y, transformKeyframes=[
                {"time": 0, "x": 20, "y": y},
                {"time": 5 - start, "x": 80, "y": y, "easing": "linear"},
            ])
        layers = {"texts": texts, "stickers": stickers, "images": images, "transitions": transitions}
        full = self.export(clips, **layers)
        ranged = self.export(clips, timeline_range=(3, 5.25), **layers)
        for ruler, output_time in ((1.8, 1.8), (3, 2.5), (5, 4)):
            snapshot = self.export(clips, snapshot_time=ruler, **layers)
            frames = [self.frame(snapshot), self.frame(full, output_time)]
            if ruler >= 3:
                frames.append(self.frame(ranged, output_time - 2.5))
            for top, bottom, start in ((8, 34, 1), (34, 60, 1), (60, 92, 2.5)):
                with self.subTest(ruler=ruler, band=top):
                    for frame in frames:
                        pixels = frame.crop((0, top, 160, bottom)).convert("L")
                        bounds = pixels.point(lambda value: 255 if value > 80 else 0).getbbox()
                        if ruler < start:
                            self.assertIsNone(bounds)
                        else:
                            self.assertIsNotNone(bounds)
                            left, _, right, _ = bounds
                            progress = (ruler - start) / (5 - start)
                            self.assertAlmostEqual((left + right) / 2, 32 + 96 * progress, delta=2)

    def test_animated_layer_visibility_uses_projected_overlap_boundaries(self):
        clips = [{"fileId": "short-audio.mp4", "start": 0, "end": 2, "timelineStart": index * 2}
                 for index in range(2)]
        transitions = [{"boundary": 0, "type": "fade", "duration": .5}]
        stickers = [{"preset": "target", "scale": 16, "start": start, "end": end, "y": y,
                     "transformKeyframes": [{"time": 0, "x": 65, "y": y, "positionOnly": True}]}
                    for y, start, end in ((20, 2.2, 3), (50, 1, 2.2), (80, 2.1, 2.4))]

        def visible_bands(frame):
            pixels = frame.convert("L").point(lambda value: 255 if value > 80 else 0)
            return [bool(pixels.crop((0, top, 160, bottom)).getbbox()) for top, bottom in ((0, 34), (34, 62), (62, 96))]

        full = self.export(clips, transitions=transitions, stickers=stickers)
        ranged = self.export(clips, timeline_range=(2.2, 2.8), transitions=transitions, stickers=stickers)
        for ruler, output_time, expected in ((1.8, 1.8, [False, True, False]),
                                              (59 / 30, 59 / 30, [False, True, False]),
                                              (2.5, 2, [True, False, False]),
                                              (2.8, 2.3, [True, False, False])):
            with self.subTest(ruler=ruler):
                still = self.export(clips, snapshot_time=ruler, transitions=transitions, stickers=stickers)
                self.assertEqual(visible_bands(self.frame(still)), expected)
                self.assertEqual(visible_bands(self.frame(full, output_time)), expected)
        self.assertEqual(visible_bands(self.frame(ranged, 0)), [True, False, False])
        still = self.export(clips, snapshot_time=2.3, transitions=transitions, stickers=stickers)
        self.assertEqual(visible_bands(self.frame(still)), [True, False, True])

    def test_keyframed_image_fadeout_keeps_ruler_duration_across_a_transition(self):
        clips = [{"fileId": "short-audio.mp4", "start": 0, "end": 2, "timelineStart": index * 2}
                 for index in range(2)]
        transitions = [{"boundary": 0, "type": "fade", "duration": .5}]
        image = {"fileId": "still.png", "start": 1, "end": 3.5, "scale": 30,
                 "animation": "fadeout", "animationDuration": .4}
        keyed = {**image, "transformKeyframes": [{"time": 0, "x": 50, "y": 50, "positionOnly": True}]}
        baseline = self.export(clips, transitions=transitions, images=[image])
        full = self.export(clips, transitions=transitions, images=[keyed])
        ranged = self.export(clips, timeline_range=(3.3, 3.5), transitions=transitions, images=[keyed])
        still = self.export(clips, snapshot_time=3.3, transitions=transitions, images=[keyed])

        expected = self.frame(still).convert("L").getpixel((80, 48))
        self.assertAlmostEqual(expected, 113, delta=8)
        for output, time in ((baseline, 2.8), (full, 2.8), (ranged, 0)):
            with self.subTest(output=output):
                actual = self.frame(output, time).convert("L").getpixel((80, 48))
                self.assertAlmostEqual(actual, expected, delta=8)

    def test_upload_quotes_paths_and_discards_unreadable_or_wrong_stream_files(self):
        for source, filename, content_type, expected_kind in (
            ("changing.mp4", "Örnek #1?.MP4", "application/octet-stream", "video"),
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
                self.assertEqual(self.backend.get_media_kind(result["file_id"]), expected_kind)
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

    def test_upload_rejects_usable_payloads_with_extensions_the_editor_cannot_open(self):
        before = set(self.uploads.iterdir())
        for source, filename, mime in (
            ("changing.mp4", "video.bin", "video/mp4"),
            ("silence.wav", "audio", "audio/wav"),
            ("still.png", "image.unknown", "image/png"),
        ):
            with self.subTest(filename=filename):
                response = self.client.post(
                    "/upload", files={"file": (filename, (self.uploads / source).read_bytes(), mime)},
                )
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("Dosya uzantısı desteklenmiyor", response.json()["detail"])
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
