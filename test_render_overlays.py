"""Pixel-level regressions for compact generated render overlays."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image, ImageDraw

from render_overlays import compact_overlay


def ffmpeg_for_tests():
    executable = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    resources = Path(os.environ.get("SMART_EDITOR_RESOURCES_DIR") or Path(__file__).parent)
    candidates = [os.environ.get("SMART_EDITOR_FFMPEG", "").strip(),
                  str(resources / "tools" / "ffmpeg" / "bin" / executable), shutil.which("ffmpeg")]
    return next((candidate for candidate in candidates
                 if candidate and (Path(candidate).is_file() or shutil.which(candidate))), None)


FFMPEG_BIN = ffmpeg_for_tests()


class CompactOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="render-overlay-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def assert_round_trip(self, original, expected=None):
        path = self.root / "overlay.png"
        original.save(path)
        bounds = compact_overlay(path)
        if expected is not None:
            self.assertEqual(bounds, expected)
        x, y, width, height = bounds
        with Image.open(path) as compact:
            self.assertEqual(compact.mode, "RGBA")
            self.assertEqual(compact.size, (width, height))
            reconstructed = Image.new("RGBA", original.size)
            # A mask here would multiply the alpha twice; direct paste copies
            # every RGBA byte, including partially transparent edge pixels.
            reconstructed.paste(compact, (x, y))
            self.assertEqual(original.tobytes(), reconstructed.tobytes())
        self.assertEqual(x % 2, 0)
        self.assertEqual(y % 2, 0)
        self.assertEqual(width % 2, 0)
        self.assertEqual(height % 2, 0)
        return bounds

    def test_off_center_semtransparent_edges_are_byte_exact(self):
        image = Image.new("RGBA", (1920, 1080))
        draw = ImageDraw.Draw(image)
        draw.rectangle((713, 501, 1020, 616), fill=(50, 150, 200, 80))
        draw.ellipse((741, 525, 994, 614), fill=(230, 190, 20, 255))
        self.assert_round_trip(image, (710, 498, 314, 122))

    def test_transparent_canvas_becomes_safe_two_pixel_input(self):
        self.assert_round_trip(Image.new("RGBA", (1920, 1080)), (0, 0, 2, 2))

    def test_single_pixel_at_bottom_right_preserves_origin(self):
        image = Image.new("RGBA", (1920, 1080))
        image.putpixel((1919, 1079), (12, 240, 60, 1))
        self.assert_round_trip(image, (1916, 1076, 4, 4))

    def test_full_canvas_remains_unchanged(self):
        self.assert_round_trip(Image.new("RGBA", (1920, 1080), (12, 23, 34, 128)), (0, 0, 1920, 1080))

    def test_odd_input_extends_transparently_to_chroma_boundary(self):
        image = Image.new("RGBA", (11, 9))
        image.putpixel((10, 8), (40, 50, 60, 127))
        self.assert_round_trip(image, (8, 6, 4, 4))

    def test_rotation_and_antialiasing_are_not_resampled(self):
        glyph = Image.new("RGBA", (320, 160))
        ImageDraw.Draw(glyph).text((40, 30), "Text + sticker", fill=(255, 180, 30, 200), stroke_width=2)
        rotated = glyph.rotate(23, resample=Image.Resampling.BICUBIC, expand=True)
        image = Image.new("RGBA", (1920, 1080))
        image.paste(rotated, (613, 321))
        self.assert_round_trip(image)

    @unittest.skipUnless(FFMPEG_BIN, "FFmpeg is required for raw overlay comparison")
    def test_ffmpeg_overlay_has_identical_raw_frames(self):
        original = Image.new("RGBA", (1920, 1080))
        draw = ImageDraw.Draw(original)
        draw.rectangle((713, 501, 1020, 616), fill=(50, 150, 200, 80))
        draw.ellipse((741, 525, 994, 614), fill=(230, 190, 20, 255))
        ImageDraw.Draw(original).text((903, 603), "1080p sticker", fill=(255, 255, 255, 255), stroke_width=2)
        full_path, compact_path = self.root / "full.png", self.root / "compact.png"
        original.save(full_path)
        original.save(compact_path)
        x, y, _, _ = compact_overlay(compact_path)

        def frames(path, overlay_x, overlay_y):
            result = subprocess.run([
                FFMPEG_BIN, "-v", "error", "-filter_complex_threads", "1",
                "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=0.1",
                "-i", str(path), "-filter_complex",
                f"[0:v][1:v]overlay={overlay_x}:{overlay_y}:format=yuv420:repeatlast=1[outv]",
                "-map", "[outv]", "-an", "-c:v", "rawvideo", "-f", "framemd5", "-",
            ], capture_output=True, timeout=30, check=True)
            return [line for line in result.stdout.splitlines() if line and not line.startswith(b"#")]

        self.assertEqual(frames(full_path, 0, 0), frames(compact_path, x, y))


if __name__ == "__main__":
    unittest.main()
