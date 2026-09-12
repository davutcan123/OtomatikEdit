"""Compare HEAD's full render job to the working tree with synthetic 1080p media.

Run before committing a performance change.  All generated media stay in a
temporary directory.  CPU-only encoding and identical presets/CRF are used.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import uuid

from benchmark_render_graph import graph_hash, run


async def main():
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    from render_resources import GIB, MemoryInfo, choose_render_resources

    with tempfile.TemporaryDirectory(prefix="render-version-benchmark-") as directory:
        scratch = Path(directory)
        os.environ.update({"SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DATA_DIR": directory,
                           "SMART_EDITOR_DESKTOP_TOKEN": "benchmark", "SMART_EDITOR_LEGACY_DIR": "",
                           "SMART_EDITOR_LOW_MEMORY_RENDER": "1", "SMART_EDITOR_RENDER_THREADS": "2"})
        old_code = subprocess.check_output(["git", "show", "HEAD:app.py"], cwd=root, text=True)
        old = types.ModuleType("render_before")
        old.__file__ = str(root / "app.py")
        exec(compile(old_code, old.__file__, "exec"), old.__dict__)
        spec = importlib.util.spec_from_file_location("render_after", root / "app.py")
        current = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(current)
        source = Path(current.UPLOAD_DIR) / "benchmark.mp4"
        run([current.FFMPEG_BIN, "-y", "-v", "error", "-f", "lavfi", "-i",
             "testsrc2=size=1920x1080:rate=30:duration=16", "-f", "lavfi", "-i",
             "sine=frequency=440:sample_rate=48000:duration=16", "-c:v", "libx264", "-preset", "ultrafast",
             "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)])
        print(json.dumps({"host": sys.platform, "cpus": os.cpu_count(), "resolution": "1920x1080",
                          "fps": 30, "output_seconds": 4, "source_seconds": 16}), flush=True)

        async def render(backend, name, filters=1, encoder=2):
            if hasattr(backend, "choose_render_resources"):
                def policy(width, height, **kwargs):
                    return choose_render_resources(width, height, **kwargs,
                        environ={"SMART_EDITOR_LOW_MEMORY_RENDER": "1" if filters == 1 else "0",
                                 "SMART_EDITOR_RENDER_THREADS": str(encoder)},
                        memory=MemoryInfo(32 * GIB, 24 * GIB, "synthetic-32GB"), cpu_count=10)
                backend.choose_render_resources = policy
            captured = []
            original_create = backend.create_media_process

            async def capture(*args, **kwargs):
                captured.append(list(args))
                return await original_create(*args, **kwargs)
            backend.create_media_process = capture
            job_id = str(uuid.uuid4())
            backend.jobs[job_id] = {
                "q": asyncio.Queue(), "format": "mp4", "quality": "standard", "fps": 30, "hardware": "cpu",
                "width": 1920, "height": 1080, "source_width": 1920, "source_height": 1080,
                "file_id": source.name, "filepath": str(source),
                "segments": [{"fileId": source.name, "start": 12, "end": 14, "timelineStart": 0, "fit": "contain"},
                             {"fileId": source.name, "start": 14, "end": 16, "timelineStart": 2, "fit": "contain"}],
                "transitions": [], "images": [], "audio_layers": [],
                "video_inputs": [{"fileId": source.name, "path": str(source), "hasAudio": True}],
                "texts": backend.normalize_text_items([{"text": "1080p test", "start": 0, "end": 4,
                                                          "x": 50, "y": 80, "size": 48}], 4),
                "stickers": backend.normalize_sticker_items([{"preset": "star", "start": 1, "end": 4,
                                                                "x": 80, "y": 20, "scale": 18}], 4),
            }
            start = time.perf_counter()
            await backend.run_render_job(job_id)
            elapsed = round(time.perf_counter() - start, 3)
            while not backend.jobs[job_id]["q"].empty():
                message = backend.jobs[job_id]["q"].get_nowait()
                if message and message.get("type") == "error":
                    raise RuntimeError(message)
            backend.create_media_process = original_create
            command = captured[-1]
            print(json.dumps({"variant": name, "seconds": elapsed,
                              "filter_threads": command[command.index("-filter_complex_threads") + 1],
                              "encoder_threads": command[command.index("-threads:v") + 1]}), flush=True)
            frame_hashes = graph_hash(command, scratch / (name + ".md5"))
            # Input seeking can change PCM packet boundaries without changing
            # any sound samples. Compare the continuous PCM byte stream too.
            script_index = next(index + 1 for index, value in enumerate(command)
                                if value in {"-filter_complex_script", "-/filter_complex"})
            audio_graph = scratch / (name + "-audio.txt")
            audio_graph.write_text(Path(command[script_index]).read_text() + ";\n[outv]nullsink")
            audio_command = command[:command.index("-map")]
            audio_command[script_index] = str(audio_graph)
            raw_audio = scratch / (name + ".pcm")
            run(audio_command + ["-map", "[outa]", "-c:a", "pcm_s16le", "-f", "s16le", str(raw_audio)])
            return frame_hashes, raw_audio.read_bytes()

        before = await render(old, "head_windows_2encoder_1filter")
        same_policy = await render(current, "current_2encoder_1filter")
        video_frames = lambda result: [line for line in result[0] if line.startswith("0,")]
        print(json.dumps({"same_policy_raw_video_frames_identical": video_frames(same_policy) == video_frames(before),
                          "same_policy_continuous_pcm_identical": same_policy[1] == before[1]}), flush=True)
        adaptive = await render(current, "current_32GB_8encoder_4filter", filters=4, encoder=8)
        print(json.dumps({"adaptive_raw_video_frames_identical": video_frames(adaptive) == video_frames(before),
                          "adaptive_continuous_pcm_identical": adaptive[1] == before[1]}), flush=True)
        if adaptive[0] != before[0]:
            for kind in ("0", "1"):
                print(json.dumps({"stream": kind, "identical": [x for x in before[0] if x.startswith(kind + ",")] ==
                                  [x for x in adaptive[0] if x.startswith(kind + ",")]}), flush=True)
        if adaptive[1] != before[1]:
            print(json.dumps({"before_pcm_bytes": len(before[1]), "after_pcm_bytes": len(adaptive[1]),
                              "different_bytes": sum(a != b for a, b in zip(before[1], adaptive[1]))}), flush=True)
        assert video_frames(same_policy) == video_frames(before), "Same-policy video content changed"
        assert video_frames(adaptive) == video_frames(before), "Adaptive-policy video content changed"
        assert same_policy[1] == before[1], "Same-policy PCM audio content changed"
        assert adaptive[1] == before[1], "Adaptive-policy PCM audio content changed"


if __name__ == "__main__":
    asyncio.run(main())
