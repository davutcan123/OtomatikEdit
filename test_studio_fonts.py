"""Bundled font catalogue, Turkish glyphs and actual snapshot/video output."""
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
from PIL import Image, ImageFont

from studio_fonts import DEFAULT_FONT, bundled_font_path


class StudioFontTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "font-test",
            "SMART_EDITOR_DATA_DIR": temporary.name,
        }):
            spec = importlib.util.spec_from_file_location("studio_fonts_test_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)

    def setUp(self):
        self.client = self.enterContext(TestClient(self.backend.app, headers={"X-Desktop-Token": "font-test"}))

    def test_catalog_drives_every_css_face_bundled_file_license_and_turkish_glyph(self):
        catalog = self.client.get("/static/studio/fonts/catalog.json").json()
        css = self.client.get("/studio/font-faces.css")
        self.assertTrue(css.headers["content-type"].startswith("text/css"))
        self.assertEqual(len(catalog), 9)
        keys = {item["id"] for item in catalog}
        self.assertEqual(len(keys), 9)
        self.assertEqual(css.text.count("@font-face"), sum(len(item["files"]) for item in catalog))
        self.assertNotIn("https:", css.text)
        for item in catalog:
            family = item["id"]
            with self.subTest(family=family):
                self.assertIn(f'font-family:"studio-font-{family}"', css.text)
                license_response = self.client.get(f"/static/studio/fonts/{family}/OFL.txt")
                self.assertIn("SIL OPEN FONT LICENSE", license_response.text.upper())
                for weight, filename in item["files"].items():
                    self.assertIn(f'/static/studio/fonts/{family}/{filename}', css.text)
                    face = self.client.get(f"/static/studio/fonts/{family}/{filename}")
                    self.assertEqual(face.status_code, 200)
                    font_path = bundled_font_path(self.backend.RESOURCE_DIR, family, weight == "700")
                    self.assertEqual(Path(font_path).name, filename)
                    self.assertEqual(face.content, Path(font_path).read_bytes())
                    font = ImageFont.truetype(font_path, 36)
                    undefined = bytes(font.getmask("\U0010FFFF"))
                    for character in "ĞğİıŞşÇçÖöÜü":
                        self.assertTrue(font.getbbox(character))
                        self.assertNotEqual(bytes(font.getmask(character)), undefined, character)
        index = self.client.get("/")
        self.assertIn("/studio/font-faces.css", index.text)
        self.assertIn("/static/studio/fonts.js", index.headers["content-security-policy"])
        self.assertIn("font-src 'self'", index.headers["content-security-policy"])

    def test_normalization_and_legacy_font_fallback(self):
        valid, legacy, invalid, malformed = self.backend.normalize_text_items([
            {"text": "İstanbul", "fontFamily": "barlow"},
            {"text": "İstanbul"},
            {"text": "İstanbul", "fontFamily": "../../other.ttf"},
            {"text": "İstanbul", "fontFamily": {"path": "font.ttf"}},
        ], 2)
        self.assertEqual(valid["fontFamily"], "barlow")
        for item in (legacy, invalid, malformed):
            self.assertEqual(item["fontFamily"], DEFAULT_FONT)
        regular_only = "instrumentserif"
        self.assertEqual(bundled_font_path(self.backend.RESOURCE_DIR, regular_only, True),
                         bundled_font_path(self.backend.RESOURCE_DIR, regular_only, False))
        self.assertIsNone(bundled_font_path(self.backend.RESOURCE_DIR, DEFAULT_FONT, True))

    def test_selected_family_and_weight_affect_png_and_mp4_with_same_geometry(self):
        ffmpeg = self.backend.FFMPEG_BIN
        if not shutil.which(ffmpeg):
            self.skipTest("FFmpeg is needed for actual font render verification")
        clip_path = Path(self.backend.UPLOAD_DIR) / "font-board.mp4"
        self.ffmpeg("-f", "lavfi", "-i", "color=black:s=480x270:r=30:d=1", "-c:v", "libx264", str(clip_path))
        widths = {}
        for family, weight in (("barlowcondensed", False), ("spacemono", False), ("spacemono", True)):
            text = {"text": "İŞİĞİ gör", "size": 170, "start": 0, "end": 1, "x": 50, "y": 50,
                    "color": "#FFFFFF", "shadow": False, "outlineWidth": 0, "fontFamily": family, "bold": weight}
            areas = []
            for snapshot in (True, False):
                with self.subTest(family=family, weight=weight, snapshot=snapshot):
                    payload = {"file_id": clip_path.name, "segments": json.dumps([{"start": 0, "end": 1}]),
                               "texts": json.dumps([text]), "width": 480, "height": 270, "quality": "high",
                               "hardware": "cpu", "timeline_time": .5, "canvas_width": 1920, "canvas_height": 1080}
                    result = self.export(payload, snapshot)
                    if not snapshot:
                        result = self.ffmpeg("-ss", "0.5", "-i", str(result), "-frames:v", "1",
                                             "-f", "image2pipe", "-c:v", "png", "-")
                    else:
                        result = result.read_bytes()
                    frame = Image.open(io.BytesIO(result)).convert("L")
                    visible = frame.point(lambda value: 255 if value > 80 else 0)
                    bounds = visible.getbbox()
                    self.assertIsNotNone(bounds)
                    areas.append(visible.histogram()[255])
                    widths.setdefault((family, weight), []).append(bounds[2] - bounds[0])
            self.assertAlmostEqual(widths[(family, weight)][0], widths[(family, weight)][1], delta=2)
            self.assertAlmostEqual(areas[0], areas[1], delta=35)
            if family == "spacemono" and not weight:
                regular_area = areas[0]
            elif family == "spacemono":
                self.assertGreater(areas[0], regular_area + 50)
        self.assertGreater(widths[("spacemono", False)][0] - widths[("barlowcondensed", False)][0], 25)

    def test_project_store_roundtrips_font_family_for_text_and_subtitles(self):
        texts = [
            {"id": "T1", "text": "İstanbul", "fontFamily": "barlow", "bold": False, "start": 0, "end": .5},
            {"id": "T2", "text": "Şimdi", "fontFamily": "crimsontext", "kind": "subtitle", "start": .5, "end": 1},
        ]
        saved = self.client.post("/projects", json={"name": "Yazı tipi testi", "timelines": [
            {"id": "TL1", "name": "Bir", "state": {"texts": texts}},
            {"id": "TL2", "name": "İki", "state": {"texts": texts}},
        ]})
        self.assertEqual(saved.status_code, 200, saved.text)
        loaded = self.client.get("/projects/" + saved.json()["id"])
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual([timeline["state"]["texts"] for timeline in loaded.json()["timelines"]], [texts, texts])

    def export(self, payload, snapshot):
        response = self.client.post("/start-snapshot" if snapshot else "/start-render", data=payload)
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()["job_id"]
        events = self.client.get(f"/stream-events/{job_id}").text
        self.assertNotIn('"type": "error"', events, events)
        self.assertIn('"type": "result"', events, events)
        return Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.{'png' if snapshot else 'mp4'}"

    def ffmpeg(self, *options):
        result = subprocess.run([self.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-y", *options],
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        return result.stdout


if __name__ == "__main__":
    unittest.main()
