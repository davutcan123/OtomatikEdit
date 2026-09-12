"""Endpoint regression: real CPU output after bounded synthetic encoder failures.

No NVIDIA device is required. Only the failing FFmpeg attempt is synthetic;
the fallback invokes the real subprocess, then FFprobe verifies its output.
All media, state and output are confined to this test's temporary directory.
"""
import asyncio
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import render_encoder
from render_encoder import EncoderChoice, nvenc_h264_args
from render_resources import GIB, MemoryInfo, choose_render_resources


class FailedMediaProcess:
    def __init__(self, code, diagnostic):
        self.returncode = code
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(diagnostic.encode("utf-8"))
        self.stderr.feed_eof()

    async def wait(self):
        return self.returncode


class RenderExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="render-execution-")
        cls.addClassCleanup(cls.temporary.cleanup)
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "render-execution-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
        }):
            spec = importlib.util.spec_from_file_location("render_execution_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)
        if not shutil.which(cls.backend.FFMPEG_BIN) or not shutil.which(cls.backend.FFPROBE_BIN):
            raise unittest.SkipTest("FFmpeg and FFprobe are required for render execution tests")
        cls.headers = {"X-Desktop-Token": "render-execution-test"}
        cls.file_id = "source-red.mp4"
        cls.second_id = "source-blue.mp4"
        for file_id, color in [(cls.file_id, "red"), (cls.second_id, "blue")]:
            subprocess.run([
                cls.backend.FFMPEG_BIN, "-v", "error", "-nostdin", "-y",
                "-f", "lavfi", "-i", f"color={color}:s=320x180:r=30:d=5",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
                "-c:v", "libx264", "-threads:v", "2", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", str(Path(cls.backend.UPLOAD_DIR) / file_id),
            ], check=True, timeout=30, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    @staticmethod
    def strong_policy(width, height, **options):
        # Deterministic on low-memory CI hosts; a forced fallback still sees
        # the real explicit low-memory override supplied by the application.
        options.setdefault("environ", {})
        return choose_render_resources(width, height, **options,
                                       memory=MemoryInfo(32 * GIB, 24 * GIB, "test"), cpu_count=16)

    def render(self, *, failures=(), hardware=True, quality="high", clips=None,
               request_hardware="auto", selector=None, initial_low_memory=False):
        commands = []
        actual_process = self.backend.create_media_process
        failures = list(failures)

        async def intercept(*args, **kwargs):
            if "[outv]" in args:
                commands.append(tuple(args))
                if len(commands) <= len(failures):
                    code, diagnostic = failures[len(commands) - 1]
                    return FailedMediaProcess(code, diagnostic)
            return await actual_process(*args, **kwargs)

        def resource_policy(width, height, **options):
            if initial_low_memory:
                options.setdefault("environ", {"SMART_EDITOR_LOW_MEMORY_RENDER": "1"})
            return self.strong_policy(width, height, **options)

        choice = EncoderChoice("h264_nvenc", nvenc_h264_args(quality), True) if hardware else EncoderChoice("libx264", (), False)
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"SMART_EDITOR_LOW_MEMORY_RENDER": "0", "SMART_EDITOR_RENDER_THREADS": "8"}))
            stack.enter_context(patch.object(self.backend, "create_media_process", side_effect=intercept))
            stack.enter_context(patch.object(self.backend, "choose_render_resources", side_effect=resource_policy))
            selected = stack.enter_context(patch.object(self.backend, "select_video_encoder",
                                                        side_effect=selector, return_value=choice))
            invalidated = stack.enter_context(patch.object(self.backend, "invalidate_nvenc"))
            with TestClient(self.backend.app) as client:
                response = client.post("/start-render", headers=self.headers, data={
                    "file_id": self.file_id, "segments": json.dumps(clips or [{
                        "fileId": self.file_id, "start": 1, "end": 1.6,
                    }]), "width": "320", "height": "180", "fps": "30",
                    "fmt": "mp4", "quality": quality, "hardware": request_hardware,
                })
                self.assertEqual(response.status_code, 200, response.text)
                job_id = response.json()["job_id"]
                response = client.get("/stream-events/" + job_id, headers=self.headers)
                messages = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            return {"commands": commands, "messages": messages, "job_id": job_id,
                    "invalidations": invalidated.call_count, "selection": selected.call_args}

    @staticmethod
    def option(command, flag):
        return command[command.index(flag) + 1]

    def assert_successful_cpu_output(self, result, duration=.6):
        self.assertFalse([message for message in result["messages"] if message.get("type") == "error"], result["messages"])
        self.assertEqual([message.get("download_url") for message in result["messages"] if message.get("type") == "result"],
                         [f"/download/{result['job_id']}/mp4"])
        output = Path(self.backend.OUTPUT_DIR) / f"out_{result['job_id']}.mp4"
        media = json.loads(subprocess.check_output([
            self.backend.FFPROBE_BIN, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output),
        ], timeout=15))
        video = next(stream for stream in media["streams"] if stream["codec_type"] == "video")
        audio = next(stream for stream in media["streams"] if stream["codec_type"] == "audio")
        self.assertEqual(video["codec_name"], "h264")
        self.assertEqual(video["pix_fmt"], "yuv420p")
        self.assertEqual((video["width"], video["height"], video["r_frame_rate"]), (320, 180, "30/1"))
        self.assertEqual(audio["codec_name"], "aac")
        self.assertEqual(audio["channels"], 2)
        self.assertAlmostEqual(float(media["format"]["duration"]), duration, delta=.08)

    def test_nvenc_failure_retries_once_to_real_compatible_cpu_output(self):
        result = self.render(failures=[(1, "[h264_nvenc] OpenEncodeSessionEx failed: out of memory (10)\nConversion failed!\n")])
        first, second = result["commands"]
        self.assertEqual(self.option(first, "-c:v"), "h264_nvenc")
        self.assertEqual(self.option(first, "-cq"), "18")
        self.assertEqual(self.option(second, "-c:v"), "libx264")
        self.assertEqual(self.option(second, "-crf"), "18")
        self.assertEqual(self.option(second, "-preset"), "faster" if os.name == "nt" else "slow")
        self.assertEqual(first[-1], second[-1], "A fallback must retain the same job/output")
        self.assertEqual(result["invalidations"], 1)
        self.assertEqual(self.backend.jobs[result["job_id"]]["quality"], "high")
        self.assert_successful_cpu_output(result)

    def test_storage_or_filter_errors_do_not_retry_cpu(self):
        for diagnostic in ["No space left on device", "Permission denied", "No such filter: invalid_filter"]:
            with self.subTest(diagnostic=diagnostic):
                result = self.render(failures=[(1, f"[h264_nvenc] using codec\n{diagnostic}\nConversion failed!\n")])
                self.assertEqual(len(result["commands"]), 1)
                self.assertEqual(result["invalidations"], 0)
                self.assertTrue(any(message.get("type") == "error" for message in result["messages"]))
                self.assertFalse(any(message.get("type") == "result" for message in result["messages"]))

    def test_memory_failure_retries_once_with_safe_threads_and_same_quality(self):
        for code in [-12, 4294967284]:
            with self.subTest(code=code):
                result = self.render(hardware=False, failures=[(code, "Conversion failed!\n")])
                first, second = result["commands"]
                self.assertEqual(self.option(first, "-threads:v"), "8")
                self.assertEqual(self.option(second, "-threads:v"), "2")
                self.assertEqual(self.option(second, "-threads"), "1")
                self.assertEqual(self.option(second, "-filter_complex_threads"), "1")
                self.assertEqual(self.option(first, "-crf"), self.option(second, "-crf"))
                self.assertEqual(self.option(second, "-crf"), "18")
                self.assertEqual(first[-1], second[-1])
                self.assertEqual(result["invalidations"], 0)
                self.assert_successful_cpu_output(result)

    def test_repeated_memory_failure_stops_after_single_safe_retry(self):
        result = self.render(hardware=False, failures=[(-12, "Cannot allocate memory\n")] * 2)
        self.assertEqual(len(result["commands"]), 2)
        self.assertTrue(any(message.get("type") == "error" for message in result["messages"]))
        self.assertFalse(any(message.get("type") == "result" for message in result["messages"]))

    def test_already_protective_gpu_memory_failure_still_gets_one_cpu_retry(self):
        result = self.render(initial_low_memory=True, failures=[(-12, "Cannot allocate memory\n")])
        first, second = result["commands"]
        self.assertEqual(self.option(first, "-c:v"), "h264_nvenc")
        self.assertEqual(self.option(second, "-c:v"), "libx264")
        for command in (first, second):
            self.assertEqual(self.option(command, "-threads:v"), "2")
            self.assertEqual(self.option(command, "-threads"), "1")
            self.assertEqual(self.option(command, "-filter_complex_threads"), "1")
        self.assertEqual(first[-1], second[-1])
        self.assert_successful_cpu_output(result)

    def test_original_source_trims_preserve_audio_timing_and_bounded_decoders(self):
        clips = [{"fileId": self.file_id, "start": 3, "end": 3.6},
                 {"fileId": self.file_id, "start": 1, "end": 1.5},
                 {"fileId": self.second_id, "start": 2, "end": 2.4}]
        result = self.render(hardware=False, clips=clips)
        self.assertEqual(len(result["commands"]), 1)
        command = result["commands"][0]
        groups = []
        previous = 0
        for index, value in enumerate(command):
            if value == "-i":
                groups.append((command[index + 1], command[previous:index]))
                previous = index + 2
        self.assertEqual(len(groups), 2, "Repeated clips from one asset share one decoder")
        inputs = {Path(file).name: options for file, options in groups}
        for name in (self.file_id, self.second_id):
            options = inputs[name]
            # Normal renders intentionally retain compressed-audio priming;
            # only graph trims, not demux input seeks, define source ranges.
            self.assertNotIn("-ss", options)
            self.assertNotIn("-t", options)
            self.assertEqual(self.option(options, "-threads"), "2")
        graph = (Path(self.backend.OUTPUT_DIR) / f"filter_{result['job_id']}.txt")
        # Resolve whichever script-option spelling the installed FFmpeg accepts.
        script = next((Path(command[index + 1]) for index, item in enumerate(command)
                       if item in {"-filter_complex_script", "-/filter_complex"}), graph)
        text = script.read_text()
        expected_trims = [(3.0, 3.6), (1.0, 1.5), (2.0, 2.4)]
        for pattern in [r"(?<!a)trim=start=([\d.]+):end=([\d.]+)", r"atrim=start=([\d.]+):end=([\d.]+)"]:
            self.assertEqual([tuple(map(float, pair)) for pair in re.findall(pattern, text)], expected_trims)
        self.assert_successful_cpu_output(result, duration=1.5)
        output = Path(self.backend.OUTPUT_DIR) / f"out_{result['job_id']}.mp4"
        colors = subprocess.check_output([
            self.backend.FFMPEG_BIN, "-v", "error", "-i", str(output), "-an",
            "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ], timeout=15)
        self.assertEqual(len(colors), 45 * 3)
        for frame in range(45):
            red, _, blue = colors[frame * 3:frame * 3 + 3]
            if frame < 33:
                self.assertGreater(red, blue + 100, f"Source A frame missing at output frame {frame}")
            else:
                self.assertGreater(blue, red + 100, f"Source B frame missing at output frame {frame}")

    def test_cpu_choice_skips_gpu_probe_even_on_windows(self):
        def cpu_selector(*args, **kwargs):
            return render_encoder.select_video_encoder(*args, **kwargs, platform="win32")
        with patch.object(render_encoder, "probe_nvenc", side_effect=AssertionError("CPU mode must not probe hardware")) as probe:
            result = self.render(hardware=False, request_hardware=" CPU ", selector=cpu_selector)
        probe.assert_not_called()
        self.assertEqual(result["selection"].kwargs["hardware"], "cpu")
        self.assertEqual(self.backend.jobs[result["job_id"]]["hardware"], "cpu")
        self.assert_successful_cpu_output(result)

    def test_endpoint_rejects_unknown_hardware_before_creating_a_job(self):
        before = set(self.backend.jobs)
        with patch.object(self.backend, "select_video_encoder") as selector, TestClient(self.backend.app) as client:
            response = client.post("/start-render", headers=self.headers, data={
                "file_id": self.file_id, "segments": json.dumps([{"start": 0, "end": 1}]),
                "hardware": "nvenc; arbitrary", "fmt": "mp4",
            })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(self.backend.jobs), before)
        selector.assert_not_called()


if __name__ == "__main__":
    unittest.main()
