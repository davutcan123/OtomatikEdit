import ctypes
import subprocess
import unittest
from unittest.mock import Mock, patch

import render_resources as resources
from render_resources import GIB, MemoryInfo, choose_render_resources, detect_memory


class RenderResourceTests(unittest.TestCase):
    def policy(self, **kwargs):
        defaults = {"memory": MemoryInfo(32 * GIB, 24 * GIB, "windows"), "cpu_count": 16, "environ": {}}
        defaults.update(kwargs)
        return choose_render_resources(1920, 1080, **defaults)

    def test_strong_windows_machine_is_not_forced_to_two_threads(self):
        policy = self.policy()
        self.assertFalse(policy.low_memory)
        self.assertEqual((policy.encoder_threads, policy.decoder_threads, policy.filter_threads), (8, 2, 4))
        self.assertLess(policy.estimated_memory_bytes, 12 * GIB)

    def test_explicit_low_memory_retry_is_deterministic(self):
        for value in ["1", "TRUE", " yes ", "on"]:
            with self.subTest(value=value):
                policy = self.policy(environ={"SMART_EDITOR_LOW_MEMORY_RENDER": value}, segment_count=1000)
                self.assertTrue(policy.low_memory)
                self.assertEqual((policy.encoder_threads, policy.decoder_threads, policy.filter_threads), (2, 1, 1))

    def test_false_really_disables_low_memory_mode_but_retains_safety_limits(self):
        for value in ["0", "false", "NO", "off"]:
            with self.subTest(value=value):
                policy = self.policy(environ={"SMART_EDITOR_LOW_MEMORY_RENDER": value})
                self.assertFalse(policy.low_memory)
                self.assertEqual(policy.encoder_threads, 8)
                pressured = self.policy(memory=MemoryInfo(32 * GIB, GIB, "windows"),
                                        environ={"SMART_EDITOR_LOW_MEMORY_RENDER": value})
                self.assertFalse(pressured.low_memory)
                self.assertLessEqual(pressured.encoder_threads, 2)
                self.assertEqual((pressured.decoder_threads, pressured.filter_threads), (1, 1))

    def test_available_memory_not_just_installed_ram_controls_pressure(self):
        policy = self.policy(memory=MemoryInfo(32 * GIB, 2 * GIB, "windows"))
        self.assertTrue(policy.low_memory)
        self.assertLessEqual(policy.encoder_threads, 2)
        self.assertEqual(policy.decoder_threads, 1)
        self.assertIn("3 GB", policy.reason)

    def test_missing_and_zero_available_memory_are_conservative(self):
        for memory in [MemoryInfo(), MemoryInfo(32 * GIB, None), MemoryInfo(32 * GIB, 0)]:
            with self.subTest(memory=memory):
                policy = self.policy(memory=memory)
                self.assertTrue(policy.low_memory)
                self.assertLessEqual(policy.encoder_threads, 2)
                self.assertEqual((policy.decoder_threads, policy.filter_threads), (1, 1))
        self.assertEqual(self.policy(memory=MemoryInfo(32 * GIB, 0)).available_memory_bytes, 0)

    def test_explicit_thread_limit_never_enables_unbounded_auto_threads(self):
        for value, maximum in [("1", 1), ("4", 4), ("0", 1), ("-2", 1), ("9999", 8), ("broken", 8)]:
            with self.subTest(value=value):
                policy = self.policy(environ={"SMART_EDITOR_RENDER_THREADS": value})
                for count in [policy.encoder_threads, policy.decoder_threads, policy.filter_threads]:
                    self.assertGreaterEqual(count, 1)
                    self.assertLessEqual(count, maximum)
        policy = self.policy(environ={"SMART_EDITOR_LOW_MEMORY_RENDER": "1", "SMART_EDITOR_RENDER_THREADS": "1"})
        self.assertEqual((policy.encoder_threads, policy.decoder_threads, policy.filter_threads), (1, 1, 1))

    def test_many_inputs_bound_per_decoder_parallelism(self):
        policy = self.policy(video_input_count=8)
        self.assertEqual(policy.decoder_threads, 1)
        self.assertLessEqual(policy.encoder_threads, 8)

    def test_segment_count_counts_even_when_source_file_is_shared(self):
        small = self.policy(segment_count=1)
        many = self.policy(segment_count=180, heavy_filter_graph=True)
        self.assertTrue(many.low_memory)
        self.assertLess(many.encoder_threads, small.encoder_threads)
        self.assertGreater(many.estimated_memory_bytes, small.estimated_memory_bytes)

    def test_4k_layered_graph_is_more_conservative_than_plain_1080p(self):
        plain = self.policy()
        large = choose_render_resources(3840, 2160, memory=MemoryInfo(32 * GIB, 12 * GIB), cpu_count=16,
                                        environ={}, video_input_count=4, overlay_input_count=8,
                                        segment_count=12, heavy_filter_graph=True)
        self.assertTrue(large.low_memory)
        self.assertLess(large.encoder_threads, plain.encoder_threads)
        self.assertEqual(large.filter_threads, 1)

    def test_cpu_capacity_limits_threads(self):
        for cpus in [1, 2, 4, 256]:
            with self.subTest(cpus=cpus):
                policy = self.policy(cpu_count=cpus)
                self.assertLessEqual(policy.encoder_threads, min(cpus, 8))
                self.assertLessEqual(policy.filter_threads, min(cpus, 4))

    def test_invalid_override_uses_adaptive_default(self):
        policy = self.policy(environ={"SMART_EDITOR_LOW_MEMORY_RENDER": "invalid"})
        self.assertFalse(policy.low_memory)
        self.assertEqual(policy.encoder_threads, 8)

    def test_memory_probe_is_fresh_each_render(self):
        with patch.object(resources, "detect_memory", side_effect=[MemoryInfo(32 * GIB, 24 * GIB), MemoryInfo(32 * GIB, GIB)]):
            first = choose_render_resources(1920, 1080, cpu_count=16, environ={})
            second = choose_render_resources(1920, 1080, cpu_count=16, environ={})
        self.assertFalse(first.low_memory)
        self.assertTrue(second.low_memory)


class MemoryProbeTests(unittest.TestCase):
    def test_windows_structure_and_physical_fields(self):
        self.assertEqual(ctypes.sizeof(resources._MemoryStatusEx), 64)
        def fill(pointer):
            status = pointer._obj
            self.assertEqual(status.dwLength, 64)
            status.ullTotalPhys = 32 * GIB
            status.ullAvailPhys = 20 * GIB
            status.ullTotalPageFile = 64 * GIB
            return 1
        kernel = Mock()
        kernel.GlobalMemoryStatusEx.side_effect = fill
        with patch.object(resources.ctypes, "WinDLL", return_value=kernel, create=True):
            memory = detect_memory(platform="win32")
        self.assertEqual(memory, MemoryInfo(32 * GIB, 20 * GIB, "windows"))

    def test_windows_api_failure_degrades_without_crashing(self):
        kernel = Mock()
        kernel.GlobalMemoryStatusEx.return_value = 0
        with patch.object(resources.ctypes, "WinDLL", return_value=kernel, create=True):
            self.assertEqual(detect_memory(platform="win32"), MemoryInfo())

    def test_mac_page_size_and_no_double_counted_memory(self):
        output = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages inactive: 200.
Pages speculative: 50.
Pages purgeable: 999999.
File-backed pages: 999999.
"""
        with patch.object(resources, "_system_output", side_effect=[str(32 * GIB), output]) as command:
            memory = detect_memory(platform="darwin")
        self.assertEqual(memory.available_bytes, 350 * 16384)
        self.assertEqual(command.call_args_list[0].args[0], ["/usr/sbin/sysctl", "-n", "hw.memsize"])

    def test_mac_probe_timeout_keeps_known_total_and_conservative_policy(self):
        with patch.object(resources, "_system_output", side_effect=[str(32 * GIB), subprocess.TimeoutExpired("vm_stat", 1)]):
            memory = detect_memory(platform="darwin")
        self.assertEqual(memory.total_bytes, 32 * GIB)
        self.assertIsNone(memory.available_bytes)
        self.assertTrue(choose_render_resources(1920, 1080, memory=memory, environ={}).low_memory)

    def test_malformed_vm_stat_is_not_treated_as_abundant_memory(self):
        for output in ["garbage", "page size of 999 bytes\nPages free: 100."]:
            self.assertIsNone(resources._parse_mac_available(output))

    def test_linux_uses_memavailable_instead_of_memfree(self):
        output = "MemTotal: 33554432 kB\nMemAvailable: 16777216 kB\nMemFree: 100 kB\n"
        with patch.object(resources.Path, "read_text", return_value=output):
            self.assertEqual(detect_memory(platform="linux"), MemoryInfo(32 * GIB, 16 * GIB, "linux"))

    def test_invalid_measurements_are_sanitized(self):
        with patch.object(resources, "_read_windows_memory", return_value=MemoryInfo(8 * GIB, 100 * GIB, "windows")):
            self.assertEqual(detect_memory(platform="win32").available_bytes, 8 * GIB)
        with patch.object(resources, "_read_windows_memory", return_value=MemoryInfo(-1, -1, "windows")):
            memory = detect_memory(platform="win32")
        self.assertIsNone(memory.total_bytes)
        self.assertIsNone(memory.available_bytes)


if __name__ == "__main__":
    unittest.main()
