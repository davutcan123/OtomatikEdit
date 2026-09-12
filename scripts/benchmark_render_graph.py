"""Isolated 1080p overlay audit; no user media, settings, or project writes.

Run: ./venv/bin/python scripts/benchmark_render_graph.py
Compares full-canvas PNG looping with cropped, cached overlays at unchanged
x264 preset/CRF and verifies raw frame equality. Timings measure this machine,
not Windows performance. Use benchmark_render_versions.py for end-to-end HEAD
versus working-tree comparisons.
"""
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def run(command):
    started = time.perf_counter()
    result = subprocess.run(command, capture_output=True, check=False, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-3500:])
    return round(time.perf_counter() - started, 3)


def graph_hash(command, target):
    stop = command.index("-map")
    run(command[:stop] + ["-map", "[outv]", "-map", "[outa]", "-c:v", "rawvideo", "-c:a", "pcm_s16le",
                         "-f", "framemd5", str(target)])
    return [line for line in target.read_text().splitlines() if line and not line.startswith("#")]


def benchmark_static_overlays(backend, source, scratch, seconds):
    """Compare legacy full-canvas PNG loops with compact, decoded-once frames."""
    from render_overlays import compact_overlay

    text = backend.normalize_text_items([{"text": "1080p test", "start": 0, "end": seconds,
                                          "x": 50, "y": 80, "size": 48}], seconds)[0]
    sticker = backend.normalize_sticker_items([{"preset": "star", "start": 1, "end": seconds,
                                               "x": 80, "y": 20, "scale": 18}], seconds)[0]
    originals = [scratch / "full-text.png", scratch / "full-sticker.png"]
    backend.create_text_overlay(str(originals[0]), text, 1920, 1080)
    backend.create_sticker_overlay(str(originals[1]), sticker, 1920, 1080)
    compact_paths, positions = [], []
    for index, original in enumerate(originals):
        target = scratch / f"compact-overlay-{index}.png"
        shutil.copyfile(original, target)
        positions.append(compact_overlay(target))
        compact_paths.append(target)
    print(json.dumps({"overlay_bounds": positions}), flush=True)

    def command(paths, bounds, cached, output, raw=False):
        args = [backend.FFMPEG_BIN, "-y", "-v", "error", "-filter_complex_threads", "1",
                "-t", str(seconds), "-i", str(source)]
        for path in paths:
            args += ([] if cached else ["-loop", "1"]) + ["-framerate", "30", "-i", str(path)]
        graph = f"[0:v]trim=duration={seconds},setpts=PTS-STARTPTS[v];"
        for index in (1, 2):
            graph += (f"[{index}:v]loop=loop=-1:size=1:start=0,setpts=N/(30*TB)[ov{index}];"
                      if cached else f"[{index}:v]null[ov{index}];")
        x, y, _, _ = bounds[0]
        graph += f"[v][ov1]overlay={x}:{y}:enable='between(t,0,{seconds})'[txt];"
        x, y, _, _ = bounds[1]
        graph += f"[txt][ov2]overlay={x}:{y}:enable='between(t,1,{seconds})'[outv]"
        args += ["-filter_complex", graph, "-map", "[outv]", "-t", str(seconds), "-an"]
        args += (["-c:v", "rawvideo", "-f", "framemd5"] if raw else
                 ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads:v", "2", "-pix_fmt", "yuv420p"])
        return args + [str(output)]

    full_bounds = [(0, 0, 1920, 1080)] * 2
    original_hash = None
    for name, paths, bounds, cached in [
        ("legacy_full_png_loop", originals, full_bounds, False),
        ("full_canvas_decode_once", originals, full_bounds, True),
        ("compact_decode_once", compact_paths, positions, True),
    ]:
        elapsed = run(command(paths, bounds, cached, scratch / f"{name}.mp4"))
        digest = scratch / f"{name}.md5"
        run(command(paths, bounds, cached, digest, raw=True))
        frames = [line for line in digest.read_text().splitlines() if line and not line.startswith("#")]
        if original_hash is None:
            original_hash = frames
        print(json.dumps({"variant": name, "seconds": elapsed, "identical_raw_frames": frames == original_hash}), flush=True)


async def main(options):
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    with tempfile.TemporaryDirectory(prefix="otomatik-render-benchmark-") as temporary:
        scratch = Path(temporary)
        os.environ.update({"SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "isolated-benchmark",
                           "SMART_EDITOR_DATA_DIR": str(scratch), "SMART_EDITOR_LEGACY_DIR": "",
                           "SMART_EDITOR_LOW_MEMORY_RENDER": "1", "SMART_EDITOR_RENDER_THREADS": "2"})
        spec = importlib.util.spec_from_file_location("render_benchmark_app", root / "app.py")
        backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(backend)
        source = Path(backend.UPLOAD_DIR) / "benchmark.mp4"
        run([backend.FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
             f"testsrc2=size=1920x1080:rate=30:duration={options.source_seconds}",
             "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", str(source)])
        print(json.dumps({"platform": sys.platform, "logical_cpus": os.cpu_count(), "resolution": "1920x1080",
                          "fps": 30, "seconds": options.seconds, "source_seconds": options.source_seconds}), flush=True)
        benchmark_static_overlays(backend, source, scratch, options.seconds)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=4)
    parser.add_argument("--source-seconds", type=int, default=16)
    parser.add_argument("--overlays-only", action="store_true", help="Compare independently constructed legacy and compact overlay graphs")
    args = parser.parse_args()
    if not 2 <= args.seconds < args.source_seconds <= 120:
        parser.error("Require 2 <= seconds < source-seconds <= 120")
    asyncio.run(main(args))
