"""GPU selection must be optional, bounded and safe on machines without NVIDIA."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import render_encoder as encoder


class NvencProbeTests(unittest.TestCase):
    def setUp(self):
        encoder.clear_nvenc_cache()
        self.addCleanup(encoder.clear_nvenc_cache)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.ffmpeg = Path(self.temporary.name) / "ffmpeg.exe"
        self.ffmpeg.write_bytes(b"fake ffmpeg for mocked subprocess")
        self.run = patch.object(encoder.subprocess, "run").start()
        self.addCleanup(patch.stopall)
        self.run.return_value = subprocess.CompletedProcess([], 0, stderr=b"")

    def test_probe_encodes_frames_not_just_an_encoder_listing(self):
        result = encoder.probe_nvenc(self.ffmpeg)
        self.assertTrue(result.supported)
        command, = self.run.call_args.args
        self.assertEqual(command[0], str(self.ffmpeg.resolve()))
        self.assertIn("h264_nvenc", command)
        self.assertIn("lavfi", command)
        self.assertIn("color=black:s=256x256:r=30:d=0.1", command)
        self.assertEqual(command[command.index("-frames:v") + 1], "3")
        self.assertEqual(command[command.index("-pix_fmt") + 1], "yuv420p")
        self.assertEqual(command[-3:], ["-f", "null", "-"])
        self.assertNotIn("-encoders", command)
        options = self.run.call_args.kwargs
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["stdout"], subprocess.DEVNULL)
        self.assertEqual(options["timeout"], 8.0)
        self.assertFalse(options.get("shell", False))
        self.assertNotIn("env", options)

    def test_windows_probe_does_not_open_a_console(self):
        with patch.object(encoder.sys, "platform", "win32"):
            encoder.probe_nvenc(self.ffmpeg)
        self.assertEqual(self.run.call_args.kwargs["creationflags"], 0x08000000)

    def test_non_windows_probe_omits_windows_flags(self):
        with patch.object(encoder.sys, "platform", "darwin"):
            encoder.probe_nvenc(self.ffmpeg)
        self.assertNotIn("creationflags", self.run.call_args.kwargs)

    def test_success_and_failure_are_cached(self):
        for returncode in (0, 1):
            with self.subTest(returncode=returncode):
                encoder.clear_nvenc_cache()
                self.run.reset_mock()
                self.run.return_value = subprocess.CompletedProcess([], returncode, stderr=b"No capable devices found")
                first = encoder.probe_nvenc(self.ffmpeg)
                self.assertIs(encoder.probe_nvenc(self.ffmpeg), first)
                self.assertEqual(first.supported, returncode == 0)
                self.assertEqual(self.run.call_count, 1)

    def test_cached_probe_is_retried_after_five_minutes(self):
        with patch.object(encoder.time, "monotonic", return_value=10) as clock:
            encoder.probe_nvenc(self.ffmpeg)
            clock.return_value = 309.9
            encoder.probe_nvenc(self.ffmpeg)
            self.assertEqual(self.run.call_count, 1)
            clock.return_value = 310
            encoder.probe_nvenc(self.ffmpeg)
            self.assertEqual(self.run.call_count, 2)

    def test_binary_replacement_and_path_change_invalidate_identity(self):
        encoder.probe_nvenc(self.ffmpeg)
        self.ffmpeg.write_bytes(b"updated binary with a different size")
        encoder.probe_nvenc(self.ffmpeg)
        second = self.ffmpeg.with_name("ffmpeg-new.exe")
        second.write_bytes(b"new ffmpeg")
        with patch.object(encoder.shutil, "which", return_value=str(self.ffmpeg)) as which:
            encoder.probe_nvenc("ffmpeg")
            which.return_value = str(second)
            encoder.probe_nvenc("ffmpeg")
        self.assertEqual(self.run.call_count, 3)

    def test_timeout_falls_back_and_does_not_keep_reprobing(self):
        self.run.side_effect = subprocess.TimeoutExpired("ffmpeg", 8)
        first = encoder.probe_nvenc(self.ffmpeg)
        self.assertFalse(first.supported)
        self.assertIn("zaman aşımı", first.reason)
        self.assertIs(encoder.probe_nvenc(self.ffmpeg), first)
        self.assertEqual(self.run.call_count, 1)

    def test_probe_timeout_is_bounded_and_validated(self):
        encoder.probe_nvenc(self.ffmpeg, timeout=300)
        self.assertEqual(self.run.call_args.kwargs["timeout"], 15)
        for timeout in (0, -1, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                encoder.probe_nvenc(self.ffmpeg, timeout=timeout)

    def test_missing_executable_and_missing_gpu_have_short_friendly_reasons(self):
        self.run.side_effect = FileNotFoundError("private install path")
        result = encoder.probe_nvenc(self.ffmpeg)
        self.assertFalse(result.supported)
        self.assertNotIn("private", result.reason)
        encoder.clear_nvenc_cache()
        self.run.side_effect = None
        self.run.return_value = subprocess.CompletedProcess([], 1, stderr=b"private diagnostic " * 10000 + b"Cannot load nvcuda.dll")
        result = encoder.probe_nvenc(self.ffmpeg)
        self.assertFalse(result.supported)
        self.assertIn("sürücüsü", result.reason)
        self.assertLess(len(result.reason), 150)
        self.assertNotIn("private", result.reason)

    def test_ffmpeg_without_nvenc_is_a_cpu_choice_not_a_job_error(self):
        self.run.return_value = subprocess.CompletedProcess([], 1, stderr=b"Unknown encoder 'h264_nvenc'")
        result = encoder.select_video_encoder(self.ffmpeg, "mp4", platform="win32")
        self.assertFalse(result.hardware)
        self.assertEqual(result.args, ())
        self.assertIn("kodlayıcı yok", result.fallback_reason)

    def test_invalidation_reason_is_short_and_single_line(self):
        result = encoder.invalidate_nvenc(self.ffmpeg, "GPU unavailable\n" * 100)
        self.assertLessEqual(len(result.reason), 200)
        self.assertNotIn("\n", result.reason)
        self.assertFalse(encoder.probe_nvenc(self.ffmpeg).supported)
        self.run.assert_not_called()

    def test_failed_actual_render_suppresses_gpu_for_five_minutes(self):
        with patch.object(encoder.time, "monotonic", return_value=100) as clock:
            self.assertTrue(encoder.probe_nvenc(self.ffmpeg).supported)
            encoder.invalidate_nvenc(self.ffmpeg, "NVIDIA aygıtı meşgul; işlemci kullanılacak.")
            self.assertFalse(encoder.probe_nvenc(self.ffmpeg).supported)
            choice = encoder.select_video_encoder(self.ffmpeg, "mp4", platform="win32")
            self.assertFalse(choice.hardware)
            self.assertIn("meşgul", choice.fallback_reason)
            self.assertEqual(self.run.call_count, 1)
            clock.return_value = 400
            self.assertTrue(encoder.probe_nvenc(self.ffmpeg).supported)
            self.assertEqual(self.run.call_count, 2)

    def test_concurrent_jobs_share_one_probe(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: encoder.probe_nvenc(self.ffmpeg), range(16)))
        self.assertTrue(all(result.supported for result in results))
        self.assertEqual(self.run.call_count, 1)

    def test_cache_cannot_grow_without_bound(self):
        for number in range(30):
            encoder.probe_nvenc(self.ffmpeg.with_name(f"ffmpeg-{number}.exe"))
        self.assertLessEqual(len(encoder._cache), 16)


class EncoderSelectionTests(unittest.TestCase):
    def setUp(self):
        self.probe = patch.object(encoder, "probe_nvenc", return_value=encoder.NvencCapability(True)).start()
        self.addCleanup(patch.stopall)

    def test_only_windows_h264_exports_probe_automatically(self):
        for fmt in ("mp4", "mov", "mkv"):
            with self.subTest(fmt=fmt):
                choice = encoder.select_video_encoder("ffmpeg", fmt, "high", platform="win32")
                self.assertTrue(choice.hardware)
                self.assertEqual(choice.name, "h264_nvenc")
                self.assertEqual(choice.args, encoder.nvenc_h264_args("high"))
        self.assertEqual(self.probe.call_count, 3)

    def test_cpu_and_existing_mac_linux_other_format_paths_never_probe(self):
        cases = [("mp4", "auto", "darwin"), ("mp4", "auto", "linux"),
                 ("mp4", "cpu", "win32"), ("mov", "cpu", "win32")]
        cases.extend((fmt, "auto", "win32") for fmt in ("webm", "gif", "mp3", "png"))
        for fmt, hardware, platform in cases:
            with self.subTest(fmt=fmt, hardware=hardware, platform=platform):
                choice = encoder.select_video_encoder("ffmpeg", fmt, hardware=hardware, platform=platform)
                self.assertFalse(choice.hardware)
                self.assertEqual(choice.args, ())
        self.probe.assert_not_called()

    def test_unavailable_gpu_keeps_existing_cpu_encoding(self):
        self.probe.return_value = encoder.NvencCapability(False, "NVIDIA hazır değil")
        choice = encoder.select_video_encoder("ffmpeg", "mp4", platform="win32")
        self.assertFalse(choice.hardware)
        self.assertEqual(choice.name, "libx264")
        self.assertEqual(choice.args, ())
        self.assertEqual(choice.fallback_reason, "NVIDIA hazır değil")

    def test_quality_tiers_preserve_explicit_quality_not_a_small_bitrate_cap(self):
        tiers = [("draft", "p4", 30), ("standard", "p4", 23), ("high", "p5", 18), ("ultra", "p5", 14)]
        for quality, preset, cq in tiers:
            with self.subTest(quality=quality):
                args = encoder.nvenc_h264_args(quality)
                values = dict(zip(args[::2], args[1::2]))
                self.assertEqual(values["-c:v"], "h264_nvenc")
                self.assertEqual(values["-preset"], preset)
                self.assertEqual(values["-cq"], str(cq))
                self.assertEqual(values["-rc"], "vbr")
                self.assertEqual(values["-tune"], "hq")
                self.assertEqual(values["-b:v"], "0")
                self.assertEqual(values["-multipass"], "disabled")
                for option in ("-crf", "-x264-params", "-profile:v", "-level:v", "-pix_fmt", "-maxrate", "-c:a"):
                    self.assertNotIn(option, args)

    def test_unknown_options_are_not_passed_into_ffmpeg(self):
        with self.assertRaises(ValueError):
            encoder.select_video_encoder("ffmpeg", "mp4", hardware="nvenc; bad")
        with self.assertRaises(ValueError):
            encoder.nvenc_h264_args("unexpected")
        self.probe.assert_not_called()


class NvencFailureClassificationTests(unittest.TestCase):
    def test_hardware_errors_trigger_cpu_fallback(self):
        errors = [
            "[h264_nvenc @ 01] Cannot load nvcuda.dll",
            "[h264_nvenc @ 01] Cannot load nvEncodeAPI64.dll",
            "[h264_nvenc @ 01] Cannot load libnvidia-encode.so.1",
            "[h264_nvenc @ 01] Driver does not support the required nvenc API version. Required 13 Found 12",
            "[h264_nvenc @ 01] No capable devices found",
            "[h264_nvenc @ 01] No CUDA capable devices found",
            "[h264_nvenc @ 01] OpenEncodeSessionEx failed: unsupported device (2)",
            "[h264_nvenc @ 01] InitializeEncoder failed: invalid param (8)",
            "[h264_nvenc @ 01] EncodePicture failed!: encoder busy (18)",
            "[h264_nvenc @ 01] CreateInputBuffer failed: out of memory (10)",
            "[h264_nvenc @ 01] Provided device doesn't support required NVENC features",
            "[h264_nvenc @ 01] cuInit(0) failed -> CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected",
            "Unknown encoder 'h264_nvenc'",
            "[h264_nvenc @ 01] Error setting option preset to value p4.",
            "[h264_nvenc @ 01] Error setting option multipass to value disabled.",
            "[h264_nvenc @ 01] [Eval @ 02] Undefined constant or missing '(' in 'p5'",
            "[h264_nvenc @ 01] 10 bit encode not supported",
        ]
        for error in errors:
            with self.subTest(error=error):
                self.assertTrue(encoder.is_nvenc_failure(1, error))
                self.assertFalse(encoder.is_nvenc_failure(0, error))

    def test_generic_io_input_filter_and_stats_errors_do_not_retry(self):
        errors = [
            "Conversion failed!",
            "[h264_nvenc @ 01] kb/s:18408.83\n[aac @ 02] Qavg: 1391.312\nConversion failed!",
            "[h264_nvenc @ 01] kb/s:18408.83\nError writing trailer: No space left on device",
            "out.mp4: Permission denied\n[h264_nvenc @ 01] kb/s:1000",
            "[h264_nvenc @ 01] initialized\nNo such filter: 'bad_filter'",
            "[h264_nvenc @ 01] initialized\nError parsing a filter description around: bad",
            "[h264_nvenc @ 01] initialized\nError while opening encoder - maybe incorrect parameters",
            "Error setting option size to value nonsense",
            "[h264_nvenc @ 01] initialized\nCannot allocate memory",
            "[in#0] UDTA parsing failed retrying raw\nConversion failed!",
            "out.mp4: Access is denied\n[h264_nvenc @ 01] OpenEncodeSessionEx failed",
        ]
        for error in errors:
            with self.subTest(error=error):
                self.assertFalse(encoder.is_nvenc_failure(1, error))
        self.assertFalse(encoder.is_nvenc_failure(4294967284, "Cannot allocate memory"))
        self.assertFalse(encoder.is_nvenc_failure(None, "OpenEncodeSessionEx failed"))

    def test_tail_accepts_bytes_or_progress_lines(self):
        self.assertTrue(encoder.is_nvenc_failure(1, b"Cannot load nvEncodeAPI64.dll"))
        self.assertTrue(encoder.is_nvenc_failure(1, ["progress line", "[h264_nvenc] EncodePicture failed!"]))
        self.assertFalse(encoder.is_nvenc_failure(1, None))
        self.assertFalse(encoder.is_nvenc_failure(1, []))


if __name__ == "__main__":
    unittest.main()
