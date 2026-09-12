"""Real FFmpeg checks for imported-image transforms, alpha and local timing."""
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

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw


class ImageLayerEffectsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "image-layer-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
            "SMART_EDITOR_LOW_MEMORY_RENDER": "1", "SMART_EDITOR_RENDER_ENCODER": "cpu",
        })
        cls.environment.start()
        spec = importlib.util.spec_from_file_location("image_layers_test_app", Path(__file__).with_name("app.py"))
        cls.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.backend)
        if not shutil.which(cls.backend.FFMPEG_BIN):
            raise unittest.SkipTest("FFmpeg is required")
        cls.headers = {"X-Desktop-Token": "image-layer-test"}
        cls.uploads = Path(cls.backend.UPLOAD_DIR)
        subprocess.run([cls.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                        "-i", "color=black:s=320x180:r=30:d=5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-y", str(cls.uploads / "black.mp4")], check=True, timeout=20)
        Image.new("RGBA", (80, 40), (240, 40, 20, 255)).save(cls.uploads / "red.png")
        transparent = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
        ImageDraw.Draw(transparent).rectangle((20, 20, 59, 59), fill=(180, 60, 30, 255))
        transparent.save(cls.uploads / "alpha.png")

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.temporary.cleanup()

    def image(self, **kwargs):
        return {"fileId": "red.png", "start": 1, "end": 4, "scale": 25,
                "x": 50, "y": 50, **kwargs}

    def export(self, images, at=None):
        payload = {"file_id": "black.mp4", "segments": json.dumps([
            {"fileId": "black.mp4", "start": 0, "end": 5}]),
            "images": json.dumps(images), "width": "320", "height": "180", "fps": "30",
            "fmt": "mp4", "quality": "ultra", "canvas_width": "320", "canvas_height": "180"}
        if at is not None:
            payload["timeline_time"] = str(at)
        with TestClient(self.backend.app) as client:
            response = client.post("/start-snapshot" if at is not None else "/start-render",
                                   data=payload, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            job_id = response.json()["job_id"]
            events = client.get("/stream-events/" + job_id, headers=self.headers).text
            self.assertNotIn('"type": "error"', events, events)
            suffix = "png" if at is not None else "mp4"
            output = Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.{suffix}"
            self.assertTrue(output.is_file(), events)
        if at is not None:
            return Image.open(output).convert("RGB")
        return output

    def frame(self, path, at):
        result = subprocess.run([self.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
                                 "-ss", str(at), "-i", str(path), "-frames:v", "1", "-f", "image2pipe",
                                 "-vcodec", "png", "-"], check=True, capture_output=True, timeout=20)
        return Image.open(io.BytesIO(result.stdout)).convert("RGB")

    def red_bounds(self, image):
        mask = image.point(lambda value: 255 if value > 60 else 0).split()[0]
        return mask.getbbox()

    def test_normalization_is_bounded_validated_and_independent(self):
        original = self.image(opacity=200, effect="warm", filter="mono", animation="fadein",
                              effectIntensity=-10, animationDuration=100,
                              transformKeyframes=[{"time": 99, "scale": 800, "opacity": -20}])
        result = self.backend.normalize_image_layers([original], 5)[0]
        self.assertEqual(result["opacity"], 100)
        self.assertEqual(result["effectIntensity"], 0)
        self.assertEqual(result["animationDuration"], 10)
        self.assertEqual(result["transformKeyframes"][0]["scale"], 300)
        self.assertEqual(result["transformKeyframes"][0]["time"], 3)
        self.assertEqual(result["transformKeyframes"][0]["opacity"], 0)
        result["transformKeyframes"][0]["scale"] = 50
        self.assertEqual(original["transformKeyframes"][0]["scale"], 800)
        for invalid in ({"animation": "bad"}, {"effect": "bad"}, {"filter": "bad"},
                        {"opacity": float("nan")}, {"effectIntensity": float("inf")},
                        {"transformKeyframes": [{"time": float("nan")}]},
                        {"transformKeyframes": [None]}, {"transformKeyframes": [{}] * 121}):
            with self.subTest(invalid=invalid), self.assertRaises(HTTPException):
                self.backend.normalize_image_layers([self.image(**invalid)], 5)

    def test_late_start_keyframe_scale_position_opacity_match_snapshot_and_video(self):
        item = self.image(transformKeyframes=[
            {"time": 0, "scale": 100, "x": 25, "y": 30, "opacity": 50},
            {"time": 2, "scale": 200, "x": 75, "y": 70, "opacity": 100, "easing": "linear"},
        ])
        video = self.export([item])
        self.assertIsNone(self.red_bounds(self.frame(video, .5)))
        raw = subprocess.run([self.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
                              "-ss", "1", "-i", str(video), "-frames:v", "60", "-f", "rawvideo",
                              "-pix_fmt", "rgb24", "-"], check=True, capture_output=True, timeout=20).stdout
        frame_bytes = 320 * 180 * 3
        self.assertEqual(len(raw), 60 * frame_bytes)
        centers = []
        for offset in range(0, len(raw), frame_bytes):
            left, _, right, _ = self.red_bounds(Image.frombytes("RGB", (320, 180), raw[offset:offset + frame_bytes]))
            centers.append((left + right) / 2)
        # A small positive motion on every output frame catches framesync
        # freezes/reinitialization that sparse before/after checks would miss.
        for previous, current in zip(centers, centers[1:]):
            self.assertGreater(current - previous, .5)
            self.assertLessEqual(current - previous, 5)
        previous_x = -1
        for at in (1, 1.5, 2, 2.5, 3, 3.5):
            with self.subTest(at=at):
                snapshot = self.export([item], at)
                rendered = self.frame(video, at)
                left, top, right, bottom = self.red_bounds(snapshot)
                center_x, center_y = (left + right) / 2, (top + bottom) / 2
                self.assertGreaterEqual(center_x, previous_x)
                previous_x = center_x
                progress = min(1, (at - 1) / 2)
                self.assertAlmostEqual(center_x, 80 + 160 * progress, delta=2)
                self.assertAlmostEqual(center_y, 54 + 72 * progress, delta=2)
                self.assertAlmostEqual(right - left, 80 * (1 + progress), delta=4)
                self.assertAlmostEqual(snapshot.getpixel((int(center_x), int(center_y)))[0], 240 * (.5 + .5 * progress), delta=7)
                self.assertAlmostEqual(rendered.getpixel((int(center_x), int(center_y)))[0], snapshot.getpixel((int(center_x), int(center_y)))[0], delta=8)
                for actual, expected in zip(self.red_bounds(rendered), self.red_bounds(snapshot)):
                    self.assertAlmostEqual(actual, expected, delta=3)
        self.assertIsNone(self.red_bounds(self.frame(video, 4.5)))

    def test_late_start_fade_in_and_out_are_alpha_fades_not_black_boxes(self):
        for animation in ("fadein", "fadeout", "fade"):
            with self.subTest(animation=animation):
                item = self.image(animation=animation, animationDuration=1)
                video = self.export([item])
                for at in (1.5, 2.5, 3.5):
                    elapsed, remaining = at - 1, 4 - at
                    amount = min(1, elapsed) if animation == "fadein" else min(1, remaining)
                    if animation == "fade":
                        amount = min(amount, elapsed)
                    snapshot = self.export([item], at)
                    self.assertAlmostEqual(snapshot.getpixel((160, 90))[0], 240 * amount, delta=7)
                    self.assertAlmostEqual(self.frame(video, at).getpixel((160, 90))[0], 240 * amount, delta=9)

    def test_effect_and_filter_preserve_source_alpha_and_intensity(self):
        for preset in ({"effect": "negative"}, {"filter": "mono"},
                       {"effect": "warm", "filter": "mono", "opacity": 50},
                       {"effect": "negative", "effectIntensity": 50}):
            with self.subTest(preset=preset):
                item = self.image(fileId="alpha.png", **preset)
                snapshot = self.export([item], 2)
                video_frame = self.frame(self.export([item]), 2)
                self.assertEqual(snapshot.getpixel((124, 54)), (0, 0, 0))
                self.assertLess(max(video_frame.getpixel((124, 54))), 5)
                pixel = snapshot.getpixel((160, 90))
                if preset.get("filter") == "mono":
                    self.assertLess(max(pixel) - min(pixel), 5)
                elif preset.get("effectIntensity") == 50:
                    self.assertTrue(all(115 < value < 140 for value in pixel), pixel)
                else:
                    self.assertGreater(pixel[2], pixel[0] + 80)

    def test_brush_mask_and_rotation_move_with_image_object(self):
        item = self.image(fileId="alpha.png", backgroundMode="brush", brushMode="keep",
                          brushStrokes=[{"size": 30, "points": [{"x": .5, "y": .5}]}],
                          rotation=45, effect="negative", transformKeyframes=[
                              {"time": 0, "x": 25, "y": 50, "scale": 100},
                              {"time": 2, "x": 75, "y": 50, "scale": 150, "easing": "linear"}])
        frame = self.export([item], 3)
        self.assertGreater(max(frame.getpixel((240, 90))), 150)
        self.assertEqual(frame.getpixel((80, 90)), (0, 0, 0))
        self.assertEqual(frame.getpixel((205, 55)), (0, 0, 0))

    def test_trim_rebased_frames_use_new_image_start_not_original_timeline_time(self):
        # Frontend trims 1 second from the left and seeds the interpolated state.
        item = self.image(start=2, end=3.5, transformKeyframes=[
            {"time": 0, "x": 50, "y": 50, "scale": 150, "opacity": 75},
            {"time": 1, "x": 75, "y": 50, "scale": 200, "opacity": 100, "easing": "linear"},
        ])
        snapshot = self.export([item], 2)
        self.assertAlmostEqual(snapshot.getpixel((160, 90))[0], 180, delta=7)
        left, _, right, _ = self.red_bounds(snapshot)
        self.assertAlmostEqual((left + right) / 2, 160, delta=2)
        self.assertAlmostEqual(right - left, 120, delta=4)

    def test_static_edge_position_matches_equivalent_keyframe_position(self):
        for x, y in ((0, 50), (100, 50), (50, 0), (50, 100)):
            with self.subTest(x=x, y=y):
                item = self.image(x=x, y=y)
                static = self.export([item], 2)
                keyed = self.export([{**item, "transformKeyframes": [
                    {"time": 0, "x": x, "y": y, "scale": 100, "opacity": 100},
                ]}], 2)
                # The padded animated transform can contribute a one-chroma-
                # sample fringe; its object placement must still agree.
                for actual, expected in zip(self.red_bounds(static), self.red_bounds(keyed)):
                    self.assertAlmostEqual(actual, expected, delta=2)
                left, top, right, bottom = self.red_bounds(static)
                if x in (0, 100):
                    self.assertAlmostEqual(right - left, 40, delta=2)
                    self.assertEqual(left if x == 0 else right, 0 if x == 0 else 320)
                else:
                    self.assertAlmostEqual(bottom - top, 20, delta=2)
                    self.assertEqual(top if y == 0 else bottom, 0 if y == 0 else 180)

    def test_every_animation_preset_renders_a_nonzero_time_snapshot(self):
        # Covers expression syntax for all 60 cards, including two-axis flips,
        # rotations, blur, brightness animations and local outgoing fades.
        for animation in sorted(self.backend.ALLOWED_CLIP_ANIMATIONS):
            with self.subTest(animation=animation):
                image = self.export([self.image(animation=animation, animationDuration=1)], 1.75)
                self.assertEqual(image.size, (320, 180))


if __name__ == "__main__":
    unittest.main()
