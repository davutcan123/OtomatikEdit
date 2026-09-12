"""Ordered brush selections, shared by image and video export."""
import math

from PIL import Image, ImageChops, ImageDraw


def normalize_brush_strokes(raw_strokes, default_size=12):
    """Keep legacy paint strokes compatible while preserving eraser ordering."""
    result, count = [], 0
    if not isinstance(raw_strokes, list):
        return result
    for stroke in raw_strokes[:40]:
        if not isinstance(stroke, dict):
            continue
        operation = stroke.get("operation", "paint")
        if not isinstance(operation, str) or operation not in {"paint", "erase"}:
            raise ValueError("Geçersiz fırça işlemi")
        try:
            size = float(stroke.get("size", default_size))
        except (TypeError, ValueError):
            size = default_size
        if not math.isfinite(size):
            size = default_size
        points = []
        raw_points = stroke.get("points", [])
        for point in raw_points if isinstance(raw_points, list) else []:
            if count >= 180:
                break
            if not isinstance(point, dict):
                continue
            try:
                x, y = float(point.get("x", 0)), float(point.get("y", 0))
            except (TypeError, ValueError):
                continue
            if math.isfinite(x) and math.isfinite(y):
                points.append({"x": max(0., min(1., x)), "y": max(0., min(1., y))})
                count += 1
        if points:
            normalized = {"size": max(2., min(30., size)), "points": points}
            if operation == "erase":
                normalized["operation"] = "erase"
            result.append(normalized)
        if count >= 180:
            break
    return result


def brush_mask(item, width, height):
    """Rasterize round connected strokes once, not per pixel per video frame.

    Work at the preview's bounded resolution, supersampled for smooth edges.
    Erasing subtracts from the selection; remove mode inverts only at the end.
    """
    ratio = max(.15, min(6., height / max(1, width)))
    w, h, supersample = 640, max(96, round(640 * ratio)), 2
    selection = Image.new("L", (w * supersample, h * supersample), 0)
    draw = ImageDraw.Draw(selection)
    for stroke in item.get("brushStrokes", []):
        points = [(p["x"] * w * supersample, p["y"] * h * supersample)
                  for p in stroke.get("points", [])]
        if not points:
            continue
        diameter = max(2., min(w, h) * stroke.get("size", 12) / 100) * supersample
        radius = diameter / 2
        color = 0 if stroke.get("operation") == "erase" else 255
        if len(points) > 1:
            draw.line(points, fill=color, width=round(diameter), joint="curve")
        for x, y in points:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
    selection = selection.resize((w, h), Image.Resampling.LANCZOS)
    if item.get("brushMode", "keep") == "remove":
        selection = ImageChops.invert(selection)
    return selection


def create_brushed_image(source_path, output_path, item):
    """Preserve source transparency, including after erase/repaint operations."""
    with Image.open(source_path) as source:
        if getattr(source, "is_animated", False):
            return False  # Animated GIF/WebP must keep their original frames.
        rgba = source.convert("RGBA")
        mask = brush_mask(item, *rgba.size).resize(rgba.size, Image.Resampling.LANCZOS)
        rgba.putalpha(ImageChops.multiply(rgba.getchannel("A"), mask))
        rgba.save(output_path, "PNG")
        return True


def brush_video_filter(mask_index, label, fps):
    """Insert a cached selection mask into an existing RGBA filter chain."""
    return (
        f"[{label}raw];[{mask_index}:v]format=gray,loop=loop=-1:size=1:start=0,"
        f"setpts=N/({fps}*TB)[{label}mask];"
        f"[{label}mask][{label}raw]scale2ref=w=iw:h=ih:eval=frame"
        f"[{label}scaled][{label}ref];"
        f"[{label}ref]split=2[{label}rgb][{label}alpha0];"
        f"[{label}alpha0]alphaextract[{label}alpha];"
        f"[{label}alpha][{label}scaled]blend=all_mode=multiply:shortest=1[{label}combined];"
        f"[{label}rgb][{label}combined]alphamerge=shortest=1,format=rgba"
    )
