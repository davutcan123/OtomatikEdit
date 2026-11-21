"""Bounded, atomic workstation preferences kept alongside desktop project data."""

import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading

MAX_BYTES = 256 * 1024
TYPES = {"favorites": list, "shortcuts": dict, "savedLooks": list, "layout": dict}
MAX_SAVED_LOOKS = 64
COLOR_LIMITS = {
    "brightness": (0, 200), "contrast": (0, 200), "saturation": (0, 200),
    "temperature": (-100, 100), "exposure": (-100, 100), "tint": (-100, 100),
    "fade": (0, 100), "hue": (-180, 180), "lightness": (-100, 100),
    "shadows": (-100, 100), "highlights": (-100, 100), "relight": (-100, 100),
}
COLOR_OPTIONS = {
    "curvePreset": {"none", "soft", "strong", "lift"},
    "lut": {"none", "cinematic", "tealorange", "mono", "dream"},
}
_lock = threading.Lock()



def validate_saved_look(item):
    if not isinstance(item, dict) or set(item) != {"id", "name", "color"}:
        raise ValueError("Geçersiz kişisel görünüm.")
    identifier, name, color = item["id"], item["name"], item["color"]
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,72}", identifier):
        raise ValueError("Geçersiz görünüm kimliği.")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or re.search(r"[\x00-\x1f\x7f]", name):
        raise ValueError("Geçersiz görünüm adı.")
    if not isinstance(color, dict):
        raise ValueError("Geçersiz görünüm rengi.")
    for field, value in color.items():
        if field in COLOR_LIMITS:
            minimum, maximum = COLOR_LIMITS[field]
            if type(value) not in (int, float) or not minimum <= value <= maximum or not math.isfinite(value):
                raise ValueError("Görünüm renk ayarı sınır dışında.")
        elif field not in COLOR_OPTIONS or not isinstance(value, str) or value not in COLOR_OPTIONS[field]:
            raise ValueError("Desteklenmeyen görünüm renk ayarı.")


def validate_preference(key, value):
    if key not in TYPES or not isinstance(value, TYPES[key]):
        raise ValueError("Geçersiz stüdyo tercihi.")
    if key == "favorites" and (len(value) > 1000 or any(
        not isinstance(item, str) or len(item) > 150 or ":" not in item for item in value
    )):
        raise ValueError("Geçersiz favori listesi.")
    if key == "shortcuts" and (len(value) > 100 or any(
        not isinstance(name, str) or len(name) > 80 or
        not isinstance(chord, str) or len(chord) > 80 for name, chord in value.items()
    )):
        raise ValueError("Geçersiz kısayol listesi.")

    if key == "savedLooks":
        if len(value) > MAX_SAVED_LOOKS:
            raise ValueError("Çok fazla kişisel görünüm.")
        seen = set()
        for item in value:
            validate_saved_look(item)
            if item["id"] in seen:
                raise ValueError("Görünüm kimliği tekrarlanamaz.")
            seen.add(item["id"])


def invalid_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def read_preferences(path):
    try:
        with Path(path).open("rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return {}
        data = json.loads(raw, parse_constant=invalid_constant)
    except (OSError, ValueError, RecursionError):
        return {}
    if not isinstance(data, dict):
        return {}
    result = {}
    for key, value in data.items():
        if key == "savedLooks" and isinstance(value, list):
            recovered, seen = [], set()
            for item in value[:MAX_SAVED_LOOKS]:
                try:
                    validate_saved_look(item)
                except ValueError:
                    continue
                if item["id"] not in seen:
                    recovered.append(item)
                    seen.add(item["id"])
            result[key] = recovered
            continue
        try:
            validate_preference(key, value)
        except ValueError:
            continue
        result[key] = value
    return result


def write_preference(path, key, value):
    validate_preference(key, value)
    path = Path(path)
    with _lock:
        state = read_preferences(path)
        state[key] = value
        data = json.dumps(state, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(data) > MAX_BYTES:
            raise ValueError("Stüdyo tercihleri çok büyük.")
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".preferences-")
        draft = Path(temporary)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(draft, path)
        finally:
            draft.unlink(missing_ok=True)
