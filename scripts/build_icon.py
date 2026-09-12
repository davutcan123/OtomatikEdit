"""Generate the application's geometric play/film icon; no external image assets."""
from pathlib import Path
from PIL import Image, ImageDraw

destination = Path(__file__).resolve().parents[1] / "desktop" / "assets"
destination.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((48, 48, 976, 976), radius=200, fill="#101d35")
draw.rounded_rectangle((140, 208, 884, 816), radius=96, fill="#2563eb")
for x in (206, 372, 538, 704):
    draw.rounded_rectangle((x, 248, x + 112, 294), radius=12, fill="#8dbdff")
    draw.rounded_rectangle((x, 730, x + 112, 776), radius=12, fill="#8dbdff")
draw.polygon([(414, 362), (414, 662), (670, 512)], fill="white")
image.save(destination / "icon.png")
image.save(destination / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
image.save(destination / "icon.icns")
