"""Small, real FFmpeg fixtures for simultaneous video tracks and source crops."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
import numpy as np


class MultiTrackCropTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "tracks-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
            "SMART_EDITOR_LOW_MEMORY_RENDER": "1",
        })
        cls.environment.start()
        spec = importlib.util.spec_from_file_location("multitrack_test_app", Path(__file__).with_name("app.py"))
        cls.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.backend)
        cls.headers = {"X-Desktop-Token": "tracks-test"}
        if not shutil.which(cls.backend.FFMPEG_BIN):
            raise unittest.SkipTest("FFmpeg is required")
        cls.uploads = Path(cls.backend.UPLOAD_DIR)
        for name, color, frequency in (("red", "red", 440), ("green", "lime", 660), ("blue", "blue", 880)):
            subprocess.run([cls.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", f"color={color}:s=320x180:r=30:d=6", "-f", "lavfi",
                            "-i", f"sine=frequency={frequency}:sample_rate=48000:duration=6",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y",
                            str(cls.uploads / (name + ".mp4"))], check=True, timeout=20)
        for name, source in (("halves", "color=red:s=320x180:r=30:d=6,drawbox=x=160:y=0:w=160:h=180:c=blue:t=fill"),
                             ("time", "color=blue:s=320x180:r=30:d=6,drawbox=x=0:y=0:w=320:h=180:c=red:t=fill:enable='gte(t,2)'")):
            subprocess.run([cls.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", source, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y",
                            str(cls.uploads / (name + ".mp4"))], check=True, timeout=20)
        Image.new("RGBA", (80, 40), (240, 40, 20, 255)).save(cls.uploads / "image.png")
        subprocess.run([cls.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                        "-i", "sine=frequency=880:sample_rate=48000:duration=4", "-y",
                        str(cls.uploads / "audio.wav")], check=True, timeout=20)

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.temporary.cleanup()

    def clip(self, name="red", track=1, **settings):
        return {"fileId": name + ".mp4", "start": 0, "end": 4, "timelineStart": 0,
                "videoTrack": track, **settings}

    def render(self, clips, at=None, **layers):
        payload = {"file_id": clips[0]["fileId"] if clips else "", "segments": json.dumps(clips),
                   "width": "320", "height": "180", "fps": "30", "fmt": "mp4", "quality": "ultra",
                   "hardware": "cpu", **{key: json.dumps(value) for key, value in layers.items()}}
        if at is not None:
            payload["timeline_time"] = str(at)
        with TestClient(self.backend.app) as client:
            response = client.post("/start-snapshot" if at is not None else "/start-render",
                                   data=payload, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            job_id = response.json()["job_id"]
            events = client.get("/stream-events/" + job_id, headers=self.headers).text
            self.assertNotIn('"type": "error"', events, events)
            output = Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.{'png' if at is not None else 'mp4'}"
            self.assertTrue(output.is_file(), events)
        return (Image.open(output).convert("RGB") if at is not None else output), self.backend.jobs[job_id]

    def frame(self, output, at):
        result = subprocess.run([self.backend.FFMPEG_BIN, "-v", "error", "-ss", str(at), "-i", str(output),
                                 "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                                check=True, capture_output=True, timeout=20)
        return Image.open(io.BytesIO(result.stdout)).convert("RGB")

    def dominant(self, image, point, channel):
        pixel = image.getpixel(point)
        self.assertGreater(pixel[channel], 170, pixel)
        self.assertLess(max(value for i, value in enumerate(pixel) if i != channel), 60, pixel)

    def test_three_tracks_stack_by_number_with_transparent_transform_canvas(self):
        clips = [self.clip("blue", 3, scale=25, x=25), self.clip("red", 1),
                 self.clip("green", 2, scale=50, x=25)]
        output, _ = self.render(clips)
        snapshot, _ = self.render(clips, 2)
        for image in (snapshot, self.frame(output, 2)):
            self.dominant(image, (280, 90), 0)
            self.dominant(image, (20, 90), 1)
            self.dominant(image, (80, 90), 2)
        self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 4, delta=.07)

    def test_track_gaps_reveal_underlying_video_and_black_when_all_empty(self):
        clips = [self.clip("red", 1, end=1), self.clip("blue", 2, end=1, timelineStart=2)]
        output, _ = self.render(clips)
        for time, channel in ((.5, 0), (2.5, 2)):
            self.dominant(self.frame(output, time), (160, 90), channel)
            self.dominant(self.render(clips, time)[0], (160, 90), channel)
        self.assertLess(max(self.frame(output, 1.5).getpixel((160, 90))), 5)
        self.assertEqual(self.render(clips, 1.5)[0].getpixel((160, 90)), (0, 0, 0))
        self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 3, delta=.07)

    def test_crop_is_source_relative_before_fit_and_never_changes_upload(self):
        original = hashlib.sha256((self.uploads / "halves.mp4").read_bytes()).hexdigest()
        crop = {"x": .5, "y": 0, "width": .5, "height": 1}
        clips = [self.clip("halves", crop=crop)]
        output, _ = self.render(clips)
        for image in (self.render(clips, 2)[0], self.frame(output, 2)):
            self.dominant(image, (10, 90), 2)
            self.dominant(image, (300, 90), 2)
        clips = [self.clip("red"), self.clip("halves", 2, crop=crop, scale=50, x=75)]
        image, _ = self.render(clips, 2)
        self.dominant(image, (40, 90), 0)
        self.dominant(image, (240, 90), 2)
        self.assertEqual(hashlib.sha256((self.uploads / "halves.mp4").read_bytes()).hexdigest(), original)

    def test_track_visibility_does_not_mute_and_track_mute_does_not_hide(self):
        clips = [self.clip("red"), self.clip("green", 2, trackVisible=False)]
        output, _ = self.render(clips)
        self.dominant(self.frame(output, 1), (160, 90), 0)
        self.dominant(self.render(clips, 1)[0], (160, 90), 0)
        def energy(path, frequency):
            raw = subprocess.run([self.backend.FFMPEG_BIN, "-v", "error", "-ss", "1", "-i", str(path),
                                  "-t", "1", "-f", "f32le", "-ac", "1", "-ar", "48000", "-"],
                                 check=True, capture_output=True, timeout=20).stdout
            samples = np.frombuffer(raw, dtype="<f4")
            return abs(np.mean(samples * np.exp(-2j * np.pi * frequency * np.arange(len(samples)) / 48000)))
        self.assertGreater(energy(output, 440), .025)
        self.assertGreater(energy(output, 660), .025)
        clips[1].update(trackVisible=True, trackMuted=True)
        muted, _ = self.render(clips)
        self.dominant(self.frame(muted, 1), (160, 90), 1)
        self.assertLess(energy(muted, 660), .002)
        self.assertGreater(energy(muted, 440), .025)

    def test_multitrack_transition_uses_same_track_successor_and_source_preroll_without_ripple(self):
        clips = [self.clip("green", 1, end=2), self.clip("blue", 2, opacity=0),
                 self.clip("time", 1, start=2, end=4, timelineStart=2)]
        transitions = [{"boundary": 0, "duration": .5, "type": "fade"}]
        output, _ = self.render(clips, transitions=transitions)
        self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 4, delta=.07)
        for image in (self.frame(output, 1.75), self.render(clips, 1.75, transitions=transitions)[0]):
            red, green, blue = image.getpixel((160, 90))
            self.assertLess(red, 30, (red, green, blue))
            self.assertTrue(70 < green < 190 and 70 < blue < 190, (red, green, blue))
        self.dominant(self.frame(output, 2.1), (160, 90), 0)
        self.dominant(self.render(clips, 2.1, transitions=transitions)[0], (160, 90), 0)

    def test_layers_extend_past_video_end_and_empty_video_timeline_is_supported(self):
        images = [{"fileId": "image.png", "start": 2, "end": 3, "scale": 50}]
        for clips in ([self.clip("blue", end=1)], []):
            with self.subTest(clips=bool(clips)):
                output, _ = self.render(clips, images=images)
                self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 3, delta=.07)
                self.dominant(self.frame(output, 2.5), (160, 90), 0)
                self.dominant(self.render(clips, 2.5, images=images)[0], (160, 90), 0)
                self.assertLess(max(self.frame(output, 1.5).getpixel((160, 90))), 5)
        audio = [{"fileId": "audio.wav", "start": 1, "end": 3}]
        output, _ = self.render([], audio_layers=audio)
        self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 3, delta=.07)
        self.assertLess(max(self.frame(output, 2).getpixel((160, 90))), 5)
        image, _ = self.render([], 2, audio_layers=audio)
        self.assertEqual(image.getpixel((160, 90)), (0, 0, 0))
        text = [{"text": "ONLY TEXT", "start": 0, "end": 1, "size": 180, "x": 50, "y": 50}]
        output, _ = self.render([], texts=text)
        self.assertIsNotNone(self.frame(output, .5).getbbox())

    def test_upper_track_fade_keyframe_alpha_and_missing_preroll_handles_match_snapshot(self):
        clips = [self.clip("red"), self.clip("blue", 2, end=2),
                 self.clip("green", 2, end=2, timelineStart=2, animation="fadein", animationDuration=1,
                           zoomKeyframes=[{"time": 0, "scale": 100, "opacity": 50}])]
        transition = [{"boundary": 1, "type": "fade", "duration": .5}]
        output, _ = self.render(clips, transitions=transition)
        for at in (1.75, 2.5):
            rendered = self.frame(output, at)
            snapshot = self.render(clips, at, transitions=transition)[0]
            for actual, expected in zip(rendered.getpixel((160, 90)), snapshot.getpixel((160, 90))):
                self.assertAlmostEqual(actual, expected, delta=15)
            red, green, blue = rendered.getpixel((160, 90))
            if at < 2:
                self.assertGreater(red, 80)
                self.assertGreater(blue, 80)
                self.assertLess(green, 30)
            else:
                self.assertTrue(160 < red < 220 and 35 < green < 95 and blue < 25, (red, green, blue))
        self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 4, delta=.07)

    def test_reverse_preroll_and_trimmed_source_alignment(self):
        clips = [self.clip("green", 1, end=2), self.clip("blue", 2, opacity=0),
                 self.clip("time", 1, start=0, end=2, timelineStart=2, reverse=True)]
        transition = [{"boundary": 0, "type": "fade", "duration": .5}]
        output, _ = self.render(clips, transitions=transition)
        for image in (self.frame(output, 1.75), self.render(clips, 1.75, transitions=transition)[0]):
            red, green, blue = image.getpixel((160, 90))
            self.assertTrue(70 < red < 190 and 70 < green < 190 and blue < 30, (red, green, blue))
        self.dominant(self.frame(output, 2.2), (160, 90), 2)
        self.dominant(self.render(clips, 2.2, transitions=transition)[0], (160, 90), 2)

    def test_late_cropped_clip_speed_and_animated_opacity_use_clip_local_time(self):
        clips = [self.clip("red"), self.clip("halves", 2, start=2, end=6, speed=2, timelineStart=1,
                 crop={"x": .5, "y": 0, "width": .5, "height": 1},
                 zoomKeyframes=[{"time": 0, "scale": 100, "opacity": 0, "easing": "linear"},
                                {"time": 1, "scale": 100, "opacity": 100, "easing": "linear"}])]
        output, _ = self.render(clips)
        for at in (.5, 1.5, 2.5, 3.5):
            rendered = self.frame(output, at)
            snapshot = self.render(clips, at)[0]
            for actual, expected in zip(rendered.getpixel((160, 90)), snapshot.getpixel((160, 90))):
                self.assertAlmostEqual(actual, expected, delta=12)
            if at in (.5, 3.5):
                self.dominant(rendered, (160, 90), 0)
            elif at == 2.5:
                self.dominant(rendered, (160, 90), 2)
            else:
                red, green, blue = rendered.getpixel((160, 90))
                self.assertTrue(90 < red < 165 and 90 < blue < 165 and green < 30, (red, green, blue))

    def test_keyframed_picture_in_picture_shrinks_and_keeps_its_focal_position(self):
        clips = [self.clip("red"), self.clip("blue", 2, timelineStart=1, end=2,
                 zoomKeyframes=[{"time": 0, "scale": 25, "x": 0, "y": 50, "easing": "linear"},
                                {"time": 1, "scale": 75, "x": 0, "y": 50, "easing": "linear"}])]
        output, _ = self.render(clips)
        for at, width in ((1.0, 80), (1.5, 160), (2.0, 240)):
            for image in (self.frame(output, at), self.render(clips, at)[0]):
                self.dominant(image, (width - 10, 90), 2)
                self.dominant(image, (width + 10, 90), 0)
                self.dominant(image, (10, 90), 2)
                self.dominant(image, (10, 5), 0)

    def test_explicit_composite_mode_preserves_single_populated_track_timing(self):
        clips = [self.clip("green", end=2), self.clip("time", start=2, end=4, timelineStart=2)]
        transitions = [{"boundary": 0, "duration": .5, "type": "fade"}]
        output, job = self.render(clips, transitions=transitions, timeline_composite=True)
        self.assertTrue(job["multitrack"])
        self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 4, delta=.07)
        for image in (self.frame(output, 1.75), self.render(clips, 1.75, transitions=transitions, timeline_composite=True)[0]):
            red, green, blue = image.getpixel((160, 90))
            self.assertTrue(red < 30 and 70 < green < 190 and 70 < blue < 190, (red, green, blue))

    def test_owned_mask_stays_below_higher_track_and_disappears_with_hidden_owner(self):
        clips = [self.clip("green", clipId="lower", mask="circle"), self.clip("blue", 2, scale=25, clipId="upper")]
        masks = [{"fileId": "image.png", "start": 0, "end": 4, "mask": "circle",
                  "ownerClipId": "lower", "ownerVideoTrack": 1}]
        for hidden in (False, True):
            clips[0]["trackVisible"] = not hidden
            output, job = self.render(clips, images=masks)
            self.assertEqual(len(job["images"]), 0 if hidden else 1)
            for image in (self.frame(output, 1), self.render(clips, 1, images=masks)[0]):
                self.dominant(image, (160, 90), 2)
                if hidden:
                    self.assertLess(max(image.getpixel((220, 90))), 5)
                else:
                    self.dominant(image, (220, 90), 0)
                    self.dominant(image, (10, 90), 1)

    def test_incoming_owned_mask_participates_in_transition_preroll_and_snapshot(self):
        clips = [self.clip("red", clipId="background"), self.clip("blue", 2, end=2, clipId="outgoing"),
                 self.clip("green", 2, end=2, timelineStart=2, clipId="incoming")]
        masks = [{"fileId": "image.png", "start": 2, "end": 4, "mask": "circle",
                  "ownerClipId": "incoming", "ownerVideoTrack": 2}]
        transitions = [{"boundary": 1, "duration": .5, "type": "fade"}]
        output, _ = self.render(clips, images=masks, transitions=transitions)
        for at in (1.75, 2.5):
            rendered = self.frame(output, at)
            snapshot, _ = self.render(clips, at, images=masks, transitions=transitions)
            for actual, expected in zip(rendered.getpixel((160, 90)), snapshot.getpixel((160, 90))):
                self.assertAlmostEqual(actual, expected, delta=12)
            red, green, blue = rendered.getpixel((160, 90))
            if at < 2:
                self.assertTrue(red > 70 and blue > 70 and green < 50, (red, green, blue))
            else:
                self.dominant(rendered, (160, 90), 0)
        self.assertAlmostEqual(self.backend.get_video_duration(str(output)), 4, delta=.07)

    def test_same_track_overlap_and_invalid_crop_are_rejected_but_track_ids_have_no_small_cap(self):
        with TestClient(self.backend.app) as client:
            for clips in ([self.clip(), self.clip("blue")], [self.clip(crop={"x": 1, "width": .5})],
                          [self.clip(crop={"x": float("nan")})], [self.clip(track=0)], [self.clip(track=1.5)]):
                response = client.post("/start-render", data={"file_id": "red.mp4", "segments": json.dumps(clips)}, headers=self.headers)
                self.assertEqual(response.status_code, 400, response.text)
        image, _ = self.render([self.clip(), self.clip("blue", 100000)], 1)
        self.dominant(image, (160, 90), 2)


if __name__ == "__main__":
    unittest.main()
