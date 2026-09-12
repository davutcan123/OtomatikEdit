"""Bounded, per-render CPU policy; OS memory probes use only the standard library.

This is a scheduling heuristic, not a promise that an arbitrary FFmpeg graph
fits in RAM. Always set the returned input and output limits explicitly; zero
would ask FFmpeg to choose an unbounded number of threads per input.
"""
from dataclasses import dataclass
import ctypes
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping


GIB = 1024 ** 3
MIB = 1024 ** 2


@dataclass(frozen=True)
class MemoryInfo:
    total_bytes: int | None = None
    available_bytes: int | None = None
    source: str = "unavailable"


@dataclass(frozen=True)
class RenderResourcePolicy:
    low_memory: bool
    encoder_threads: int
    decoder_threads: int
    filter_threads: int
    reason: str
    total_memory_bytes: int | None
    available_memory_bytes: int | None
    estimated_memory_bytes: int


class _MemoryStatusEx(ctypes.Structure):
    # DWORD is always 32-bit on Windows, unlike c_ulong on some Unix hosts.
    _fields_ = [
        ("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
        ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
        ("ullAvailExtendedVirtual", ctypes.c_uint64),
    ]


def _read_windows_memory() -> MemoryInfo:
    status = _MemoryStatusEx()
    status.dwLength = ctypes.sizeof(status)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    query = kernel.GlobalMemoryStatusEx
    query.argtypes = [ctypes.POINTER(_MemoryStatusEx)]
    query.restype = ctypes.c_int
    if not query(ctypes.byref(status)):
        raise OSError("GlobalMemoryStatusEx failed")
    return MemoryInfo(status.ullTotalPhys, status.ullAvailPhys, "windows")


def _system_output(arguments: list[str]) -> str:
    # Fixed OS binaries, no shell or user-supplied arguments; never wait on a
    # platform probe long enough to hold up an export or application shutdown.
    return subprocess.check_output(arguments, text=True, encoding="utf-8",
                                   errors="replace", stderr=subprocess.DEVNULL, timeout=1)


def _parse_mac_available(output: str) -> int | None:
    page_match = re.search(r"page size of (\d+) bytes", output)
    if not page_match:
        return None
    page_size = int(page_match[1])
    if page_size not in {4096, 8192, 16384, 65536}:
        return None
    counts = dict(re.findall(r"^(Pages (?:free|inactive|speculative)):\s*(\d+)\.\s*$",
                             output, re.MULTILINE))
    if "Pages free" not in counts or "Pages inactive" not in counts:
        return None
    # vm_stat prints free excluding speculative pages. Inactive memory is an
    # estimate of reclaimable capacity; the policy spends at most half of it.
    # Do not add purgeable/file-backed again: those overlap other page counts.
    return page_size * sum(int(value) for value in counts.values())


def _read_mac_memory() -> MemoryInfo:
    total = int(_system_output(["/usr/sbin/sysctl", "-n", "hw.memsize"]).strip())
    try:
        available = _parse_mac_available(_system_output(["/usr/bin/vm_stat"]))
    except (OSError, subprocess.SubprocessError, ValueError):
        available = None
    return MemoryInfo(total, available, "macos")


def _read_linux_memory() -> MemoryInfo:
    values = dict(re.findall(r"^(MemTotal|MemAvailable|MemFree):\s*(\d+)\s+kB\s*$",
                            Path("/proc/meminfo").read_text(encoding="ascii"), re.MULTILINE))
    total = int(values["MemTotal"]) * 1024 if "MemTotal" in values else None
    # On older kernels MemFree underestimates capacity, which is a safe fallback.
    available = values.get("MemAvailable", values.get("MemFree"))
    return MemoryInfo(total, int(available) * 1024 if available is not None else None, "linux")


def _clean_memory(memory: MemoryInfo) -> MemoryInfo:
    total = memory.total_bytes
    available = memory.available_bytes
    if not isinstance(total, int) or isinstance(total, bool) or total <= 0:
        total = None
    if not isinstance(available, int) or isinstance(available, bool) or available < 0:
        available = None
    if total is not None and available is not None:
        available = min(total, available)
    return MemoryInfo(total, available, memory.source)


def detect_memory(*, platform: str | None = None) -> MemoryInfo:
    """Read fresh RAM capacity; failures must degrade, never fail a render."""
    platform = sys.platform if platform is None else platform
    try:
        if platform == "win32":
            return _clean_memory(_read_windows_memory())
        if platform == "darwin":
            return _clean_memory(_read_mac_memory())
        if platform.startswith("linux"):
            return _clean_memory(_read_linux_memory())
    except (OSError, subprocess.SubprocessError, AttributeError, ValueError, TypeError):
        pass
    return MemoryInfo()


def _cpu_capacity() -> int:
    count = os.cpu_count() or 1
    try:
        count = min(count, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        pass
    return max(1, count)


def _positive_integer(value, fallback: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError, OverflowError):
        return fallback


def choose_render_resources(width: int, height: int, *, video_input_count: int = 1,
                            overlay_input_count: int = 0, segment_count: int = 1,
                            heavy_filter_graph: bool = False,
                            environ: Mapping[str, str] | None = None,
                            memory: MemoryInfo | None = None,
                            cpu_count: int | None = None) -> RenderResourcePolicy:
    """Return explicit bounded thread counts for this graph and current memory.

    SMART_EDITOR_LOW_MEMORY_RENDER true forces the old conservative 2/1/1
    encoder/decoder/filter configuration; false disables that mode, but cannot
    disable hard safety bounds. SMART_EDITOR_RENDER_THREADS is an upper limit
    for every returned thread count, not an instruction to oversubscribe CPUs.
    """
    env = os.environ if environ is None else environ
    memory = _clean_memory(detect_memory() if memory is None else memory)
    cpus = _cpu_capacity() if cpu_count is None else _positive_integer(cpu_count, 1)
    width, height = _positive_integer(width, 1920), _positive_integer(height, 1080)
    videos = _positive_integer(video_input_count, 1)
    overlays = max(0, _positive_integer(overlay_input_count, 1) if overlay_input_count else 0)
    segments = _positive_integer(segment_count, 1)

    override = str(env.get("SMART_EDITOR_LOW_MEMORY_RENDER", "")).strip().lower()
    forced_low = override in {"1", "true", "yes", "on"}
    forced_normal = override in {"0", "false", "no", "off"}
    requested_threads = str(env.get("SMART_EDITOR_RENDER_THREADS", "")).strip()
    try:
        thread_limit = max(1, min(8, int(requested_threads))) if requested_threads else 8
    except (TypeError, ValueError, OverflowError):
        thread_limit = 8

    known = memory.total_bytes is not None and memory.available_bytes is not None
    total = memory.total_bytes if memory.total_bytes is not None else 4 * GIB
    available = memory.available_bytes if memory.available_bytes is not None else min(total // 4, 2 * GIB)
    budget = min(available // 2, total * 3 // 8)
    # Conservative planning units for decoded surfaces, RGBA filter buffers,
    # overlays and queued segment branches. Counts are not duration-dependent.
    frame = width * height * 8
    base = 256 * MIB + frame * (8 * videos + 3 * overlays + 4 * segments + (24 if heavy_filter_graph else 8))
    pressure = not known or available < 3 * GIB or total < 8 * GIB or base > budget * 3 // 4
    low_memory = forced_low or (pressure and not forced_normal)
    reasons = []
    if forced_low:
        reasons.append("düşük bellek modu elle etkin")
    elif forced_normal:
        reasons.append("düşük bellek modu elle kapalı")
    if not known:
        reasons.append("bellek ölçümü eksik; güvenli sınır")
    elif available < 3 * GIB:
        reasons.append("kullanılabilir bellek 3 GB altında")
    elif pressure:
        reasons.append("çözünürlük/katman/parça sayısına göre bellek sınırı")
    else:
        reasons.append("bilgisayar kapasitesine göre uyarlanan render")

    if low_memory or pressure:
        encoder, decoder, filters = min(2, cpus), 1, 1
    else:
        encoder = min(8, max(1, cpus - 1))
        decoder = 2 if cpus >= 4 and videos <= 4 else 1
        filters = min(4, cpus)
        if videos + overlays > 24 or segments > 64:
            filters = min(filters, 2)
    encoder, decoder, filters = [min(value, thread_limit) for value in (encoder, decoder, filters)]

    def estimate() -> int:
        return base + frame * (4 * encoder + 4 * decoder * videos + (8 if heavy_filter_graph else 4) * filters)

    # Reduce parallel buffer pools first; never ask FFmpeg for automatic/zero
    # threads, including when the minimum graph itself exceeds this estimate.
    while estimate() > budget and max(encoder, decoder, filters) > 1 and not forced_low:
        if filters > 1:
            filters -= 1
        elif decoder > 1:
            decoder -= 1
        else:
            encoder -= 1
    if estimate() > budget:
        reasons.append("karmaşık grafikte asgari iş parçacıkları; güvenli yeniden deneme gerekebilir")
    return RenderResourcePolicy(low_memory, encoder, decoder, filters, "; ".join(reasons),
                                memory.total_bytes, memory.available_bytes, estimate())
