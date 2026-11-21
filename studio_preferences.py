"""Bounded, atomic workstation preferences kept alongside desktop project data."""

import json
import os
from pathlib import Path
import tempfile
import threading

MAX_BYTES = 256 * 1024
TYPES = {"favorites": list, "shortcuts": dict, "savedLooks": list, "layout": dict}
_lock = threading.Lock()


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
