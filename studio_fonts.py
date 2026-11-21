"""Bundled, allowlisted fonts shared by the browser and Pillow renderer."""
import json
import re
from functools import lru_cache
from pathlib import Path


DEFAULT_FONT = "default"
FONT_PUBLIC_PATH = "/static/studio/fonts/"
_ID = re.compile(r"[a-z0-9]+")
_FILE = re.compile(r"[A-Za-z0-9-]+\.ttf")


def _asset_directory(resources):
    return Path(resources) / "static" / "studio" / "fonts"


@lru_cache(maxsize=4)
def _font_catalog(resources):
    with (_asset_directory(resources) / "catalog.json").open(encoding="utf-8") as source:
        entries = json.load(source)
    catalog = {}
    for item in entries:
        key, files = item["id"], item["files"]
        if not _ID.fullmatch(key) or key == DEFAULT_FONT or key in catalog:
            raise ValueError("Invalid bundled font ID")
        if "400" not in files or set(files) - {"400", "700"} or any(
            not _FILE.fullmatch(filename) for filename in files.values()
        ):
            raise ValueError(f"Invalid bundled font files for {key}")
        catalog[key] = files
    return catalog


def normalize_font_family(resources, value):
    if isinstance(value, str) and value != DEFAULT_FONT and value in _font_catalog(resources):
        return value
    return DEFAULT_FONT


def bundled_font_path(resources, family, bold):
    family = normalize_font_family(resources, family)
    if family == DEFAULT_FONT:
        return None
    files = _font_catalog(resources)[family]
    filename = files.get("700") if bold else None
    return str(_asset_directory(resources) / family / (filename or files["400"]))


@lru_cache(maxsize=4)
def font_face_css(resources):
    return "\n".join(
        f'@font-face {{font-family:"studio-font-{family}";'
        f'src:url("{FONT_PUBLIC_PATH}{family}/{filename}") format("truetype");'
        f'font-style:normal;font-weight:{weight};font-display:swap;}}'
        for family, files in _font_catalog(resources).items()
        for weight, filename in files.items()
    )
