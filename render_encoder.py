"""Optional Windows NVENC encoding, with a real, short-lived capability probe.

Call ``select_video_encoder`` from a worker thread (for example asyncio.to_thread).
The caller owns the CPU branch, output pixel format/profile, audio and container
options. A hardware choice only replaces the H.264 encoder/quality arguments;
it does not move CPU filters to CUDA or claim to accelerate every render stage.
"""

from collections import OrderedDict, deque
from dataclasses import dataclass
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time


CACHE_TTL_SECONDS = 300.0
PROBE_TIMEOUT_SECONDS = 8.0
_MAX_CACHE_ENTRIES = 16
_cache = OrderedDict()
_cache_lock = threading.Lock()
_H264_CONTAINERS = frozenset({"mp4", "mov", "mkv"})


@dataclass(frozen=True)
class NvencCapability:
    supported: bool
    reason: str = ""


@dataclass(frozen=True)
class EncoderChoice:
    name: str
    args: tuple[str, ...]
    hardware: bool
    fallback_reason: str = ""


def nvenc_h264_args(quality="standard"):
    """Application quality tiers, not a claim that NVENC CQ equals x264 CRF.

    FFmpeg documents P4 as medium and P5 as good-quality; CQ in VBR mode is
    quality-targeted rather than a fixed small bitrate. Keep higher tiers more
    demanding without imposing P6/P7 or multi-pass on every normal export.
    Sources: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/nvenc_h264.c
    https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html
    """
    presets = {"draft": ("p4", 30), "standard": ("p4", 23),
               "high": ("p5", 18), "ultra": ("p5", 14)}
    if quality not in presets:
        raise ValueError("Unknown render quality")
    preset, cq = presets[quality]
    return ("-c:v", "h264_nvenc", "-preset", preset, "-tune", "hq",
            "-rc", "vbr", "-cq", str(cq), "-b:v", "0", "-multipass", "disabled")


def _ffmpeg_identity(ffmpeg_bin):
    # Resolve PATH on every lookup and notice an updated/replaced FFmpeg binary.
    executable = os.fspath(ffmpeg_bin)
    resolved = Path(shutil.which(executable) or executable).expanduser().resolve()
    try:
        stat = resolved.stat()
        fingerprint = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
    except OSError:
        fingerprint = None
    return str(resolved), fingerprint


def _remember(identity, capability):
    _cache[identity] = (time.monotonic(), capability)
    _cache.move_to_end(identity)
    while len(_cache) > _MAX_CACHE_ENTRIES:
        _cache.popitem(last=False)
    return capability


def clear_nvenc_cache():
    """Forget process-local capabilities (primarily useful in tests)."""
    with _cache_lock:
        _cache.clear()


def invalidate_nvenc(ffmpeg_bin, reason=""):
    """Temporarily avoid a GPU that failed after probing; do not retry every job."""
    identity = _ffmpeg_identity(ffmpeg_bin)
    message = " ".join(str(reason or "NVIDIA kodlayıcı kullanılamadı; işlemci kullanılacak.").split())[:200]
    with _cache_lock:
        return _remember(identity, NvencCapability(False, message))


def _error_tail(tail):
    if tail is None:
        return ""
    if isinstance(tail, bytes):
        return tail[-16384:].decode("utf-8", errors="replace").lower()
    if isinstance(tail, str):
        return tail[-16384:].lower()
    return "\n".join(_error_tail(line) for line in deque(tail, maxlen=80))[-16384:]


def is_nvenc_failure(returncode, tail):
    """Recognize hardware failures, not the mere presence of encoder statistics.

    Only call for an attempted NVENC render. Memory-pressure handling is separate;
    a generic -12/ENOMEM, bad input/filter or unwritable destination is not proof
    of a GPU failure. Driver/session messages follow FFmpeg's nvenc.c diagnostics.
    """
    if returncode in (None, 0):
        return False
    message = _error_tail(tail)
    # A CPU retry cannot repair storage permissions, a full disk or bad filters.
    if re.search(r"permission denied|access is denied|no space left on device|disk (?:is )?full|"
                 r"disk quota exceeded|no such filter|error parsing (?:a )?filter|"
                 r"no option name near|unable to parse (?:graph|filter)", message):
        return False
    if re.search(r"cannot load (?:[^\n]*[/\\])?(?:nvcuda|nvencodeapi(?:64)?|libcuda|libnvidia-encode)[^\n]*|"
                 r"(?:unknown encoder|encoder .* not found)[^\n]*h264_nvenc|"
                 r"driver does not support the required nvenc|"
                 r"minimum required nvidia driver|no (?:nvenc |cuda )?capable devices found|"
                 r"provided device doesn.t support required nvenc|"
                 r"does not support nvenc|openencodesession(?:ex)? failed|"
                 r"failed to (?:create nvenc instance|query nvenc max version)|"
                 r"cuda_error_[a-z_]+|\bcu(?:init|devicegetcount|ctxcreate)[^\n]*failed", message):
        return True
    if "nvenc" not in message:
        return False
    # NVENC API failures or unsupported device-specific encoding options. A
    # generic 'Error while opening encoder' is deliberately insufficient.
    return bool(re.search(
        r"(?:initializeencoder|encodepicture|createinputbuffer|createbitstreambuffer|"
        r"getsequenceparams|setiocudastreams) failed|"
        r"failed (?:locking|unlocking) (?:nvenc input|bitstream|input) buffer|"
        r"unsupported (?:device|rate control mode)|"
        r"(?:10 bit encode|yuv444p|b frames|lookahead|temporal aq|spatial aq) (?:is )?not supported|"
        r"(?:error setting option|unrecognized option|option not found)[^\n]*"
        r"(?:\bp[1-7]\b|\bcq\b|multipass|rc-lookahead|spatial-aq|temporal-aq)|"
        r"undefined constant[^\n]*['\"]p[1-7]['\"]", message))


def _probe_failure_reason(stderr):
    message = _error_tail(stderr)
    if "unknown encoder" in message or "encoder not found" in message:
        return "Bu FFmpeg sürümünde NVIDIA kodlayıcı yok; işlemci kullanılacak."
    if "driver" in message or "cannot load" in message or "cuda_error" in message:
        return "NVIDIA sürücüsü/kodlayıcısı hazır değil; işlemci kullanılacak."
    if "capable devices" in message or "support nvenc" in message:
        return "Kullanılabilir NVIDIA kodlayıcı bulunamadı; işlemci kullanılacak."
    return "NVIDIA kodlama denemesi başarılı olmadı; işlemci kullanılacak."


def probe_nvenc(ffmpeg_bin, *, timeout=PROBE_TIMEOUT_SECONDS):
    """Encode three synthetic 8-bit frames; cache successes and failures for 5 min.

    Checking ``ffmpeg -encoders`` alone cannot detect a missing DLL, unsupported
    driver or unavailable physical GPU. subprocess.run kills and waits for its
    child on timeout; no background probe is left holding an NVENC session.
    This low-level probe is platform-neutral; automatic selection is Windows-only.
    """
    timeout = float(timeout)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Probe timeout must be positive and finite")
    timeout = min(timeout, 15.0)
    identity = _ffmpeg_identity(ffmpeg_bin)
    # Serialize small probes so concurrent jobs cannot exhaust encoder sessions.
    with _cache_lock:
        cached = _cache.get(identity)
        if cached and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
            _cache.move_to_end(identity)
            return cached[1]
        command = [identity[0], "-hide_banner", "-loglevel", "error", "-nostdin",
                   "-f", "lavfi", "-i", "color=black:s=256x256:r=30:d=0.1",
                   "-an", "-frames:v", "3", *nvenc_h264_args("standard"),
                   "-pix_fmt", "yuv420p", "-f", "null", "-"]
        options = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                   "stderr": subprocess.PIPE, "timeout": timeout, "check": False}
        if sys.platform == "win32":
            options["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        try:
            result = subprocess.run(command, **options)
            capability = (NvencCapability(True) if result.returncode == 0 else
                          NvencCapability(False, _probe_failure_reason(result.stderr)))
        except subprocess.TimeoutExpired:
            capability = NvencCapability(False, "NVIDIA kodlama denemesi zaman aşımına uğradı; işlemci kullanılacak.")
        except OSError:
            capability = NvencCapability(False, "NVIDIA kodlama denemesi başlatılamadı; işlemci kullanılacak.")
        return _remember(identity, capability)


def select_video_encoder(ffmpeg_bin, fmt, quality="standard", *, hardware="auto", platform=None):
    """Return an optional H.264 hardware branch; empty args retain the CPU branch.

    Only actual MP4/MOV/MKV video exports are eligible. Pass the requested format,
    not the intermediate MP4 format used internally for GIF or MP3 exports.
    ``hardware='cpu'`` never starts a probe. macOS/Linux behavior is unchanged.
    """
    if hardware not in {"auto", "cpu"}:
        raise ValueError("Unknown hardware encoder preference")
    args = nvenc_h264_args(quality)
    fmt = str(fmt).lower()
    cpu_name = "libx264" if fmt in _H264_CONTAINERS else ""
    if hardware == "cpu" or (sys.platform if platform is None else platform) != "win32" or fmt not in _H264_CONTAINERS:
        return EncoderChoice(cpu_name, (), False)
    capability = probe_nvenc(ffmpeg_bin)
    if not capability.supported:
        return EncoderChoice(cpu_name, (), False, capability.reason)
    return EncoderChoice("h264_nvenc", args, True)
