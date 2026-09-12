"""Brush geometry, erasing and real edited-frame/video regression coverage."""
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
from PIL import Image, ImageChops

from brush_masks import brush_mask, create_brushed_image, normalize_brush_strokes


STROKES = [
    {"size": 20, "points": [{"x": .2, "y": .5}, {"x": .8, "y": .5}]},
    {"size": 26, "operation": "erase", "points": [{"x": .5, "y": .5}]},
    {"size": 6, "points": [{"x": .5, "y": .5}]},
]


class BrushMaskUnitTests(unittest.TestCase):
    def test_normalization_retains_legacy_order_and_bounds_without_mutating_input(self):
        raw = [{"size": 0, "points": [{"x": -1, "y": 2}]},
               {"operation": "erase", "size": 99, "points": [{"x": .4, "y": .7}]},
               {"operation": "paint", "points": [{"x": .5, "y": .5}]}]
        before = json.dumps(raw)
        result = normalize_brush_strokes(raw, 18)
        self.assertEqual(result, [{"size": 2., "points": [{"x": 0., "y": 1.}]},
                                  {"size": 30., "operation": "erase", "points": [{"x": .4, "y": .7}]},
                                  {"size": 18., "points": [{"x": .5, "y": .5}]}])
        self.assertEqual(json.dumps(raw), before)

    def test_normalization_is_finite_bounded_and_rejects_unknown_operations(self):
        result = normalize_brush_strokes([None, {"size": float("nan"), "points": [None, {"x": float("inf"), "y": .5}, {"x": .5, "y": .5}]}], 14)
        self.assertEqual(result, [{"size": 14., "points": [{"x": .5, "y": .5}]}])
        self.assertEqual(normalize_brush_strokes({"points": []}), [])
        self.assertEqual(sum(len(item["points"]) for item in normalize_brush_strokes([{"points": [{"x": 0, "y": 0}] * 200}])), 180)
        self.assertEqual(len(normalize_brush_strokes([{"points": [{"x": 0, "y": 0}]}] * 50)), 40)
        for operation in ["delete", {}, [], None, 4]:
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                normalize_brush_strokes([{"operation": operation, "points": [{"x": .5, "y": .5}]}])

    def test_connected_strokes_erase_repaint_and_remove_are_ordered(self):
        def pixel(mask, x, y):
            return mask.getpixel((round(x * mask.width), round(y * mask.height)))
        keep = brush_mask({"brushStrokes": STROKES, "brushMode": "keep"}, 320, 180)
        self.assertEqual(pixel(keep, .3, .5), 255, "Two distant sampled endpoints must remain connected")
        self.assertEqual(pixel(keep, .5, .57), 0, "An eraser subtracts from earlier selection")
        self.assertEqual(pixel(keep, .5, .5), 255, "Later paint restores an erased location")
        self.assertEqual(pixel(keep, .3, .15), 0)
        remove = brush_mask({"brushStrokes": STROKES, "brushMode": "remove"}, 320, 180)
        self.assertIsNone(ImageChops.difference(remove, ImageChops.invert(keep)).getbbox())

    def test_preprocessed_image_preserves_source_alpha_and_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source.png", Path(directory) / "masked.png"
            image = Image.new("RGBA", (320, 180), (220, 15, 35, 96))
            image.putpixel((96, 90), (220, 15, 35, 0)); image.save(source)
            before = source.read_bytes()
            self.assertTrue(create_brushed_image(source, output, {"brushStrokes": STROKES, "brushMode": "keep"}))
            with Image.open(output) as result:
                self.assertEqual(result.getpixel((110, 90)), (220, 15, 35, 96))
                self.assertEqual(result.getpixel((96, 90))[3], 0)
                self.assertEqual(result.getpixel((160, 103))[3], 0)
                self.assertEqual(result.getpixel((160, 90))[3], 96)
            self.assertEqual(source.read_bytes(), before)

    def test_animated_source_is_not_flattened_by_static_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "animation.gif", Path(directory) / "masked.png"
            Image.new("RGB", (30, 20), "red").save(source, save_all=True,
                append_images=[Image.new("RGB", (30, 20), "blue")], duration=[100, 100], loop=0)
            original = source.read_bytes()
            self.assertFalse(create_brushed_image(source, output, {"brushStrokes": STROKES}))
            self.assertFalse(output.exists()); self.assertEqual(source.read_bytes(), original)


class BrushMaskRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {"SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "brush-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "", "SMART_EDITOR_LOW_MEMORY_RENDER": "1"})
        cls.environment.start()
        spec = importlib.util.spec_from_file_location("brush_test_app", Path(__file__).with_name("app.py"))
        cls.backend = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.backend)
        if not shutil.which(cls.backend.FFMPEG_BIN):
            cls.environment.stop(); cls.temporary.cleanup(); raise unittest.SkipTest("FFmpeg unavailable")
        cls.headers = {"X-Desktop-Token": "brush-test"}; cls.uploads = Path(cls.backend.UPLOAD_DIR)
        for name, color in [("red.mp4", "red"), ("blue.mp4", "blue")]:
            subprocess.run([cls.backend.FFMPEG_BIN, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=320x180:r=30:d=2",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.uploads / name)], check=True, timeout=20)
        Image.new("RGBA", (320, 180), (255, 0, 0, 128)).save(cls.uploads / "red.png")
        Image.new("RGB", (320, 180), "red").save(cls.uploads / "motion.gif", save_all=True,
            append_images=[Image.new("RGB", (320, 180), "lime")], duration=[600, 600], loop=0)
        cls.hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in cls.uploads.iterdir()}

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop(); cls.temporary.cleanup()

    def output(self, client, clips, mode="snapshot", at=1, **extra):
        payload = {"file_id": clips[0]["fileId"] if clips else "", "segments": json.dumps(clips), "width": "320", "height": "180",
                   "canvas_width": "320", "canvas_height": "180", "fps": "30", "fmt": "mp4", "timeline_time": str(at), **extra}
        response = client.post("/start-" + mode, data=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()["job_id"]
        events = client.get("/stream-events/" + job_id, headers=self.headers).text
        messages = [json.loads(line[6:]) for line in events.splitlines() if line.startswith("data: ")]
        self.assertFalse([item for item in messages if item.get("type") == "error"], events)
        result = next(item for item in messages if item.get("type") == "result")
        if mode == "snapshot":
            image = Image.open(io.BytesIO(client.get(result["download_url"], headers=self.headers).content)).convert("RGB")
        else:
            output = Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.mp4"
            decoded = subprocess.run([self.backend.FFMPEG_BIN, "-v", "error", "-ss", str(at), "-i", str(output), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=True, timeout=20)
            image = Image.open(io.BytesIO(decoded.stdout)).convert("RGB")
        for name, digest in self.hashes.items():
            self.assertEqual(hashlib.sha256((self.uploads / name).read_bytes()).hexdigest(), digest, name)
        self.assertFalse(list(Path(self.backend.OUTPUT_DIR).glob("brush_*_" + job_id + "_*.png")), "Temporary brush sources cleaned")
        return image

    @staticmethod
    def brush(mode="keep"):
        return {"backgroundMode": "brush", "brushMode": mode, "brushStrokes": STROKES}

    def test_image_keep_remove_alpha_matches_snapshot_and_render_with_late_start(self):
        clips = [{"fileId": "blue.mp4", "start": 0, "end": 2}]
        with TestClient(self.backend.app) as client:
            for brush_mode in ["keep", "remove"]:
                layer = {"fileId": "red.png", "start": .5, "end": 1.8, "scale": 100, **self.brush(brush_mode)}
                for mode in ["snapshot", "render"]:
                    with self.subTest(brush_mode=brush_mode, mode=mode):
                        image = self.output(client, clips, mode=mode, images=json.dumps([layer]))
                        painted, erased = image.getpixel((110, 90)), image.getpixel((160, 103))
                        kept, removed = (painted, erased) if brush_mode == "keep" else (erased, painted)
                        self.assertTrue(105 < kept[0] < 150 and 105 < kept[2] < 150, kept)
                        self.assertLess(removed[0], 12); self.assertGreater(removed[2], 230)
                before = self.output(client, clips, at=.25, images=json.dumps([layer]))
                self.assertLess(before.getpixel((110, 90))[0], 12)

    def test_video_keep_remove_eraser_matches_snapshot_and_full_render(self):
        with TestClient(self.backend.app) as client:
            for brush_mode in ["keep", "remove"]:
                clips = [{"fileId": "red.mp4", "start": .25, "end": 1.75, **self.brush(brush_mode)}]
                for mode in ["snapshot", "render"]:
                    with self.subTest(brush_mode=brush_mode, mode=mode):
                        image = self.output(client, clips, mode=mode, at=.75)
                        painted, erased = image.getpixel((110, 90)), image.getpixel((160, 103))
                        kept, removed = (painted, erased) if brush_mode == "keep" else (erased, painted)
                        self.assertGreater(kept[0], 230, kept); self.assertLess(max(removed), 15, removed)

    def test_video_brush_with_dynamic_zoom_has_same_mask_in_snapshot_and_render(self):
        clips = [{"fileId": "blue.mp4", "videoTrack": 1, "start": 0, "end": 2},
                 {"fileId": "red.mp4", "videoTrack": 2, "start": 0, "end": 2, **self.brush(),
                  "zoomKeyframes": [{"time": 0, "scale": 100, "opacity": 100}, {"time": 1.5, "scale": 150, "opacity": 100}]}]
        with TestClient(self.backend.app) as client:
            images = [self.output(client, clips, mode=mode) for mode in ["snapshot", "render"]]
            for image in images:
                self.assertGreater(image.getpixel((110, 90))[0], 225)
                self.assertGreater(image.getpixel((160, 103))[2], 225)
                self.assertGreater(image.getpixel((160, 90))[0], 225)
            for point in [(110, 90), (160, 103), (160, 90), (50, 25)]:
                self.assertLess(max(abs(a - b) for a, b in zip(images[0].getpixel(point), images[1].getpixel(point))), 12)

    def test_invalid_brush_operation_returns_400_in_both_form_paths(self):
        with TestClient(self.backend.app) as client:
            for operation in [{}, "unknown"]:
                invalid = {"backgroundMode": "brush", "brushStrokes": [{"operation": operation, "points": [{"x": .5, "y": .5}]}]}
                clips = [{"fileId": "red.mp4", "start": 0, "end": 1}]
                for field, items in [("segments", [{**clips[0], **invalid}]), ("images", [{"fileId": "red.png", "start": 0, "end": 1, **invalid}])]:
                    payload = {"file_id": "red.mp4", "segments": json.dumps(clips), field: json.dumps(items)}
                    self.assertEqual(client.post("/start-render", data=payload, headers=self.headers).status_code, 400)

    def test_animated_image_brush_preserves_nonzero_time_frames(self):
        layer = {"fileId": "motion.gif", "start": .2, "end": 1.8, "scale": 100, **self.brush()}
        clips = [{"fileId": "blue.mp4", "start": 0, "end": 2}]
        with TestClient(self.backend.app) as client:
            for mode in ["snapshot", "render"]:
                with self.subTest(mode=mode):
                    image = self.output(client, clips, mode=mode, at=1, images=json.dumps([layer]))
                    self.assertGreater(image.getpixel((110, 90))[1], 220, image.getpixel((110, 90)))
                    self.assertLess(image.getpixel((110, 90))[0], 20, image.getpixel((110, 90)))
                    self.assertGreater(image.getpixel((160, 103))[2], 220, image.getpixel((160, 103)))


if __name__ == "__main__":
    unittest.main()
