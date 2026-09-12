"""Losslessly compact internally generated, static RGBA overlay PNGs.

The returned origin is in the original canvas.  Bounds are expanded to even
coordinates so FFmpeg's YUV420 overlay placement does not round a glyph or
sticker to the neighboring chroma sample.  User images and animated media must
not pass through this helper.
"""

from pathlib import Path

from PIL import Image


def compact_overlay(path: str | Path) -> tuple[int, int, int, int]:
    """Crop transparent padding in place and return ``(x, y, width, height)``.

    No resampling or alpha compositing is performed.  Internally generated
    overlays have transparent black padding; pasting the result back at its
    returned origin reproduces their RGBA pixels exactly.  A fully transparent
    canvas becomes a transparent 2 x 2 PNG, safe for FFmpeg's YUV420 conversion.
    The original input is closed before writing, including on Windows.
    """
    with Image.open(path) as opened:
        overlay = opened.convert("RGBA")
    try:
        bbox = overlay.getchannel("A").getbbox()
        if bbox is None:
            with Image.new("RGBA", (2, 2), (0, 0, 0, 0)) as empty:
                empty.save(path, format="PNG")
            return 0, 0, 2, 2

        left, top, right, bottom = bbox
        # Retain a transparent chroma-filter guard.  Merely aligning the bbox
        # to 2px still changes YUV edge colors when swscale extends the crop's
        # final colored pixel instead of sampling the original transparent
        # neighbor.  Two extra pixels preserve the full-canvas conversion.
        left = max(0, (left // 2) * 2 - 2)
        top = max(0, (top // 2) * 2 - 2)
        # Generated render canvases are even-sized.  For an odd-sized caller,
        # a one-pixel transparent extension is preferable to odd chroma bounds.
        right = min(((overlay.width + 1) // 2) * 2, ((right + 1) // 2) * 2 + 2)
        bottom = min(((overlay.height + 1) // 2) * 2, ((bottom + 1) // 2) * 2 + 2)
        if (left, top, right, bottom) != (0, 0, overlay.width, overlay.height):
            with overlay.crop((left, top, right, bottom)) as cropped:
                cropped.save(path, format="PNG")
        return left, top, right - left, bottom - top
    finally:
        overlay.close()
