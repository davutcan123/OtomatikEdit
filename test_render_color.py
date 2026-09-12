"""Manual color controls must match the editor's sRGB CSS filter semantics."""
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
from PIL import Image, ImageDraw


COLORS = [(64, 64, 64), (128, 128, 128), (180, 180, 180), (0, 0, 0), (128, 64, 32), (32, 96, 160)]


def css_adjusted_color(rgb, **clip):
    """Independent scalar reference for setVideoEffect's adjustment chain."""
    clamp = lambda value: max(0, min(255, value))
    brightness = max(.05, (clip.get("brightness", 100) + clip.get("exposure", 0) * .55
                           + clip.get("lightness", 0) * .35 + clip.get("relight", 0) * .35) / 100)
    contrast = max(.05, (clip.get("contrast", 100) - clip.get("fade", 0) * .35
                        + clip.get("highlights", 0) * .18 - clip.get("shadows", 0) * .12) / 100)
    saturation = max(0, clip.get("saturation", 100) / 100)
    values = [clamp(clamp(channel * brightness) * contrast + 127.5 * (1 - contrast)) for channel in rgb]
    luminance = sum(value * weight for value, weight in zip(values, (.213, .715, .072)))
    return tuple(round(clamp(luminance + saturation * (value - luminance))) for value in values)


class RenderColorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="render-color-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "render-color-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
            "SMART_EDITOR_LOW_MEMORY_RENDER": "1",
        }):
            spec = importlib.util.spec_from_file_location("render_color_test_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)
        if not shutil.which(cls.backend.FFMPEG_BIN):
            raise unittest.SkipTest("FFmpeg is required for snapshot/video color integration")
        cls.headers = {"X-Desktop-Token": "render-color-test"}
        cls.file_id = "color-patches.mkv"
        fixture = Image.new("RGB", (384, 128))
        drawing = ImageDraw.Draw(fixture)
        for index, color in enumerate(COLORS):
            drawing.rectangle((index * 64, 0, (index + 1) * 64 - 1, 127), fill=color)
        cls.source_image = fixture.copy()
        still = Path(cls.temporary.name) / "source.png"
        fixture.save(still)
        subprocess.run([
            cls.backend.FFMPEG_BIN, "-y", "-v", "error", "-loop", "1", "-i", str(still),
            "-t", "2", "-r", "30", "-c:v", "ffv1", "-pix_fmt", "bgr0",
            str(Path(cls.backend.UPLOAD_DIR) / cls.file_id),
        ], check=True, timeout=20)

    def export(self, settings, snapshot=True):
        with TestClient(self.backend.app) as client:
            response = client.post("/start-snapshot" if snapshot else "/start-render", headers=self.headers, data={
                "file_id": self.file_id,
                "segments": json.dumps([{"fileId": self.file_id, "start": 0, "end": 1.5, **settings}]),
                "width": "384", "height": "128", "fps": "30", "fmt": "mp4", "quality": "high",
                "hardware": "cpu", "timeline_time": "1", "canvas_width": "384", "canvas_height": "128",
            })
            self.assertEqual(response.status_code, 200, response.text)
            job_id = response.json()["job_id"]
            events = client.get("/stream-events/" + job_id, headers=self.headers)
            messages = [json.loads(line[6:]) for line in events.text.splitlines() if line.startswith("data: ")]
            self.assertFalse([item for item in messages if item.get("type") == "error"], messages)
            result = next(item for item in messages if item.get("download_url"))
            if snapshot:
                image = Image.open(io.BytesIO(client.get(result["download_url"], headers=self.headers).content)).convert("RGB")
            else:
                output = Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.mp4"
                frame = subprocess.run([
                    self.backend.FFMPEG_BIN, "-v", "error", "-ss", "1", "-i", str(output),
                    "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-",
                ], check=True, capture_output=True, timeout=20).stdout
                image = Image.open(io.BytesIO(frame)).convert("RGB")
            return image, Path(self.backend.OUTPUT_DIR) / f"script_{job_id}.txt"

    def assert_matches_preview(self, image, settings, tolerance=4, patches=range(len(COLORS))):
        for index in patches:
            expected = css_adjusted_color(COLORS[index], **settings)
            actual = image.getpixel((index * 64 + 32, 64))
            self.assertLessEqual(max(abs(a - e) for a, e in zip(actual, expected)), tolerance,
                                 f"Patch {COLORS[index]}, settings {settings}: expected CSS {expected}, got {actual}")

    def test_snapshot_brightness_is_multiplicative_not_white_offset(self):
        settings = {"brightness": 150}
        image, _ = self.export(settings)
        self.assert_matches_preview(image, settings)
        self.assertLess(max(image.getpixel((96, 64))), 200)

    def test_png_and_video_match_measured_chromium_srgb_reference(self):
        # Measured with Electron 44.3 / Chromium 152 Canvas2D (explicit sRGB),
        # using tests/color_preview.electron.cjs. These are browser samples, not output
        # computed by the backend helper or the scalar reference above.
        references = [
            ({"brightness": 150}, [(96,96,96),(192,192,192),(255,255,255),(0,0,0),(192,96,48),(48,144,240)]),
            ({"brightness": 200}, [(128,128,128),(255,255,255),(255,255,255),(0,0,0),(255,128,64),(64,192,255)]),
            ({"brightness": 150, "contrast": 80}, [(102,102,102),(179,179,179),(229,229,229),(25,25,25),(179,102,63),(63,140,217)]),
            ({"brightness": 120, "contrast": 90, "saturation": 0}, [(81,81,81),(150,150,150),(207,207,207),(12,12,12),(93,93,93),(106,106,106)]),
            ({"brightness": 120, "contrast": 90, "saturation": 100}, [(81,81,81),(150,150,150),(207,207,207),(12,12,12),(150,81,46),(46,116,185)]),
            ({"brightness": 120, "contrast": 90, "saturation": 150}, [(81,81,81),(150,150,150),(207,207,207),(12,12,12),(178,75,22),(16,121,224)]),
        ]
        for settings, expected in references:
            for snapshot in (True, False):
                with self.subTest(settings=settings, format="png" if snapshot else "mp4"):
                    image, _ = self.export(settings, snapshot=snapshot)
                    for index, reference in enumerate(expected):
                        actual = image.getpixel((index * 64 + 32, 64))
                        self.assertLessEqual(max(abs(a - e) for a, e in zip(actual, reference)), 5,
                                             f"Browser {reference}, export {actual}, patch {COLORS[index]}")

    def test_mp4_brightness_matches_same_preview_controls(self):
        settings = {"brightness": 150}
        image, _ = self.export(settings, snapshot=False)
        self.assert_matches_preview(image, settings, tolerance=5)

    def test_lower_brightness_and_zero_slider_match_preview_floor(self):
        for brightness in (50, 0):
            with self.subTest(brightness=brightness):
                settings = {"brightness": brightness}
                image, _ = self.export(settings)
                self.assert_matches_preview(image, settings)

    def test_contrast_fade_and_light_controls_use_same_preview_formula(self):
        cases = [
            {"brightness": 150, "contrast": 80},
            {"brightness": 100, "exposure": 40, "lightness": 20, "relight": 30},
            {"brightness": 125, "fade": 40, "shadows": 30, "highlights": 20},
        ]
        for settings in cases:
            with self.subTest(settings=settings):
                image, _ = self.export(settings)
                self.assert_matches_preview(image, settings)

    def test_saturation_preserves_css_rgb_luminance(self):
        for saturation in (0, 50, 150, 200):
            with self.subTest(saturation=saturation):
                settings = {"brightness": 120, "contrast": 90, "saturation": saturation}
                image, _ = self.export(settings)
                self.assert_matches_preview(image, settings, tolerance=5)

    def test_identity_adjustments_keep_fast_path(self):
        image, script = self.export({})
        self.assertNotIn("lutrgb=", script.read_text())
        self.assertNotIn("geq=", script.read_text())
        self.assert_matches_preview(image, {}, patches=range(4))


if __name__ == "__main__":
    unittest.main()
