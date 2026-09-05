import os
import uuid
import re
import asyncio
import json
import concurrent.futures
import typing
import math
import mimetypes
import threading
import shutil
import multiprocessing
import time
from types import SimpleNamespace
from fastapi import FastAPI, UploadFile, File, Form, Request, HTTPException
from fastapi.responses import FileResponse, StreamingResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
WAVEFORM_DIR = os.path.join(OUTPUT_DIR, "waveforms")
PROJECT_DIR = os.path.join(BASE_DIR, "projects")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
ALLOWED_FORMATS = {"mp4", "mkv", "webm", "mov", "gif", "mp3"}
ALLOWED_QUALITIES = {"draft", "standard", "high", "ultra"}
ALLOWED_TRANSITIONS = {
    "fade", "dissolve", "smoothleft", "smoothright", "wipeleft", "pixelize",
    "zoomin", "fadeblack", "wiperight", "wipeup", "wipedown", "slideleft",
    "slideright", "slideup", "slidedown", "circlecrop", "rectcrop", "distance",
    "fadewhite", "radial", "smoothup", "smoothdown", "circleopen", "circleclose",
    "vertopen", "vertclose", "horzopen", "horzclose", "diagtl", "diagbr",
}
VIDEO_EFFECT_FILTERS = {
    "none": "",
    "vivid": "eq=contrast=1.08:saturation=1.45",
    "noir": "hue=s=0,eq=contrast=1.16",
    "warm": "colorbalance=rs=.12:gs=.04:bs=-.08,eq=saturation=1.18",
    "cool": "colorbalance=rs=-.08:bs=.12,eq=saturation=1.12",
    "blur": "gblur=sigma=3",
    "vintage": "colorbalance=rs=.15:gs=.05:bs=-.12,eq=contrast=.92:saturation=.85",
    "glitch": "hue=h=22:s=1.3,eq=contrast=1.15",
    "mirror": "hflip",
    "soft": "gblur=sigma=1.2,eq=brightness=.03:saturation=.9",
    "crisp": "unsharp=5:5:1.15:5:5:0,eq=contrast=1.08:saturation=1.08",
    "dreamy": "gblur=sigma=.7,eq=brightness=.07:contrast=.9:saturation=.82",
    "cyberpunk": "hue=h=35:s=1.45,eq=contrast=1.25:saturation=1.35",
    "amber": "colorbalance=rs=.18:gs=.07:bs=-.12,eq=saturation=1.22",
    "emerald": "hue=h=65:s=1.28,colorbalance=gs=.08:bs=-.04",
    "magenta": "hue=h=-55:s=1.35,colorbalance=rs=.08:bs=.08",
    "aqua": "hue=h=155:s=1.28,colorbalance=gs=.05:bs=.09",
    "faded": "eq=contrast=.82:brightness=.045:saturation=.7",
    "dramatic": "eq=contrast=1.42:brightness=-.035:saturation=.82",
    "bleach": "eq=contrast=1.25:brightness=.045:saturation=.38",
    "highcontrast": "eq=contrast=1.65",
    "lowcontrast": "eq=contrast=.68:brightness=.035",
    "desaturated": "eq=saturation=.38",
    "supersaturated": "eq=saturation=2",
    "sepia": "colorbalance=rs=.22:gs=.1:bs=-.18,eq=saturation=.82:contrast=1.04",
    "negative": "negate",
    "vignette": "vignette=PI/5",
    "glow": "gblur=sigma=1.1,eq=brightness=.075:saturation=1.2",
    "sharpen": "unsharp=7:7:1.8:5:5:.25",
    "softfocus": "gblur=sigma=2,eq=brightness=.05:contrast=.92",
    "icy": "colorbalance=rs=-.08:gs=.025:bs=.18,eq=saturation=.78:brightness=.025",
    "sunset": "colorbalance=rs=.2:gs=.03:bs=-.13,eq=saturation=1.32:contrast=1.05",
    "forest": "colorbalance=rs=-.08:gs=.12:bs=-.06,eq=saturation=1.15:brightness=-.015",
    "lavender": "colorbalance=rs=.08:gs=-.05:bs=.13,eq=saturation=1.05:brightness=.025",
    "bronze": "colorbalance=rs=.17:gs=.08:bs=-.15,eq=contrast=1.12:saturation=.95",
    "steel": "colorbalance=rs=-.07:gs=.02:bs=.11,eq=contrast=1.22:saturation=.5",
    "roseglow": "colorbalance=rs=.16:gs=-.04:bs=.07,eq=brightness=.04:saturation=1.2",
    "nightvision": "hue=h=75:s=2.8,eq=contrast=1.3:brightness=-.06",
    "candy": "hue=h=8:s=1.5,eq=brightness=.055:saturation=1.45",
    "monosoft": "hue=s=0,eq=contrast=.85:brightness=.035",
    "monohard": "hue=s=0,eq=contrast=1.6",
    "redshift": "colorbalance=rs=.25:gs=-.08:bs=-.14,eq=saturation=1.35",
    "blueshift": "colorbalance=rs=-.12:gs=.02:bs=.24,eq=saturation=1.3",
    "greenshift": "colorbalance=rs=-.1:gs=.22:bs=-.08,eq=saturation=1.3",
    "filmgrain": "noise=alls=7:allf=t,eq=contrast=1.08:saturation=.9",
    "haze": "eq=contrast=.72:brightness=.08:saturation=.72",
    "punch": "eq=contrast=1.35:saturation=1.4",
    "pastel": "eq=contrast=.86:saturation=.72:brightness=.055",
    "shadowboost": "eq=brightness=-.035:contrast=1.35:gamma=1.12",
    "highlightsoft": "eq=brightness=.055:contrast=.88:gamma=.94",
}
ALLOWED_VIDEO_EFFECTS = set(VIDEO_EFFECT_FILTERS)
CLIP_FILTER_FILTERS = {
    "none": "",
    "portrait": "eq=brightness=.035:contrast=.96:saturation=.9,colorbalance=rs=.035:bs=.025",
    "cinema": "eq=contrast=1.16:saturation=.82,colorbalance=rs=.045:bs=-.025",
    "summer": "eq=brightness=.045:saturation=1.25,colorbalance=rs=.09:gs=.035:bs=-.07",
    "teal": "eq=contrast=1.08:saturation=1.05,colorbalance=rs=-.075:gs=.025:bs=.11",
    "rose": "eq=brightness=.025:saturation=1.1,colorbalance=rs=.095:bs=.035",
    "matte": "eq=contrast=.88:brightness=.035:saturation=.82",
    "night": "eq=brightness=-.085:contrast=1.14:saturation=.78,colorbalance=rs=-.06:bs=.13",
    "golden": "colorbalance=rs=.14:gs=.07:bs=-.1,eq=brightness=.025:saturation=1.18",
    "arctic": "colorbalance=rs=-.08:gs=.02:bs=.15,eq=brightness=.04:saturation=.78",
    "desert": "colorbalance=rs=.16:gs=.08:bs=-.13,eq=contrast=1.08:saturation=.95",
    "ocean": "colorbalance=rs=-.1:gs=.035:bs=.17,eq=contrast=1.08:saturation=1.12",
    "forest": "colorbalance=rs=-.07:gs=.13:bs=-.06,eq=brightness=-.02:saturation=1.1",
    "lavender": "colorbalance=rs=.08:gs=-.04:bs=.12,eq=brightness=.035:saturation=.9",
    "peach": "colorbalance=rs=.12:gs=.045:bs=-.06,eq=brightness=.025:saturation=1.08",
    "mint": "colorbalance=rs=-.06:gs=.1:bs=.035,eq=brightness=.04:saturation=.88",
    "cobalt": "colorbalance=rs=-.11:gs=-.02:bs=.2,eq=contrast=1.12:saturation=1.14",
    "crimson": "colorbalance=rs=.2:gs=-.07:bs=-.05,eq=contrast=1.08:saturation=1.2",
    "amber": "colorbalance=rs=.18:gs=.08:bs=-.14,eq=saturation=1.1",
    "emerald": "colorbalance=rs=-.08:gs=.17:bs=-.05,eq=saturation=1.1",
    "violet": "colorbalance=rs=.1:gs=-.08:bs=.18,eq=saturation=1.08",
    "coral": "colorbalance=rs=.17:gs=.02:bs=-.04,eq=brightness=.025:saturation=1.15",
    "dawn": "colorbalance=rs=.1:gs=.04:bs=-.04,eq=brightness=.06:contrast=.92:saturation=.88",
    "dusk": "colorbalance=rs=.07:gs=-.04:bs=.08,eq=brightness=-.065:contrast=1.12",
    "moonlight": "colorbalance=rs=-.08:gs=-.02:bs=.15,eq=brightness=-.05:saturation=.7",
    "daylight": "eq=brightness=.045:contrast=1.04:saturation=1.06",
    "softportrait": "eq=brightness=.045:contrast=.88:saturation=.86,gblur=sigma=.35",
    "hardlight": "eq=contrast=1.42:brightness=-.015",
    "bleach": "eq=contrast=1.2:saturation=.42:brightness=.045",
    "faded": "eq=contrast=.78:saturation=.7:brightness=.035",
    "sepia": "colorbalance=rs=.2:gs=.09:bs=-.17,eq=saturation=.78",
    "mono": "hue=s=0",
    "highkey": "eq=brightness=.1:contrast=.85:saturation=.85",
    "lowkey": "eq=brightness=-.12:contrast=1.32",
    "pastel": "eq=contrast=.84:saturation=.66:brightness=.06",
    "candy": "eq=saturation=1.55:brightness=.045,colorbalance=rs=.05:bs=.04",
    "cinematicblue": "colorbalance=rs=-.08:bs=.14,eq=contrast=1.2:saturation=.78",
    "cinematicwarm": "colorbalance=rs=.12:gs=.04:bs=-.08,eq=contrast=1.18:saturation=.95",
    "documentary": "eq=contrast=1.12:saturation=.7",
    "wedding": "eq=brightness=.065:contrast=.9:saturation=.82,colorbalance=rs=.04:bs=.02",
    "food": "eq=saturation=1.32:contrast=1.08,colorbalance=rs=.07:gs=.025:bs=-.04",
    "travel": "eq=saturation=1.22:brightness=.025:contrast=1.05",
    "urban": "colorbalance=rs=-.07:bs=.08,eq=contrast=1.28:saturation=.72",
    "retro70": "colorbalance=rs=.15:gs=.07:bs=-.12,eq=contrast=.9:saturation=.82",
    "retro80": "hue=h=-45:s=1.3,eq=contrast=1.15:saturation=1.25",
    "retro90": "eq=contrast=.95:saturation=1.2:brightness=.02",
    "polaroid": "colorbalance=rs=.07:gs=.025:bs=-.035,eq=contrast=.86:brightness=.055",
    "analog": "colorbalance=rs=.1:gs=.04:bs=-.08,eq=contrast=1.08:saturation=.75",
    "chrome": "hue=s=.35,eq=contrast=1.45",
    "noirsoft": "hue=s=0,eq=contrast=.9:brightness=.035",
}
ALLOWED_CLIP_FILTERS = set(CLIP_FILTER_FILTERS)
ALLOWED_CLIP_FITS = {"cover", "contain", "stretch"}
ALLOWED_CLIP_ANIMATIONS = {
    "none", "fade", "zoom", "zoomout", "slideleft", "slideright", "slideup",
    "slidedown", "pop", "pulse", "bounce", "rotatein", "rotateout", "swing",
    "shake", "driftleft", "driftright", "driftup", "driftdown", "kenburnsleft",
    "kenburnsright", "kenburnsup", "kenburnsdown", "flipx", "flipy", "blurin",
    "blurout", "flash", "heartbeat", "cinematic", "fadein", "fadeout",
    "zoominfast", "zoomoutfast", "slideleftout", "sliderightout", "slideupout",
    "slidedownout", "spin", "spinout", "whipleft", "whipright", "rise", "drop",
    "elastic", "rubber", "wobble", "flicker", "strobe", "revealleft",
    "revealright", "revealup", "revealdown", "breathe", "float", "sway",
    "focusin", "focusout", "cinematicleft", "cinematicright",
}
CANVAS_CLIP_ANIMATIONS = {
    "slideleft", "slideright", "slideup", "slidedown", "bounce", "shake",
    "driftleft", "driftright", "driftup", "driftdown", "slideleftout",
    "sliderightout", "slideupout", "slidedownout", "revealleft", "revealright",
    "revealup", "revealdown", "whipleft", "whipright", "cinematicleft",
    "cinematicright", "rise", "drop", "float", "wobble", "sway",
    "rotatein", "rotateout", "spin", "spinout", "swing",
}
ALLOWED_BACKGROUND_MODES = {"none", "chroma", "brush"}
ALLOWED_BRUSH_MODES = {"keep", "remove"}
ALLOWED_BLEND_MODES = {"normal", "multiply", "screen", "overlay"}
ALLOWED_STABILIZATION = {"none", "light", "strong"}
ALLOWED_VOICE_CHANGERS = {"none", "deep", "chipmunk", "robot"}
ALLOWED_CHANNEL_MODES = {"stereo", "left", "right", "mono"}
ALLOWED_LUTS = {"none", "cinematic", "tealorange", "mono", "dream"}
ALLOWED_CURVES = {"none", "soft", "strong", "lift"}
ALLOWED_MASKS = {"none", "circle", "ellipse", "rounded"}
LUT_FILTERS = {
    "none": "",
    "cinematic": "eq=contrast=1.16:saturation=.82,colorbalance=rs=.045:bs=-.025",
    "tealorange": "eq=contrast=1.12:saturation=1.2,colorbalance=rs=.06:gs=-.015:bs=.07",
    "mono": "hue=s=0,eq=contrast=1.1",
    "dream": "eq=brightness=.05:contrast=.92:saturation=.82,colorbalance=rs=.06:bs=.025",
}
CURVE_FILTERS = {
    "none": "", "soft": "curves=preset=lighter", "strong": "curves=preset=strong_contrast",
    "lift": "curves=all='0/0.07 .35/.42 1/1'",
}
CORE_STICKERS = {
    "arrow", "circle", "heart", "star", "sparkle", "fire", "bolt",
    "target", "check", "party", "speech", "subscribe"
}
EXTRA_STICKER_LABELS = [
    "KAMERA", "VIDEO", "MIKROFON", "MUZIK", "KULAKLIK", "OYUN", "KUPA", "TAC", "ELMAS", "ROKET",
    "DUNYA", "GUNES", "AY", "BULUT", "YAGMUR", "KAR", "GOKKUSAGI", "CICEK", "YAPRAK", "PALMIYE",
    "KEDI", "KOPEK", "PANDA", "TILKI", "ASLAN", "KURBAGA", "KELEBEK", "ARI", "BALIK", "YUNUS",
    "GULUMSE", "KAHKAHA", "ASK", "HAVALI", "SASKIN", "AGLAYAN", "KIZGIN", "DUSUNEN", "UYKU", "PARTI",
    "BEGEN", "ALKIS", "BARIS", "GUC", "DUA", "ISARET", "YUKARI", "ASAGI", "SOL", "DONGU",
    "SORU", "UNLEM", "BILGI", "YASAK", "DIKKAT", "YENI", "SICAK", "BEDAVA", "INDIRIM", "HEDIYE",
    "ABONE", "BEGENI", "TAKIP", "PAYLAS", "YORUM", "CANLI", "KAYIT", "OYNAT", "DURAKLAT", "SES",
    "KAMERA", "KONUM", "TAKVIM", "SAAT", "TELEFON", "MESAJ", "EPOSTA", "LINK", "WIFI", "PIL",
    "FUTBOL", "BASKET", "KOSU", "BISIKLET", "MADALYA", "PARA", "FIKIR", "SIHIR",
]
EXTRA_STICKERS = {f"extra{index:02d}" for index in range(1, len(EXTRA_STICKER_LABELS) + 1)}
ALLOWED_STICKERS = CORE_STICKERS | EXTRA_STICKERS
SUPPORTED_MEDIA_EXTENSIONS = {
    "video": {".mp4", ".mov", ".mkv", ".webm", ".m4v"},
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"},
    "audio": {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"},
}
def resolve_media_binary(name: str) -> str:
    env_name = f"SMART_EDITOR_{name.upper()}"
    configured = os.environ.get(env_name, "").strip()
    executable = f"{name}.exe" if os.name == "nt" else name
    candidates = [
        configured,
        os.path.join(BASE_DIR, "tools", "ffmpeg", "bin", executable),
        shutil.which(name) or "",
    ]
    for candidate in candidates:
        if candidate and (os.path.isfile(candidate) or shutil.which(candidate)):
            return candidate
    return name


def resolve_font(bold: bool = False) -> str:
    windows_dir = os.environ.get("WINDIR", r"C:\Windows")
    filename = "arialbd.ttf" if bold else "arial.ttf"
    candidates = [
        os.path.join(windows_dir, "Fonts", filename),
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return filename


FFMPEG_BIN = resolve_media_binary("ffmpeg")
FFPROBE_BIN = resolve_media_binary("ffprobe")
FONT_REGULAR = resolve_font(False)
FONT_BOLD = resolve_font(True)
LOW_MEMORY_RENDER = (
    os.name == "nt"
    or os.environ.get("SMART_EDITOR_LOW_MEMORY_RENDER", "").strip().lower()
    in {"1", "true", "yes", "on"}
)
try:
    RENDER_THREAD_LIMIT = max(
        1, min(4, int(os.environ.get("SMART_EDITOR_RENDER_THREADS", "2")))
    )
except ValueError:
    RENDER_THREAD_LIMIT = 2

_ffmpeg_filter_script_option = None


def ffmpeg_filter_script_args(script_path: str) -> list[str]:
    """Return the filter-script syntax supported by the installed FFmpeg.

    FFmpeg 7/8 deprecated the old ``-filter_complex_script`` switch and some
    Windows builds compile it out completely. Those builds return
    AVERROR_OPTION_NOT_FOUND (0xABAFB008). Older FFmpeg releases, however,
    still need the legacy switch, so detect the supported form once.
    """
    global _ffmpeg_filter_script_option
    if _ffmpeg_filter_script_option is None:
        option = "-filter_complex_script"
        try:
            import subprocess
            probe = subprocess.run(
                [FFMPEG_BIN, "-hide_banner", "-h", "full"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="ignore",
                timeout=15,
                check=False,
            )
            help_text = probe.stdout or ""
            legacy_available = "-filter_complex_script" in help_text
            new_file_syntax_advertised = "use -/filter_complex instead" in help_text
            if new_file_syntax_advertised or not legacy_available:
                option = "-/filter_complex"
        except (OSError, subprocess.SubprocessError):
            # The bundled Windows build is modern. Prefer the new syntax when
            # capability probing itself cannot run there.
            if os.name == "nt":
                option = "-/filter_complex"
        _ffmpeg_filter_script_option = option
    return [_ffmpeg_filter_script_option, script_path]


def format_ffmpeg_error(returncode: int, stderr_lines: list[str]) -> str:
    unsigned_code = returncode & 0xFFFFFFFF
    signed_code = returncode if returncode < 0x80000000 else returncode - 0x100000000
    meaningful_lines = [
        line.strip() for line in stderr_lines
        if line.strip() and not is_benign_ffmpeg_warning(line)
    ]
    detail = "\n".join(meaningful_lines[-8:])[-1800:]
    detail_lower = detail.lower()
    if signed_code == -12 or "cannot allocate memory" in detail_lower:
        message = (
            "Windows render belleği yetersiz kaldı. Düşük bellek modu açık; "
            "devam ederse çıktı çözünürlüğünü veya FPS değerini düşürüp yeniden deneyin."
        )
    elif unsigned_code == 0xABAFB008 or "option not found" in detail_lower:
        message = (
            "FFmpeg bir komut seçeneğini tanımadı. Windows FFmpeg sürümünü "
            "WINDOWS_KUR.bat ile güncelleyip yeniden deneyin."
        )
    else:
        message = f"Render hatası. Çıkış kodu: {returncode}"
    return f"{message}\n\nFFmpeg ayrıntısı:\n{detail}" if detail else message


def is_benign_ffmpeg_warning(line: str) -> bool:
    normalized = line.strip().lower()
    return "udta parsing failed retrying raw" in normalized


async def collect_ffmpeg_stderr(proc, q: asyncio.Queue, total_duration: float) -> list[str]:
    """Read FFmpeg output in bounded chunks instead of newline-delimited records.

    FFmpeg can print a complete filter graph as one very long line. StreamReader.readline
    has a 64 KiB separator limit and raises LimitOverrunError in that case, especially on
    Windows. Chunked reads keep progress reporting and a useful rolling error tail without
    depending on line length.
    """
    time_regex = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")
    scan_tail = ""
    stderr_window = ""
    important_lines = []
    last_progress = -1.0
    important_markers = (
        "error", "failed", "cannot", "memory", "invalid", "not found",
        "no space", "permission denied", "access is denied",
    )

    while True:
        chunk = await proc.stderr.read(16 * 1024)
        if not chunk:
            break
        chunk_text = chunk.decode("utf-8", errors="ignore")
        scan_text = scan_tail + chunk_text
        matches = list(time_regex.finditer(scan_text))
        if matches:
            h, m, s = matches[-1].groups()
            current_time = int(h) * 3600 + int(m) * 60 + float(s)
            progress = min(100.0, (current_time / max(0.001, total_duration)) * 100.0)
            rounded_progress = round(progress, 1)
            if rounded_progress != last_progress:
                last_progress = rounded_progress
                await q.put({"type": "progress", "percent": rounded_progress})

        scan_tail = scan_text[-128:]
        stderr_window = (stderr_window + chunk_text)[-64 * 1024:]
        new_important_lines = []
        for part in scan_text.splitlines():
            clean_part = part.strip()
            if is_benign_ffmpeg_warning(clean_part):
                continue
            if clean_part and any(marker in clean_part.lower() for marker in important_markers):
                if not important_lines or important_lines[-1] != clean_part:
                    important_lines.append(clean_part[-2000:])
                    new_important_lines.append(clean_part[-2000:])
                    if len(important_lines) > 32:
                        del important_lines[0]
        if new_important_lines:
            newest_diagnostic = new_important_lines[-1]
            if "error" in newest_diagnostic.lower() or "failed" in newest_diagnostic.lower():
                await q.put({
                    "type": "log",
                    "message": f"[FFMPEG] {newest_diagnostic[-1200:]}",
                })

    raw_tail_lines = stderr_window.splitlines() or ([stderr_window] if stderr_window else [])
    tail_lines = [line for line in raw_tail_lines if not is_benign_ffmpeg_warning(line)]
    # Keep diagnostics last so format_ffmpeg_error cannot lose the real cause
    # behind libx264's final statistics block.
    combined_lines = tail_lines[-8:] + important_lines[-16:]
    unique_lines = []
    for line in combined_lines:
        if line and line not in unique_lines:
            unique_lines.append(line)
    return unique_lines

app = FastAPI()
templates = Jinja2Templates(directory=TEMPLATE_DIR)

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(WAVEFORM_DIR, exist_ok=True)
os.makedirs(PROJECT_DIR, exist_ok=True)

# ── Sürüm ve güncelleme sistemi ────────────────────────
VERSION_FILE = os.path.join(BASE_DIR, "version.json")
BACKUP_DIR = os.path.join(BASE_DIR, ".backup")
GITHUB_REPO = os.environ.get("SMART_EDITOR_GITHUB_REPO", "").strip() or "davutcan123/OtomatikEdit"

def _make_ssl_context():
    """Windows'ta SSL sertifika sorunlarını aşmak için context oluşturur."""
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    except Exception:
        return None

def _load_version() -> str:
    try:
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("version", "0.0.0")
    except Exception:
        return "0.0.0"

APP_VERSION = _load_version()

# Korunan dizinler — güncelleme sırasında bunlar asla silinmez/üzerine yazılmaz
_PROTECTED_DIRS = {"venv", ".venv-windows", "uploads", "outputs", "projects",
                   "tools", "__pycache__", ".backup", ".git"}

# In-memory storage for jobs
jobs = {}
_whisper_model = None
_whisper_model_init_lock = threading.Lock()
_whisper_inference_lock = threading.Lock()
_whisper_model_name = os.environ.get(
    "SMART_EDITOR_WHISPER_MODEL", "tiny" if os.name == "nt" else "base"
).strip() or "tiny"

def get_whisper_model(q_sync=None):
    global _whisper_model
    if _whisper_model is None:
        with _whisper_model_init_lock:
            if _whisper_model is None:
                if q_sync:
                    q_sync(f"Düşük bellekli konuşma modeli yükleniyor ({_whisper_model_name})…")
                from faster_whisper import WhisperModel
                _whisper_model = WhisperModel(
                    _whisper_model_name,
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=max(1, min(2, os.cpu_count() or 1)),
                    num_workers=1,
                )
    return _whisper_model

def get_video_duration(filepath: str) -> float:
    import subprocess
    cmd = [
        FFPROBE_BIN, "-v", "error", "-show_entries",
        "format=duration", "-of",
        "default=noprint_wrappers=1:nokey=1", filepath
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0

def get_video_dimensions(filepath: str) -> tuple[int, int]:
    import subprocess
    cmd = [
        FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filepath
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        width, height = result.stdout.strip().split("x", 1)
        return int(width), int(height)
    except (ValueError, TypeError):
        return 1920, 1080

def video_has_audio(filepath: str) -> bool:
    import subprocess
    cmd = [
        FFPROBE_BIN, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=index", "-of", "csv=p=0", filepath
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return bool(result.stdout.strip())

def atempo_chain(speed: float) -> str:
    values = []
    remaining = max(0.25, min(4.0, speed))
    while remaining < 0.5:
        values.append(0.5)
        remaining /= 0.5
    while remaining > 2.0:
        values.append(2.0)
        remaining /= 2.0
    values.append(remaining)
    return ",".join(f"atempo={value:.8f}" for value in values)

def get_media_kind(filename: str, content_type: str = "") -> str | None:
    extension = os.path.splitext(filename.lower())[1]
    for kind, extensions in SUPPORTED_MEDIA_EXTENSIONS.items():
        if extension in extensions:
            return kind
    prefix = (content_type or "").split("/", 1)[0].lower()
    return prefix if prefix in SUPPORTED_MEDIA_EXTENSIONS else None

def alpha_mask_expression(mask: str, scale: float = 100, x: float = 50, y: float = 50) -> str:
    size = max(0.1, min(1.5, scale / 100))
    center_x = max(0.0, min(1.0, x / 100))
    center_y = max(0.0, min(1.0, y / 100))
    if mask == "circle":
        radius = .45 * size
        return (
            f"if(lte(pow((X-W*{center_x:.6f})/(min(W,H)*{radius:.6f}),2)+"
            f"pow((Y-H*{center_y:.6f})/(min(W,H)*{radius:.6f}),2),1),alpha(X,Y),0)"
        )
    if mask == "ellipse":
        radius_x, radius_y = .48 * size, .38 * size
        return (
            f"if(lte(pow((X-W*{center_x:.6f})/(W*{radius_x:.6f}),2)+"
            f"pow((Y-H*{center_y:.6f})/(H*{radius_y:.6f}),2),1),alpha(X,Y),0)"
        )
    half_width, half_height = min(.49, .46 * size), min(.49, .46 * size)
    return (
        f"if(between(X,W*{max(0, center_x-half_width):.6f},W*{min(1, center_x+half_width):.6f})*"
        f"between(Y,H*{max(0, center_y-half_height):.6f},H*{min(1, center_y+half_height):.6f}),alpha(X,Y),0)"
    )

def normalize_image_layers(items, total_duration: float) -> list[dict]:
    if not isinstance(items, list) or len(items) > 50:
        raise HTTPException(400, "En fazla 50 görsel katmanı kullanılabilir")
    normalized = []
    for item in items:
        if not isinstance(item, dict):
            raise HTTPException(400, "Geçersiz görsel katmanı")
        file_id = os.path.basename(str(item.get("fileId", "")))
        path = os.path.join(UPLOAD_DIR, file_id)
        if not file_id or not os.path.exists(path) or get_media_kind(file_id) != "image":
            raise HTTPException(400, "Görsel dosyası bulunamadı")
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", start + 5))
            x = float(item.get("x", 50))
            y = float(item.get("y", 50))
            scale = float(item.get("scale", 55))
            rotation = float(item.get("rotation", 0))
            mask_scale = float(item.get("maskScale", 100))
            mask_x = float(item.get("maskX", 50))
            mask_y = float(item.get("maskY", 50))
            mask_feather = float(item.get("maskFeather", 0))
            key_similarity = float(item.get("keySimilarity", 25))
            key_blend = float(item.get("keyBlend", 8))
            brush_size = float(item.get("brushSize", 12))
        except (TypeError, ValueError):
            raise HTTPException(400, "Geçersiz görsel ayarı")
        if not all(math.isfinite(value) for value in (start, end, x, y, scale, rotation, mask_scale, mask_x, mask_y, mask_feather, key_similarity, key_blend, brush_size)):
            raise HTTPException(400, "Geçersiz görsel ayarı")
        mask = str(item.get("mask", "none")).strip().lower()
        if mask not in ALLOWED_MASKS:
            raise HTTPException(400, "Desteklenmeyen görsel maskesi")
        background_mode = str(item.get("backgroundMode", "none")).strip().lower()
        brush_mode = str(item.get("brushMode", "keep")).strip().lower()
        if background_mode not in ALLOWED_BACKGROUND_MODES:
            raise HTTPException(400, "Desteklenmeyen görsel arka plan işlemi")
        if brush_mode not in ALLOWED_BRUSH_MODES:
            raise HTTPException(400, "Desteklenmeyen görsel fırça modu")
        normalized_brush_strokes = []
        point_count = 0
        raw_brush_strokes = item.get("brushStrokes", [])
        if isinstance(raw_brush_strokes, list):
            for raw_stroke in raw_brush_strokes[:40]:
                if not isinstance(raw_stroke, dict):
                    continue
                try:
                    stroke_size = max(2.0, min(30.0, float(raw_stroke.get("size", brush_size))))
                except (TypeError, ValueError):
                    stroke_size = max(2.0, min(30.0, brush_size))
                points = []
                raw_points = raw_stroke.get("points", [])
                for raw_point in raw_points if isinstance(raw_points, list) else []:
                    if point_count >= 180 or not isinstance(raw_point, dict):
                        break
                    try:
                        point_x = max(0.0, min(1.0, float(raw_point.get("x", 0))))
                        point_y = max(0.0, min(1.0, float(raw_point.get("y", 0))))
                    except (TypeError, ValueError):
                        continue
                    if math.isfinite(point_x) and math.isfinite(point_y):
                        points.append({"x": point_x, "y": point_y})
                        point_count += 1
                if points:
                    normalized_brush_strokes.append({"size": stroke_size, "points": points})
                if point_count >= 180:
                    break
        start = max(0.0, min(start, max(0.0, total_duration - 0.05)))
        end = max(start + 0.05, min(end, total_duration))
        normalized.append({
            "fileId": file_id,
            "path": path,
            "start": start,
            "end": end,
            "x": max(0.0, min(x, 100.0)),
            "y": max(0.0, min(y, 100.0)),
            "scale": max(5.0, min(scale, 160.0)),
            "rotation": max(-3600.0, min(rotation, 3600.0)),
            "mask": mask,
            "maskScale": max(10.0, min(mask_scale, 150.0)),
            "maskX": max(0.0, min(mask_x, 100.0)),
            "maskY": max(0.0, min(mask_y, 100.0)),
            "maskFeather": max(0.0, min(mask_feather, 35.0)),
            "backgroundMode": background_mode,
            "keyColor": normalize_hex_color(item.get("keyColor"), "#00FF00"),
            "keySimilarity": max(1.0, min(80.0, key_similarity)),
            "keyBlend": max(0.0, min(50.0, key_blend)),
            "brushMode": brush_mode,
            "brushSize": max(2.0, min(30.0, brush_size)),
            "brushStrokes": normalized_brush_strokes,
        })
    return normalized

def normalize_audio_layers(items, total_duration: float) -> list[dict]:
    if not isinstance(items, list) or len(items) > 50:
        raise HTTPException(400, "En fazla 50 ses katmanı kullanılabilir")
    normalized = []
    for item in items:
        if not isinstance(item, dict):
            raise HTTPException(400, "Geçersiz ses katmanı")
        file_id = os.path.basename(str(item.get("fileId", "")))
        path = os.path.join(UPLOAD_DIR, file_id)
        if not file_id or not os.path.exists(path) or get_media_kind(file_id) != "audio":
            raise HTTPException(400, "Ses dosyası bulunamadı")
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", start + 5))
            source_start = float(item.get("sourceStart", 0))
            volume = float(item.get("volume", 1))
        except (TypeError, ValueError):
            raise HTTPException(400, "Geçersiz ses ayarı")
        if not all(math.isfinite(value) for value in (start, end, source_start, volume)):
            raise HTTPException(400, "Geçersiz ses ayarı")
        start = max(0.0, min(start, max(0.0, total_duration - 0.05)))
        end = max(start + 0.05, min(end, total_duration))
        normalized.append({
            "fileId": file_id,
            "path": path,
            "start": start,
            "end": end,
            "sourceStart": max(0.0, source_start),
            "volume": max(0.0, min(volume, 2.0)),
        })
    return normalized

def normalize_hex_color(value, default: str) -> str:
    candidate = str(value or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", candidate):
        return candidate.upper()
    return default

def normalize_text_items(items, total_duration: float) -> list[dict]:
    if not isinstance(items, list) or len(items) > 500:
        raise HTTPException(400, "En fazla 500 metin ve altyazı katmanı kullanılabilir")

    normalized = []
    for item in items:
        if not isinstance(item, dict):
            raise HTTPException(400, "Geçersiz metin katmanı")
        text = str(item.get("text", "")).strip()[:200]
        if not text:
            continue
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", start + 3))
            size = float(item.get("size", 72))
            x = float(item.get("x", 50))
            y = float(item.get("y", 50))
            outline_width = float(item.get("outlineWidth", 3))
            background_opacity = float(item.get("backgroundOpacity", 0))
            rotation = float(item.get("rotation", 0))
        except (TypeError, ValueError):
            raise HTTPException(400, "Geçersiz metin ayarı")
        values = (start, end, size, x, y, outline_width, background_opacity, rotation)
        if not all(math.isfinite(value) for value in values):
            raise HTTPException(400, "Geçersiz metin ayarı")
        if total_duration <= 0:
            continue
        start = max(0.0, min(start, max(0.0, total_duration - 0.05)))
        end = max(start + 0.05, min(end, total_duration))
        raw_transform_keyframes = item.get("transformKeyframes", [])
        if isinstance(raw_transform_keyframes, list):
            raw_transform_keyframes = [
                {
                    **frame,
                    "x": frame.get("x", x),
                    "y": frame.get("y", y),
                    "opacity": frame.get("opacity", 100),
                }
                for frame in raw_transform_keyframes
                if isinstance(frame, dict)
            ]
        transform_keyframes = normalize_zoom_keyframes(
            raw_transform_keyframes, max(0.05, end - start)
        )
        normalized.append({
            "text": text,
            "start": start,
            "end": end,
            "size": max(12.0, min(size, 240.0)),
            "x": max(0.0, min(x, 100.0)),
            "y": max(0.0, min(y, 100.0)),
            "color": normalize_hex_color(item.get("color"), "#FFFFFF"),
            "outlineColor": normalize_hex_color(item.get("outlineColor"), "#000000"),
            "outlineWidth": max(0.0, min(outline_width, 12.0)),
            "background": normalize_hex_color(item.get("background"), "#000000"),
            "backgroundOpacity": max(0.0, min(background_opacity, 1.0)),
            "shadow": bool(item.get("shadow", True)),
            "bold": bool(item.get("bold", True)),
            "rotation": max(-3600.0, min(rotation, 3600.0)),
            "transformKeyframes": transform_keyframes,
        })
    return normalized

def normalize_sticker_items(items, total_duration: float) -> list[dict]:
    if not isinstance(items, list) or len(items) > 50:
        raise HTTPException(400, "En fazla 50 sticker kullanılabilir")
    normalized = []
    for item in items:
        if not isinstance(item, dict):
            raise HTTPException(400, "Geçersiz sticker")
        preset = str(item.get("preset", "")).strip().lower()
        if preset not in ALLOWED_STICKERS:
            raise HTTPException(400, "Desteklenmeyen sticker")
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", start + 3))
            x = float(item.get("x", 50))
            y = float(item.get("y", 50))
            scale = float(item.get("scale", 18))
            rotation = float(item.get("rotation", 0))
        except (TypeError, ValueError):
            raise HTTPException(400, "Geçersiz sticker ayarı")
        if not all(math.isfinite(value) for value in (start, end, x, y, scale, rotation)):
            raise HTTPException(400, "Geçersiz sticker ayarı")
        if total_duration <= 0:
            continue
        start = max(0.0, min(start, max(0.0, total_duration - 0.05)))
        end = max(start + 0.05, min(end, total_duration))
        normalized.append({
            "preset": preset,
            "start": start,
            "end": end,
            "x": max(0.0, min(x, 100.0)),
            "y": max(0.0, min(y, 100.0)),
            "scale": max(5.0, min(scale, 80.0)),
            "rotation": max(-3600.0, min(rotation, 3600.0)),
        })
    return normalized

ZOOM_KEYFRAME_EASINGS = {
    "smoother", "smooth", "cinematic", "easeInOut", "easeIn", "easeOut",
    "gentle", "responsive", "linear",
}


def normalize_zoom_keyframes(items, output_duration: float) -> list[dict]:
    if items is None:
        return []
    if not isinstance(items, list) or len(items) > 120:
        raise HTTPException(400, "Geçersiz zoom keyframe listesi")
    by_time = {}
    for item in items:
        if not isinstance(item, dict):
            raise HTTPException(400, "Geçersiz zoom keyframe")
        try:
            time = float(item.get("time", 0))
            scale = float(item.get("scale", 100))
            focus_x = float(item.get("x", 50))
            focus_y = float(item.get("y", 50))
            opacity = float(item.get("opacity", 100))
        except (TypeError, ValueError):
            raise HTTPException(400, "Geçersiz zoom keyframe ayarı")
        if not all(math.isfinite(value) for value in (time, scale, focus_x, focus_y, opacity)):
            raise HTTPException(400, "Geçersiz zoom keyframe ayarı")
        time = max(0.0, min(output_duration, time))
        easing = item.get("easing")
        if not isinstance(easing, str) or easing not in ZOOM_KEYFRAME_EASINGS:
            easing = "smoother"
        by_time[round(time, 4)] = {
            "time": time,
            "scale": max(25.0, min(300.0, scale)),
            "x": max(0.0, min(100.0, focus_x)),
            "y": max(0.0, min(100.0, focus_y)),
            "opacity": max(0.0, min(100.0, opacity)),
            "easing": easing,
        }
    return [by_time[key] for key in sorted(by_time)]


def zoom_keyframe_easing_expression(progress: str, easing: str) -> str:
    p = f"({progress})"
    if easing == "linear":
        return p
    if easing == "smooth":
        return f"({p}*{p}*(3-2*{p}))"
    if easing == "easeIn":
        return f"({p}*{p}*{p})"
    if easing == "easeOut":
        return f"(1-(1-{p})*(1-{p})*(1-{p}))"
    if easing == "easeInOut":
        return f"if(lt({p},.5),4*{p}*{p}*{p},1-pow(-2*{p}+2,3)/2)"
    if easing == "cinematic":
        return f"(.5-.5*cos(PI*{p}))"
    if easing == "gentle":
        return f"({p}*{p}*(2-{p}))"
    if easing == "responsive":
        return f"(1-pow(1-{p},4))"
    return f"({p}*{p}*{p}*({p}*({p}*6-15)+10))"


def zoom_keyframe_scale_expression(base_scale: float, keyframes: list[dict]) -> str:
    anchors = [{"time": 0.0, "scale": max(25.0, min(300.0, base_scale)) / 100.0, "easing": "smoother"}]
    for frame in keyframes:
        anchor = {"time": frame["time"], "scale": frame["scale"] / 100.0, "easing": frame.get("easing", "smoother")}
        if anchor["time"] <= 0.0001:
            anchors[0] = anchor
        else:
            anchors.append(anchor)
    if len(anchors) == 1:
        return f"{anchors[0]['scale']:.8f}"
    expression = f"{anchors[-1]['scale']:.8f}"
    for left, right in reversed(list(zip(anchors, anchors[1:]))):
        span = max(0.0001, right["time"] - left["time"])
        progress = f"((t-{left['time']:.8f})/{span:.8f})"
        eased = zoom_keyframe_easing_expression(progress, right.get("easing", "smoother"))
        value = f"({left['scale']:.8f}+({right['scale'] - left['scale']:.8f})*({eased}))"
        expression = f"if(lt(t,{right['time']:.8f}),{value},{expression})"
    return expression

def zoom_keyframe_focus_expression(
    keyframes: list[dict], axis: str, base_value: float = 50
) -> str:
    anchors = [{"time": 0.0, "value": max(0.0, min(100.0, base_value)) / 100.0, "easing": "smoother"}]
    for frame in keyframes:
        anchor = {"time": frame["time"], "value": frame.get(axis, 50) / 100.0, "easing": frame.get("easing", "smoother")}
        if anchor["time"] <= 0.0001:
            anchors[0] = anchor
        else:
            anchors.append(anchor)
    if len(anchors) == 1:
        return f"{anchors[0]['value']:.8f}"
    expression = f"{anchors[-1]['value']:.8f}"
    for left, right in reversed(list(zip(anchors, anchors[1:]))):
        span = max(0.0001, right["time"] - left["time"])
        progress = f"((t-{left['time']:.8f})/{span:.8f})"
        eased = zoom_keyframe_easing_expression(progress, right.get("easing", "smoother"))
        value = f"({left['value']:.8f}+({right['value'] - left['value']:.8f})*({eased}))"
        expression = f"if(lt(t,{right['time']:.8f}),{value},{expression})"
    return expression


def zoom_keyframe_opacity_expression(base_opacity: float, keyframes: list[dict]) -> str:
    anchors = [{"time": 0.0, "value": max(0.0, min(100.0, base_opacity)) / 100.0, "easing": "smoother"}]
    for frame in keyframes:
        anchor = {
            "time": frame["time"],
            "value": frame.get("opacity", 100) / 100.0,
            "easing": frame.get("easing", "smoother"),
        }
        if anchor["time"] <= 0.0001:
            anchors[0] = anchor
        else:
            anchors.append(anchor)
    if len(anchors) == 1:
        return f"{anchors[0]['value']:.8f}"
    expression = f"{anchors[-1]['value']:.8f}"
    for left, right in reversed(list(zip(anchors, anchors[1:]))):
        span = max(0.0001, right["time"] - left["time"])
        progress = f"((t-{left['time']:.8f})/{span:.8f})"
        eased = zoom_keyframe_easing_expression(progress, right.get("easing", "smoother"))
        value = f"({left['value']:.8f}+({right['value'] - left['value']:.8f})*({eased}))"
        expression = f"if(lt(t,{right['time']:.8f}),{value},{expression})"
    return expression

def normalize_transition_items(items, segments: list[dict]) -> list[dict]:
    if not isinstance(items, list) or len(items) > max(0, len(segments) - 1):
        raise HTTPException(400, "Geçersiz geçiş listesi")

    by_boundary = {}
    for item in items:
        if not isinstance(item, dict):
            raise HTTPException(400, "Geçersiz geçiş")
        try:
            boundary = int(item.get("boundary"))
            duration = float(item.get("duration", 0.6))
        except (TypeError, ValueError):
            raise HTTPException(400, "Geçersiz geçiş ayarı")
        transition_type = str(item.get("type", "fade")).lower()
        if transition_type not in ALLOWED_TRANSITIONS:
            raise HTTPException(400, "Desteklenmeyen geçiş türü")
        if boundary < 0 or boundary >= len(segments) - 1 or not math.isfinite(duration):
            raise HTTPException(400, "Geçiş kesim noktasının dışında")
        left_duration = (
            segments[boundary]["end"] - segments[boundary]["start"]
        ) / segments[boundary].get("speed", 1)
        right_duration = (
            segments[boundary + 1]["end"] - segments[boundary + 1]["start"]
        ) / segments[boundary + 1].get("speed", 1)
        left_timeline_end = segments[boundary].get("timelineStart", 0) + left_duration
        right_timeline_start = segments[boundary + 1].get("timelineStart", left_timeline_end)
        if abs(left_timeline_end - right_timeline_start) > .03:
            raise HTTPException(400, "Geçiş uygulanacak klipler timeline'da uç uca olmalı")
        max_duration = max(0.02, min(2.0, left_duration * 0.45, right_duration * 0.45))
        by_boundary[boundary] = {
            "boundary": boundary,
            "type": transition_type,
            "duration": max(0.02, min(duration, max_duration)),
        }
    return [by_boundary[key] for key in sorted(by_boundary)]

def adjust_texts_for_transitions(
    items: list[dict], transitions: list[dict], segments: list[dict]
) -> list[dict]:
    if not transitions:
        return items
    boundaries = []
    transition_map = {item["boundary"]: item["duration"] for item in transitions}
    for index, segment in enumerate(segments[:-1]):
        elapsed = segment.get("timelineStart", 0) + (
            segment["end"] - segment["start"]
        ) / segment.get("speed", 1)
        if index in transition_map:
            boundaries.append((elapsed, transition_map[index]))
    actual_duration = max(
        s.get("timelineStart", 0) + (s["end"] - s["start"]) / s.get("speed", 1)
        for s in segments
    ) - sum(
        item["duration"] for item in transitions
    )
    adjusted = []
    for item in items:
        copy_item = dict(item)
        start_shift = sum(duration for boundary, duration in boundaries if boundary <= item["start"])
        end_shift = sum(duration for boundary, duration in boundaries if boundary < item["end"])
        copy_item["start"] = max(0.0, item["start"] - start_shift)
        copy_item["end"] = min(actual_duration, item["end"] - end_shift)
        if copy_item["end"] - copy_item["start"] >= 0.05:
            adjusted.append(copy_item)
    return adjusted

def create_text_overlay(path: str, item: dict, width: int, height: int):
    from PIL import Image, ImageDraw, ImageFont

    def rgba(color: str, alpha: int = 255):
        value = color.lstrip("#")
        return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4)) + (alpha,)

    font_size = max(12, int(height * item["size"] / 1080))
    font_path = FONT_BOLD if item.get("bold", True) else FONT_REGULAR
    font = ImageFont.truetype(font_path, font_size)
    stroke_width = max(0, int(height * item["outlineWidth"] / 1080))
    text = item["text"]
    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    spacing = max(4, font_size // 8)
    bbox = measure.multiline_textbbox(
        (0, 0), text, font=font, spacing=max(4, font_size // 8),
        align="center", stroke_width=stroke_width
    )
    shadow_offset = max(2, font_size // 18) if item.get("shadow", True) else 0
    padding = max(12, font_size // 3) + stroke_width + shadow_offset
    label_width = max(2, int(math.ceil(bbox[2] - bbox[0] + padding * 2)))
    label_height = max(2, int(math.ceil(bbox[3] - bbox[1] + padding * 2)))
    label = Image.new("RGBA", (label_width, label_height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(label)
    text_x = padding - bbox[0]
    text_y = padding - bbox[1]
    opacity = int(255 * item.get("backgroundOpacity", 0))
    if opacity > 0:
        draw.rounded_rectangle(
            (0, 0, label_width - 1, label_height - 1), radius=max(6, font_size // 5),
            fill=rgba(item["background"], opacity)
        )

    if item.get("shadow", True):
        draw.multiline_text(
            (text_x + shadow_offset, text_y + shadow_offset), text,
            font=font, fill=(0, 0, 0, 170), spacing=spacing,
            align="center", stroke_width=stroke_width,
            stroke_fill=(0, 0, 0, 170)
        )
    draw.multiline_text(
        (text_x, text_y), text, font=font, fill=rgba(item["color"]),
        spacing=spacing, align="center",
        stroke_width=stroke_width, stroke_fill=rgba(item["outlineColor"])
    )
    rotation = item.get("rotation", 0)
    if abs(rotation) > 0.01:
        label = label.rotate(
            -rotation, expand=True, resample=Image.Resampling.BICUBIC
        )
    if item.get("_compact"):
        label.save(path, "PNG")
        return label.width, label.height
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    center_x = width * item["x"] / 100
    center_y = height * item["y"] / 100
    paste_x = round(center_x - label.width / 2)
    paste_y = round(center_y - label.height / 2)
    canvas.paste(label, (paste_x, paste_y), label)
    canvas.save(path, "PNG")
    return canvas.width, canvas.height

def create_sticker_overlay(path: str, item: dict, width: int, height: int):
    from PIL import Image, ImageDraw, ImageFont

    base = 512
    sticker = Image.new("RGBA", (base, base), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sticker)
    preset = item["preset"]
    red, yellow, blue = (244, 63, 94, 255), (250, 204, 21, 255), (56, 189, 248, 255)
    white, dark, green = (255, 255, 255, 255), (15, 23, 42, 255), (34, 197, 94, 255)
    if preset == "arrow":
        draw.polygon([(45, 205), (320, 205), (320, 105), (475, 256), (320, 407), (320, 307), (45, 307)], fill=red, outline=white, width=14)
    elif preset == "circle":
        draw.ellipse((45, 45, 467, 467), outline=red, width=38)
    elif preset == "heart":
        draw.polygon([(256, 445), (75, 272), (58, 170), (112, 82), (211, 74), (256, 128), (301, 74), (400, 82), (454, 170), (437, 272)], fill=red, outline=white, width=12)
    elif preset == "star":
        points = []
        for index in range(10):
            angle = -math.pi / 2 + index * math.pi / 5
            radius = 220 if index % 2 == 0 else 92
            points.append((256 + math.cos(angle) * radius, 256 + math.sin(angle) * radius))
        draw.polygon(points, fill=yellow, outline=white, width=12)
    elif preset == "sparkle":
        draw.polygon([(256, 24), (305, 207), (488, 256), (305, 305), (256, 488), (207, 305), (24, 256), (207, 207)], fill=yellow, outline=white, width=10)
        draw.polygon([(102, 58), (120, 120), (182, 138), (120, 156), (102, 218), (84, 156), (22, 138), (84, 120)], fill=white)
    elif preset == "fire":
        draw.polygon([(255, 474), (111, 395), (77, 267), (153, 104), (210, 205), (275, 30), (428, 229), (425, 357)], fill=red, outline=white, width=10)
        draw.polygon([(256, 433), (183, 371), (190, 274), (256, 183), (325, 286), (339, 367)], fill=yellow)
    elif preset == "bolt":
        draw.polygon([(285, 22), (100, 284), (230, 284), (184, 490), (420, 205), (282, 205)], fill=yellow, outline=dark, width=14)
    elif preset == "target":
        for inset, color in ((28, red), (90, white), (154, red), (214, white)):
            draw.ellipse((inset, inset, base - inset, base - inset), fill=color)
    elif preset == "check":
        draw.rounded_rectangle((35, 35, 477, 477), radius=105, fill=green, outline=white, width=12)
        draw.line((125, 265, 218, 355, 396, 158), fill=white, width=50, joint="curve")
    elif preset == "party":
        draw.polygon([(83, 438), (205, 102), (416, 390)], fill=(168, 85, 247, 255), outline=white, width=10)
        for x, y, color in ((60, 95, red), (323, 72, yellow), (438, 137, blue), (383, 280, green), (120, 208, blue)):
            draw.ellipse((x - 16, y - 16, x + 16, y + 16), fill=color)
    elif preset == "speech":
        draw.rounded_rectangle((35, 70, 477, 380), radius=68, fill=blue, outline=white, width=12)
        draw.polygon([(170, 370), (120, 475), (280, 370)], fill=blue)
        draw.ellipse((135, 205, 175, 245), fill=white); draw.ellipse((236, 205, 276, 245), fill=white); draw.ellipse((337, 205, 377, 245), fill=white)
    elif preset == "subscribe":
        draw.rounded_rectangle((25, 135, 487, 377), radius=58, fill=red, outline=white, width=12)
        font = ImageFont.truetype(FONT_BOLD, 78)
        label = "ABONE OL"
        bbox = draw.textbbox((0, 0), label, font=font)
        draw.text(((base - (bbox[2] - bbox[0])) / 2, (base - (bbox[3] - bbox[1])) / 2 - bbox[1]), label, font=font, fill=white)
    elif preset in EXTRA_STICKERS:
        index = int(preset[-2:]) - 1
        label = EXTRA_STICKER_LABELS[index]
        palette = [red, yellow, blue, green, (168, 85, 247, 255), (249, 115, 22, 255), (236, 72, 153, 255), (20, 184, 166, 255)]
        fill = palette[index % len(palette)]
        accent = palette[(index + 3) % len(palette)]
        shape = index % 8
        if shape == 0:
            draw.rounded_rectangle((34, 74, 478, 438), radius=92, fill=fill, outline=white, width=13)
        elif shape == 1:
            draw.ellipse((42, 42, 470, 470), fill=fill, outline=white, width=14)
        elif shape == 2:
            points = []
            for point_index in range(12):
                angle = -math.pi / 2 + point_index * math.pi / 6
                radius = 228 if point_index % 2 == 0 else 174
                points.append((256 + math.cos(angle) * radius, 256 + math.sin(angle) * radius))
            draw.polygon(points, fill=fill, outline=white, width=12)
        elif shape == 3:
            draw.polygon([(256, 30), (476, 256), (256, 482), (36, 256)], fill=fill, outline=white, width=13)
        elif shape == 4:
            draw.rounded_rectangle((28, 112, 484, 400), radius=54, fill=fill, outline=dark, width=14)
            draw.rectangle((52, 136, 460, 376), outline=white, width=8)
        elif shape == 5:
            draw.ellipse((48, 48, 464, 464), fill=dark, outline=fill, width=30)
            draw.ellipse((86, 86, 426, 426), outline=white, width=8)
        elif shape == 6:
            draw.polygon([(35, 145), (384, 82), (474, 255), (384, 430), (35, 367), (105, 256)], fill=fill, outline=white, width=12)
        else:
            draw.rounded_rectangle((48, 48, 464, 464), radius=52, fill=dark, outline=fill, width=24)
            draw.line((92, 402, 420, 108), fill=accent, width=24)
        font_size = 92 if len(label) <= 5 else 72 if len(label) <= 8 else 56
        font = ImageFont.truetype(FONT_BOLD, font_size)
        bbox = draw.textbbox((0, 0), label, font=font, stroke_width=3)
        text_width, text_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text(
            ((base - text_width) / 2 - bbox[0], (base - text_height) / 2 - bbox[1]),
            label, font=font, fill=white, stroke_width=3, stroke_fill=dark,
        )

    target_width = max(24, int(width * item["scale"] / 100))
    target_height = max(24, round(sticker.height * target_width / sticker.width))
    sticker = sticker.resize((target_width, target_height), Image.Resampling.LANCZOS)
    if abs(item.get("rotation", 0)) > 0.01:
        sticker = sticker.rotate(-item["rotation"], expand=True, resample=Image.Resampling.BICUBIC)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    paste_x = round(width * item["x"] / 100 - sticker.width / 2)
    paste_y = round(height * item["y"] / 100 - sticker.height / 2)
    canvas.paste(sticker, (paste_x, paste_y), sticker)
    canvas.save(path, "PNG")

async def detect_silence(filepath: str, threshold: float, min_duration: float):
    cmd = [
        FFMPEG_BIN, "-i", filepath,
        "-af", f"silencedetect=noise={threshold}dB:d={min_duration}",
        "-f", "null", "-"
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stderr=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()
    output = stderr.decode('utf-8', errors='ignore')
    
    silences = []
    current_start = None
    for line in output.split('\n'):
        if "silence_start:" in line:
            parts = line.split("silence_start:")
            try:
                current_start = float(parts[1].split()[0])
            except (IndexError, ValueError):
                pass
        elif "silence_end:" in line and current_start is not None:
            parts = line.split("silence_end:")
            try:
                end_val = float(parts[1].split()[0])
                silences.append({"start": current_start, "end": end_val, "type": "silence"})
                current_start = None
            except (IndexError, ValueError):
                pass
    return silences

def transcribe_and_find(filepath, words_to_find, q_sync):
    model = get_whisper_model(q_sync)
    q_sync("Transkripsiyon başlatıldı, video uzunluğuna göre sürebilir...")
    with _whisper_inference_lock:
        segments, info = model.transcribe(filepath, word_timestamps=True)
        segments = list(segments)
    
    keyword_segments = []
    found_count = 0
    for segment in segments:
        for word in segment.words:
            # Clean punctuation and convert to lowercase
            clean_word = re.sub(r'[^\w\s]', '', word.word).strip().lower()
            if clean_word in words_to_find:
                keyword_segments.append({
                    "start": word.start, 
                    "end": word.end, 
                    "word": clean_word, 
                    "type": "keyword"
                })
                found_count += 1
                q_sync(f"Bulundu: '{clean_word}' ({word.start:.2f}s - {word.end:.2f}s)")
                
    q_sync(f"Toplam {found_count} adet hedef kelime bulundu.")
    return keyword_segments

def _clean_subtitle_text(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"^[\-–—]\s*", "", text)
    return text

def _is_spoken_subtitle(text: str) -> bool:
    if not text or not re.search(r"[A-Za-zÀ-žĞğİıŞşÇçÖöÜü0-9]", text):
        return False
    lowered = text.casefold().strip(" [](){}.-–—")
    music_labels = {
        "music", "müzik", "background music", "instrumental", "applause",
        "alkış", "sound effect", "ses efekti"
    }
    if lowered in music_labels or "♪" in text or "♫" in text:
        return False
    return True

def _sentences_from_segments(segments, clip_start: float, clip_end: float) -> list[dict]:
    cues = []
    words = []

    def flush():
        nonlocal words
        if not words:
            return
        text = _clean_subtitle_text("".join(item[2] for item in words))
        start = max(clip_start, float(words[0][0]))
        end = min(clip_end, float(words[-1][1]))
        if _is_spoken_subtitle(text) and end - start >= 0.12:
            cues.append({"text": text, "source_start": start, "source_end": end})
        words = []

    for segment in segments:
        text = _clean_subtitle_text(getattr(segment, "text", ""))
        if not _is_spoken_subtitle(text):
            continue
        if float(getattr(segment, "no_speech_prob", 0.0) or 0.0) > 0.65:
            continue
        if float(getattr(segment, "avg_logprob", 0.0) or 0.0) < -1.35:
            continue
        segment_words = list(getattr(segment, "words", None) or [])
        if not segment_words:
            start = max(clip_start, float(getattr(segment, "start", clip_start)))
            end = min(clip_end, float(getattr(segment, "end", start)))
            if end - start >= 0.12:
                cues.append({"text": text, "source_start": start, "source_end": end})
            continue
        for word in segment_words:
            word_start = max(clip_start, float(word.start))
            word_end = min(clip_end, float(word.end))
            token = str(word.word or "")
            if word_end <= word_start:
                continue
            if words and word_start - words[-1][1] > 0.72:
                flush()
            words.append((word_start, word_end, token))
            combined = _clean_subtitle_text("".join(item[2] for item in words))
            sentence_end = bool(re.search(r"[.!?…][\"'”’)]*$", token.strip()))
            if sentence_end or word_end - words[0][0] >= 6.0 or len(combined) >= 88:
                flush()
        if words and re.search(r"[.!?…][\"'”’)]*$", text):
            flush()
    flush()
    return cues

def _translate_cues_to_turkish(cues: list[dict], q_sync) -> list[dict]:
    if not cues:
        return cues
    try:
        import certifi
        from argostranslate import package as argos_package
        from argostranslate import translate as argos_translate
    except ImportError as exc:
        raise RuntimeError(
            "Yerel Türkçe çeviri bileşeni kurulu değil. requirements.txt bağımlılıklarını yükleyin."
        ) from exc
    installed = argos_translate.get_installed_languages()
    source = next((language for language in installed if language.code == "en"), None)
    target = next((language for language in installed if language.code == "tr"), None)
    translation = source.get_translation(target) if source and target else None
    if translation is None:
        q_sync("Yerel English → Türkçe çeviri modeli bir kez indiriliyor…")
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
        argos_package.update_package_index()
        available = argos_package.get_available_packages()
        selected = next(
            (item for item in available if item.from_code == "en" and item.to_code == "tr"),
            None,
        )
        if selected is None:
            raise RuntimeError("English → Türkçe yerel çeviri modeli bulunamadı")
        argos_package.install_from_path(selected.download())
        installed = argos_translate.get_installed_languages()
        source = next((language for language in installed if language.code == "en"), None)
        target = next((language for language in installed if language.code == "tr"), None)
        translation = source.get_translation(target) if source and target else None
    if translation is None:
        raise RuntimeError("English → Türkçe yerel çeviri modeli yüklenemedi")
    q_sync("Konuşmalar yerel modelle Türkçeye çevriliyor…")
    translated = []
    for cue in cues:
        value = translation.translate(cue["text"])
        translated.append({**cue, "text": _clean_subtitle_text(value) or cue["text"]})
    return translated

def _windows_subtitle_worker(connection, filepath, clip_start, clip_end, task, model_name):
    """Run native speech inference out-of-process so a Windows codec/model crash cannot close the editor."""
    try:
        os.environ.setdefault("OMP_NUM_THREADS", "1")
        os.environ.setdefault("CT2_USE_EXPERIMENTAL_PACKED_GEMM", "0")
        from faster_whisper import WhisperModel
        model = WhisperModel(
            model_name, device="cpu", compute_type="int8", cpu_threads=1, num_workers=1
        )
        segments, info = model.transcribe(
            filepath,
            task=task,
            beam_size=1,
            best_of=1,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 350, "speech_pad_ms": 160},
            clip_timestamps=[clip_start, clip_end],
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            hallucination_silence_threshold=1.0,
            condition_on_previous_text=False,
        )
        packed_segments = []
        for segment in segments:
            packed_segments.append({
                "text": str(getattr(segment, "text", "") or ""),
                "start": float(getattr(segment, "start", clip_start)),
                "end": float(getattr(segment, "end", clip_start)),
                "no_speech_prob": float(getattr(segment, "no_speech_prob", 0.0) or 0.0),
                "avg_logprob": float(getattr(segment, "avg_logprob", 0.0) or 0.0),
                "words": [
                    {
                        "word": str(getattr(word, "word", "") or ""),
                        "start": float(getattr(word, "start", clip_start)),
                        "end": float(getattr(word, "end", clip_start)),
                    }
                    for word in list(getattr(segment, "words", None) or [])
                ],
            })
        connection.send(("ok", {
            "language": str(getattr(info, "language", "") or "auto"),
            "segments": packed_segments,
        }))
    except BaseException as exc:
        try:
            connection.send(("error", f"Konuşma modeli çalıştırılamadı: {exc}"))
        except Exception:
            pass
    finally:
        connection.close()

def _windows_subtitle_inference(filepath, clip_start, clip_end, task, q_sync):
    q_sync(f"Korumalı düşük bellekli konuşma modeli yükleniyor ({_whisper_model_name})…")
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(
        target=_windows_subtitle_worker,
        args=(sender, filepath, clip_start, clip_end, task, _whisper_model_name),
        daemon=True,
    )
    process.start()
    sender.close()
    timeout_seconds = max(300.0, min(21600.0, (clip_end - clip_start) * 10.0))
    deadline = time.monotonic() + timeout_seconds
    message = None
    try:
        while time.monotonic() < deadline:
            if receiver.poll(.5):
                message = receiver.recv()
                break
            if not process.is_alive():
                if receiver.poll():
                    message = receiver.recv()
                break
        if message is None:
            if process.is_alive():
                process.terminate()
                raise RuntimeError("Altyazı işlemi zaman aşımına uğradı")
            raise RuntimeError(
                "Konuşma modeli Windows tarafından durduruldu. Uygulama açık kaldı; daha kısa bir klip deneyin."
            )
        status, payload = message
        if status != "ok":
            raise RuntimeError(str(payload))
        segments = []
        for segment in payload.get("segments", []):
            words = [SimpleNamespace(**word) for word in segment.pop("words", [])]
            segments.append(SimpleNamespace(**segment, words=words))
        return segments, SimpleNamespace(language=payload.get("language", "auto"))
    except EOFError as exc:
        raise RuntimeError(
            "Konuşma modeli Windows tarafından durduruldu. Uygulama açık kaldı; daha kısa bir klip deneyin."
        ) from exc
    finally:
        receiver.close()
        process.join(timeout=2)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)

def generate_subtitle_cues(
    filepath: str,
    clip_start: float,
    clip_end: float,
    timeline_start: float,
    speed: float,
    target_language: str,
    q_sync,
) -> dict:
    q_sync("Konuşmalar müzik ve sessizlikten ayrılıyor…")
    task = "translate" if target_language == "en" else "transcribe"
    if os.name == "nt":
        segments, info = _windows_subtitle_inference(
            filepath, clip_start, clip_end, task, q_sync
        )
    else:
        model = get_whisper_model(q_sync)
        with _whisper_inference_lock:
            segments, info = model.transcribe(
                filepath,
                task=task,
                beam_size=1,
                best_of=1,
                word_timestamps=True,
                vad_filter=True,
                vad_parameters={
                    "min_silence_duration_ms": 350,
                    "speech_pad_ms": 160,
                },
                clip_timestamps=[clip_start, clip_end],
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                hallucination_silence_threshold=1.0,
                condition_on_previous_text=False,
            )
            segments = list(segments)
    source_language = str(getattr(info, "language", "") or "auto")
    cues = _sentences_from_segments(segments, clip_start, clip_end)
    if target_language == "tr" and source_language not in {"tr", "en"}:
        raise RuntimeError(
            "Türkçe hedef için konuşma dili Türkçe veya English olmalı"
        )
    if target_language == "tr" and source_language == "en":
        cues = _translate_cues_to_turkish(cues, q_sync)
    mapped = []
    for cue in cues:
        start = timeline_start + (cue["source_start"] - clip_start) / speed
        end = timeline_start + (cue["source_end"] - clip_start) / speed
        if end - start >= 0.05:
            mapped.append({"text": cue["text"], "start": start, "end": end})
    language_names = {"tr": "Türkçe", "en": "English"}
    return {
        "cues": mapped,
        "source_language": source_language,
        "source_language_name": language_names.get(source_language, source_language.upper()),
        "target_language": target_language,
    }

async def run_subtitle_job(job_id: str):
    job = jobs[job_id]
    q = job["q"]
    loop = asyncio.get_running_loop()

    def q_sync(message):
        asyncio.run_coroutine_threadsafe(
            q.put({"type": "log", "message": message}), loop
        )

    try:
        await q.put({"type": "progress", "percent": 8, "message": "Konuşma modeli hazırlanıyor…"})
        data = await asyncio.to_thread(
            generate_subtitle_cues,
            job["filepath"],
            job["clip_start"],
            job["clip_end"],
            job["timeline_start"],
            job["speed"],
            job["target_language"],
            q_sync,
        )
        await q.put({"type": "progress", "percent": 94, "message": "Cümleler timeline'a yerleştiriliyor…"})
        await q.put({"type": "result", "data": data})
    except Exception as exc:
        await q.put({"type": "error", "message": f"Altyazı oluşturulamadı: {exc}"})
    finally:
        await q.put(None)

async def detect_keywords(filepath: str, words_to_find: list, q: asyncio.Queue):
    loop = asyncio.get_running_loop()
    def q_sync(msg):
        asyncio.run_coroutine_threadsafe(q.put({"type": "log", "message": msg}), loop)
        
    with concurrent.futures.ThreadPoolExecutor() as pool:
        keyword_segments = await loop.run_in_executor(
            pool, transcribe_and_find, filepath, words_to_find, q_sync
        )
    return keyword_segments

def calculate_valid_segments(total_duration: float, silences: list, keywords: list):
    exclusions = []
    for s in silences:
        exclusions.append([s["start"], s["end"]])
    
    for k in keywords:
        # Add 0.1s padding to keywords to make cuts sound more natural
        pad = 0.1
        exclusions.append([max(0, k["start"] - pad), min(total_duration, k["end"] + pad)])
        
    # Merge overlapping exclusions
    exclusions.sort(key=lambda x: x[0])
    merged_exclusions = []
    for exc in exclusions:
        if not merged_exclusions:
            merged_exclusions.append([exc[0], exc[1]])
        else:
            last = merged_exclusions[-1]
            if exc[0] <= last[1]:
                last[1] = max(last[1], exc[1])
            else:
                merged_exclusions.append([exc[0], exc[1]])
                
    valid_segments = []
    curr = 0.0
    for ex in merged_exclusions:
        if ex[0] > curr:
            valid_segments.append({"start": curr, "end": ex[0]})
        curr = max(curr, ex[1])
    
    if curr < total_duration:
        valid_segments.append({"start": curr, "end": total_duration})
        
    # Also return exclusions so the frontend can easily jump over them
    excl_dicts = [{"start": e[0], "end": e[1]} for e in merged_exclusions]
    return valid_segments, excl_dicts

async def run_analysis_job(job_id: str):
    job = jobs[job_id]
    q = job["q"]
    try:
        filepath = job["filepath"]
        await q.put({"type": "log", "message": f"Analiz başlatıldı..."})
        
        duration = await asyncio.to_thread(get_video_duration, filepath)
        await q.put({"type": "log", "message": f"Video süresi: {duration:.2f} saniye"})
        
        await q.put({"type": "log", "message": f"Sessizlik tespiti yapılıyor... (Eşik: {job['threshold']}dB, Süre: {job['duration']}s)"})
        silences = await detect_silence(filepath, job['threshold'], job['duration'])
        
        keyword_segments = []
        if job["keywords"].strip():
            words_to_find = [w.strip().lower() for w in job["keywords"].split(",") if w.strip()]
            await q.put({"type": "log", "message": f"Kelimeler girildi: {words_to_find}. Whisper başlatılıyor..."})
            keyword_segments = await detect_keywords(filepath, words_to_find, q)
        else:
            await q.put({"type": "log", "message": "Kelime alanı boş, Whisper atlandı. Sadece sessizlikler kesilecek."})
        
        valid_segments, merged_exclusions = calculate_valid_segments(duration, silences, keyword_segments)
        
        await q.put({"type": "log", "message": "Analiz tamamlandı!"})
        
        # Store for future render
        job["valid_segments"] = valid_segments
        
        await q.put({
            "type": "result", 
            "data": {
                "duration": duration,
                "silences": silences,
                "keyword_segments": keyword_segments,
                "valid_segments": valid_segments,
                "merged_exclusions": merged_exclusions
            }
        })
    except Exception as e:
        await q.put({"type": "error", "message": f"Hata oluştu: {str(e)}"})
    finally:
        await q.put(None)

async def run_render_job(job_id: str):
    job = jobs[job_id]
    q = job["q"]
    try:
        resolution_text = f", Boyut: {job['width']}x{job['height']}" if job.get("width") else ""
        target_fps = job.get("fps", 30)
        quality = job.get("quality", "standard")
        await q.put({"type": "log", "message": f"Render başlatılıyor... Çıktı formatı: {job['format']}, {target_fps} FPS, kalite: {quality}{resolution_text}"})
        segments = job["segments"]
        if not segments:
            raise Exception("Geçerli video bölümü bulunamadı!")
            
        script_path = os.path.join(OUTPUT_DIR, f"script_{job_id}.txt")
        out_path = os.path.join(OUTPUT_DIR, f"out_{job_id}.{job['format']}")
        render_path = out_path if job["format"] not in {"gif", "mp3"} else os.path.join(OUTPUT_DIR, f"intermediate_{job_id}.mp4")
        transitions = job.get("transitions", [])
        transition_map = {item["boundary"]: item for item in transitions}
        clip_durations = [
            (s["end"] - s["start"]) / s.get("speed", 1) for s in segments
        ]
        segment_gaps = []
        timeline_cursor = 0.0
        for segment, clip_duration in zip(segments, clip_durations):
            timeline_start = max(0.0, float(segment.get("timelineStart", timeline_cursor)))
            segment_gaps.append(max(0.0, timeline_start - timeline_cursor))
            timeline_cursor = timeline_start + clip_duration
        segment_durations = [
            duration + gap for duration, gap in zip(clip_durations, segment_gaps)
        ]
        total_duration = sum(segment_durations) - sum(item["duration"] for item in transitions)
        text_items = job.get("texts", [])
        sticker_items = job.get("stickers", [])
        image_items = job.get("images", [])
        audio_items = job.get("audio_layers", [])
        video_inputs = job.get("video_inputs") or [{"fileId": job["file_id"], "path": job["filepath"]}]
        video_input_map = {
            item["fileId"]: {**item, "index": index}
            for index, item in enumerate(video_inputs)
        }
        render_width = job.get("width") or job.get("source_width") or 1920
        render_height = job.get("height") or job.get("source_height") or 1080
        text_overlay_paths = []
        text_overlay_sizes = []
        for index, text_item in enumerate(text_items):
            overlay_path = os.path.join(OUTPUT_DIR, f"text_{job_id}_{index}.png")
            overlay_item = text_item
            if text_item.get("transformKeyframes"):
                overlay_item = {**text_item, "x": 50, "y": 50, "_compact": True}
            overlay_size = await asyncio.to_thread(
                create_text_overlay, overlay_path, overlay_item, render_width, render_height
            )
            text_overlay_paths.append(overlay_path)
            text_overlay_sizes.append(overlay_size)
        sticker_overlay_paths = []
        for index, sticker_item in enumerate(sticker_items):
            overlay_path = os.path.join(OUTPUT_DIR, f"sticker_{job_id}_{index}.png")
            await asyncio.to_thread(
                create_sticker_overlay, overlay_path, sticker_item, render_width, render_height
            )
            sticker_overlay_paths.append(overlay_path)
        
        lines = []
        n = len(segments)
        fast_path_segments = 0
        
        for i, seg in enumerate(segments):
            start = seg["start"]
            end = seg["end"]
            speed = seg.get("speed", 1)
            clip_duration = clip_durations[i]
            gap_before = segment_gaps[i]
            source_info = video_input_map[seg["fileId"]]
            input_index = source_info["index"]
            video_filters = f"trim=start={start}:end={end}"
            if seg.get("reverse", False):
                video_filters += ",reverse"
            stabilization = seg.get("stabilization", "none")
            if stabilization == "light":
                video_filters += ",deshake=rx=16:ry=16:edge=mirror"
            elif stabilization == "strong":
                video_filters += ",deshake=rx=32:ry=32:edge=mirror"
            if seg.get("deflicker", False):
                video_filters += ",deflicker=size=5:mode=am"
            denoise = seg.get("denoise", 0) / 100
            if denoise > 0.001:
                video_filters += f",hqdn3d={1 + denoise * 5:.4f}:{1 + denoise * 4:.4f}:{2 + denoise * 7:.4f}:{2 + denoise * 6:.4f}"
            motion_blur = seg.get("motionBlur", 0)
            if motion_blur >= 4:
                blur_frames = 3 if motion_blur < 60 else 5
                video_filters += f",tmix=frames={blur_frames}"
            video_filters += f",setpts=(PTS-STARTPTS)/{speed:.8f}"
            fit = seg.get("fit", "cover")
            if fit == "contain":
                video_filters += (
                    f",scale={render_width}:{render_height}:force_original_aspect_ratio=decrease"
                )
            elif fit == "stretch":
                video_filters += f",scale={render_width}:{render_height}"
            else:
                video_filters += (
                    f",scale={render_width}:{render_height}:force_original_aspect_ratio=increase"
                    f",crop={render_width}:{render_height}"
                )
            if seg.get("flipX", False):
                video_filters += ",hflip"
            if seg.get("flipY", False):
                video_filters += ",vflip"
            effect_filter = VIDEO_EFFECT_FILTERS.get(seg.get("effect", "none"), "")
            if effect_filter:
                video_filters += f",{effect_filter}"
            clip_filter = CLIP_FILTER_FILTERS.get(seg.get("filter", "none"), "")
            if clip_filter:
                video_filters += f",{clip_filter}"
            lut_filter = LUT_FILTERS.get(seg.get("lut", "none"), "")
            if lut_filter:
                video_filters += f",{lut_filter}"
            curve_filter = CURVE_FILTERS.get(seg.get("curvePreset", "none"), "")
            if curve_filter:
                video_filters += f",{curve_filter}"
            brightness = (
                seg.get("brightness", 100) - 100
                + seg.get("exposure", 0) * .55
                + seg.get("lightness", 0) * .35
                + seg.get("relight", 0) * .35
                + seg.get("fade", 0) * .15
            ) / 100
            brightness = max(-1.0, min(1.0, brightness))
            contrast = (
                seg.get("contrast", 100) - seg.get("fade", 0) * .35
                + seg.get("highlights", 0) * .18 - seg.get("shadows", 0) * .12
            ) / 100
            contrast = max(.05, min(3.0, contrast))
            saturation = seg.get("saturation", 100) / 100
            gamma = max(.25, min(4.0, 1 + seg.get("shadows", 0) * .003 - seg.get("highlights", 0) * .002))
            if (
                abs(brightness) > .00001
                or abs(contrast - 1) > .00001
                or abs(saturation - 1) > .00001
                or abs(gamma - 1) > .00001
            ):
                video_filters += f",eq=brightness={brightness:.5f}:contrast={contrast:.5f}:saturation={saturation:.5f}:gamma={gamma:.5f}"
            temperature = seg.get("temperature", 0) / 1000
            tint = seg.get("tint", 0) / 1000
            if abs(temperature) > 0.0001 or abs(tint) > 0.0001:
                video_filters += f",colorbalance=rs={temperature:.5f}:gm={tint:.5f}:bs={-temperature:.5f}"
            hue = seg.get("hue", 0)
            if abs(hue) > .01:
                video_filters += f",hue=h={hue:.5f}"
            blend_mode = seg.get("blendMode", "normal")
            if blend_mode == "multiply":
                video_filters += ",eq=brightness=-.07:contrast=1.12"
            elif blend_mode == "screen":
                video_filters += ",eq=brightness=.08:contrast=.9"
            elif blend_mode == "overlay":
                video_filters += ",eq=contrast=1.24:saturation=1.08"
            sharpen = seg.get("sharpen", 0) / 100
            if sharpen > .001:
                video_filters += f",unsharp=5:5:{min(2.0, sharpen * 1.8):.5f}:5:5:0"
            if seg.get("opticalFlow", False):
                video_filters += f",minterpolate=fps={target_fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"
            if seg.get("backgroundMode") == "chroma":
                chroma_color = seg.get("keyColor", "#00FF00").lstrip("#")
                similarity = seg.get("keySimilarity", 25) / 100
                blend = seg.get("keyBlend", 8) / 100
                video_filters += f",chromakey=0x{chroma_color}:{similarity:.5f}:{blend:.5f}"
            animation = seg.get("animation", "none")
            animation_duration = min(seg.get("animationDuration", 0.5), clip_duration / 2)
            animation_frames = max(1, round(animation_duration * target_fps))
            total_frames = max(1, round(clip_duration * target_fps))
            if animation == "fade" and animation_duration >= 0.05:
                fade_out_start = max(0.0, clip_duration - animation_duration)
                video_filters += (
                    f",fade=t=in:st=0:d={animation_duration:.5f}"
                    f",fade=t=out:st={fade_out_start:.5f}:d={animation_duration:.5f}"
                )
            elif animation == "fadein" and animation_duration >= 0.05:
                video_filters += f",fade=t=in:st=0:d={animation_duration:.5f}"
            elif animation == "fadeout" and animation_duration >= 0.05:
                video_filters += f",fade=t=out:st={max(0.0, clip_duration-animation_duration):.5f}:d={animation_duration:.5f}"
            elif animation in {"zoom", "kenburnsleft", "kenburnsright", "kenburnsup", "kenburnsdown"}:
                x_expression = "(iw-iw/zoom)/2"
                y_expression = "(ih-ih/zoom)/2"
                if animation == "kenburnsleft":
                    x_expression = f"(iw-iw/zoom)*(1-on/{total_frames})"
                elif animation == "kenburnsright":
                    x_expression = f"(iw-iw/zoom)*on/{total_frames}"
                elif animation == "kenburnsup":
                    y_expression = f"(ih-ih/zoom)*(1-on/{total_frames})"
                elif animation == "kenburnsdown":
                    y_expression = f"(ih-ih/zoom)*on/{total_frames}"
                video_filters += (
                    f",zoompan=z='min(1.12,1+on/{total_frames}*.12)'"
                    f":x='{x_expression}':y='{y_expression}':d=1:s={render_width}x{render_height}:fps={target_fps}"
                )
            elif animation == "zoomout":
                video_filters += (
                    f",zoompan=z='max(1,1.12-on/{total_frames}*.12)'"
                    f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={render_width}x{render_height}:fps={target_fps}"
                )
            elif animation in {"zoominfast", "focusin"}:
                video_filters += (
                    f",zoompan=z='min(1.22,1+on/{animation_frames}*.22)'"
                    f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={render_width}x{render_height}:fps={target_fps}"
                )
                if animation == "focusin":
                    video_filters += f",gblur=sigma=2:enable='lt(t,{animation_duration:.5f})'"
            elif animation in {"zoomoutfast", "focusout"}:
                video_filters += (
                    f",zoompan=z='max(1,1.22-on/{animation_frames}*.22)'"
                    f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={render_width}x{render_height}:fps={target_fps}"
                )
                if animation == "focusout":
                    video_filters += f",gblur=sigma=2:enable='gte(t,{max(0.0, clip_duration-animation_duration):.5f})'"
            elif animation == "pop":
                video_filters += (
                    f",zoompan=z='min(1,0.55+on/{animation_frames}*0.45)'"
                    f":d=1:s={render_width}x{render_height}:fps={target_fps}"
                    f",fade=t=in:st=0:d={animation_duration:.5f}"
                )
            elif animation in {"pulse", "heartbeat"}:
                cycles = 8 if animation == "heartbeat" else 3
                amplitude = .055 if animation == "heartbeat" else .035
                video_filters += (
                    f",zoompan=z='1.001+{amplitude:.5f}*(1+sin(on/{total_frames}*2*PI*{cycles}))/2'"
                    f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={render_width}x{render_height}:fps={target_fps}"
                )
            elif animation == "blurin":
                video_filters += f",gblur=sigma=3:enable='lt(t,{animation_duration:.5f})',fade=t=in:st=0:d={animation_duration:.5f}"
            elif animation == "blurout":
                fade_out_start = max(0.0, clip_duration - animation_duration)
                video_filters += f",gblur=sigma=3:enable='gte(t,{fade_out_start:.5f})',fade=t=out:st={fade_out_start:.5f}:d={animation_duration:.5f}"
            elif animation == "flash":
                video_filters += f",fade=t=in:st=0:d={animation_duration:.5f}:color=white"
            elif animation == "cinematic":
                video_filters += (
                    f",zoompan=z='max(1,1.08-on/{total_frames}*.04)'"
                    f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={render_width}x{render_height}:fps={target_fps}"
                    f",fade=t=in:st=0:d={animation_duration:.5f}"
                    f",fade=t=out:st={max(0.0, clip_duration-animation_duration):.5f}:d={animation_duration:.5f}"
                )
            elif animation == "flicker":
                video_filters += ",eq=brightness='0.08*sin(18*PI*t)':eval=frame"
            elif animation == "strobe":
                video_filters += ",eq=brightness='0.18*max(0,sin(12*PI*t))':eval=frame"
            elif animation == "flipx":
                video_filters += f",hflip=enable='lt(t,{animation_duration / 2:.5f})',fade=t=in:st=0:d={animation_duration:.5f}"
            elif animation == "flipy":
                video_filters += f",vflip=enable='lt(t,{animation_duration / 2:.5f})',fade=t=in:st=0:d={animation_duration:.5f}"
            scale_expression = zoom_keyframe_scale_expression(
                seg.get("scale", 100), seg.get("zoomKeyframes", [])
            )
            if animation == "breathe":
                scale_expression = f"({scale_expression})*(1+.025*sin(t*2*PI/{max(.2, clip_duration):.8f}*3))"
            elif animation == "elastic":
                scale_expression = f"({scale_expression})*(1+.18*sin(t*18)*exp(-t*5))"
            elif animation == "rubber":
                scale_expression = f"({scale_expression})*(1+.07*sin(t*26)*max(0,1-t/{animation_duration:.8f}))"
            focus_x_expression = zoom_keyframe_focus_expression(seg.get("zoomKeyframes", []), "x")
            focus_y_expression = zoom_keyframe_focus_expression(seg.get("zoomKeyframes", []), "y")
            fixed_zoom_transform = bool(seg.get("zoomKeyframes")) or animation in {"breathe", "elastic", "rubber"}
            if fixed_zoom_transform:
                zoom_expression = re.sub(r"\bt\b", "it", scale_expression)
                zoom_focus_x = re.sub(r"\bt\b", "it", focus_x_expression)
                zoom_focus_y = re.sub(r"\bt\b", "it", focus_y_expression)
                video_filters += (
                    f",zoompan=z='max(1,({zoom_expression}))':"
                    f"x='max(0,min(iw-iw/zoom,iw*({zoom_focus_x})-iw/(2*zoom)))':"
                    f"y='max(0,min(ih-ih/zoom,ih*({zoom_focus_y})-ih/(2*zoom)))':"
                    f"d=1:s={render_width}x{render_height}:fps={target_fps}"
                )
            opacity_expression = zoom_keyframe_opacity_expression(
                seg.get("opacity", 100), seg.get("zoomKeyframes", [])
            )
            opacity_geq_expression = re.sub(r"\bt\b", "T", opacity_expression)
            angle = seg.get("rotation", 0) * math.pi / 180
            angle_expression = f"{angle:.8f}"
            if animation == "rotatein":
                angle_expression = f"{angle:.8f}-(1-min(t/{animation_duration:.5f},1))*.42"
            elif animation == "rotateout":
                angle_expression = f"{angle:.8f}+(1-min(({clip_duration:.5f}-t)/{animation_duration:.5f},1))*.42"
            elif animation == "spin":
                angle_expression = f"{angle:.8f}-(1-min(t/{animation_duration:.5f},1))*6.28318531"
            elif animation == "spinout":
                angle_expression = f"{angle:.8f}+max(0,1-min(({clip_duration:.5f}-t)/{animation_duration:.5f},1))*6.28318531"
            elif animation == "swing":
                angle_expression = f"{angle:.8f}+sin(t*6)*.07"
            elif animation in {"wobble", "sway"}:
                angle_expression = f"{angle:.8f}+sin(t*{10 if animation == 'wobble' else 3})*{'.095' if animation == 'wobble' else '.055'}"
            mask = seg.get("mask", "none")
            position_x = 50 if seg.get("autoReframe", False) else seg.get("x", 50)
            position_y = 50 if seg.get("autoReframe", False) else seg.get("y", 50)
            visible_filter = "" if job.get("video_visible", True) else ",drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill"
            gap_video_filter = (
                f",tpad=start_duration={gap_before:.8f}:start_mode=add:color=black"
                if gap_before >= .001 else ""
            )
            opacity_is_animated = any(
                abs(float(frame.get("opacity", 100)) - 100) > .001
                for frame in seg.get("zoomKeyframes", [])
            )
            needs_canvas = (
                fit == "contain"
                or (not fixed_zoom_transform and abs(seg.get("scale", 100) - 100) > .001)
                or abs(seg.get("opacity", 100) - 100) > .001
                or opacity_is_animated
                or abs(seg.get("rotation", 0)) > .001
                or abs(position_x - 50) > .001
                or abs(position_y - 50) > .001
                or animation in CANVAS_CLIP_ANIMATIONS
                or seg.get("backgroundMode") == "chroma"
                or (seg.get("backgroundMode") == "brush" and bool(seg.get("brushStrokes")))
                or mask in {"circle", "ellipse", "rounded"}
            )
            if needs_canvas:
                transform_scale_filter = "" if fixed_zoom_transform else (
                    f",scale=w='max(2,trunc(iw*({scale_expression})/2)*2)':"
                    f"h='max(2,trunc(ih*({scale_expression})/2)*2)':eval=frame"
                )
                video_filters += (
                    f"{transform_scale_filter},format=rgba,"
                    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                    f"a='alpha(X,Y)*({opacity_geq_expression})',"
                    f"rotate='{angle_expression}':ow=iw:oh=ih:c=none,"
                    "setsar=1"
                )
                if seg.get("backgroundMode") == "brush" and seg.get("brushStrokes"):
                    brush_terms = []
                    for stroke in seg["brushStrokes"]:
                        radius = max(.01, min(.15, stroke.get("size", 12) / 200))
                        for point in stroke.get("points", []):
                            brush_terms.append(
                                "lte(pow((X-W*{x:.6f})/(min(W,H)*{r:.6f}),2)+"
                                "pow((Y-H*{y:.6f})/(min(W,H)*{r:.6f}),2),1)".format(
                                    x=point["x"], y=point["y"], r=radius
                                )
                            )
                            if len(brush_terms) >= 120:
                                break
                        if len(brush_terms) >= 120:
                            break
                    if brush_terms:
                        brush_condition = "+".join(brush_terms)
                        brush_alpha = (
                            f"if(gt({brush_condition},0),alpha(X,Y),0)"
                            if seg.get("brushMode") == "keep"
                            else f"if(gt({brush_condition},0),0,alpha(X,Y))"
                        )
                        video_filters += (
                            ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                            f"a='{brush_alpha}'"
                        )
                if mask in {"circle", "ellipse", "rounded"}:
                    mask_expression = alpha_mask_expression(
                        mask, seg.get("maskScale", 100), seg.get("maskX", 50), seg.get("maskY", 50)
                    )
                    video_filters += (
                        ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                        f"a='{mask_expression}'"
                    )
                    if seg.get("maskFeather", 0) >= 1:
                        video_filters += f",gblur=sigma={seg['maskFeather'] / 3:.5f}:planes=8"
                # MOV streams commonly use a finer source time base (for example
                # 1/600). Normalize both inputs before overlay framesync.
                video_filters += (
                    f",fps={target_fps},settb=AVTB,"
                    f"setpts=N/({target_fps}*TB)"
                )
                foreground_label = f"[clipfg{i}]"
                lines.append(f"[{input_index}:v]{video_filters}{foreground_label}")
                lines.append(
                    f"color=c=black:s={render_width}x{render_height}:r={target_fps}:d={clip_duration:.8f},"
                    f"settb=AVTB,setpts=N/({target_fps}*TB)[clipbg{i}]"
                )
                if fixed_zoom_transform:
                    base_x = f"W*{position_x / 100:.6f}-w/2"
                    base_y = f"H*{position_y / 100:.6f}-h/2"
                else:
                    zoom_width_delta = f"(w-w/max(({scale_expression}),.0001))"
                    zoom_height_delta = f"(h-h/max(({scale_expression}),.0001))"
                    base_x = (
                        f"W*{position_x / 100:.6f}-w/2+"
                        f"({zoom_width_delta})*(.5-({focus_x_expression}))"
                    )
                    base_y = (
                        f"H*{position_y / 100:.6f}-h/2+"
                        f"({zoom_height_delta})*(.5-({focus_y_expression}))"
                    )
                x_expr, y_expr = base_x, base_y
                if animation == "slideleft":
                    x_expr = f"if(lt(t,{animation_duration:.6f}),-w+(({base_x})+w)*t/{animation_duration:.6f},{base_x})"
                elif animation == "slideright":
                    x_expr = f"if(lt(t,{animation_duration:.6f}),W+(({base_x})-W)*t/{animation_duration:.6f},{base_x})"
                elif animation == "slideup":
                    y_expr = f"if(lt(t,{animation_duration:.6f}),H+(({base_y})-H)*t/{animation_duration:.6f},{base_y})"
                elif animation == "slidedown":
                    y_expr = f"if(lt(t,{animation_duration:.6f}),-h+(({base_y})+h)*t/{animation_duration:.6f},{base_y})"
                elif animation == "bounce":
                    y_expr = f"({base_y})-abs(sin(t*12))*H*.12*max(0,1-t/{animation_duration:.6f})"
                elif animation == "shake":
                    x_expr = f"({base_x})+sin(t*75)*W*.018*max(0,1-t/{animation_duration:.6f})"
                elif animation == "driftleft":
                    x_expr = f"({base_x})-W*.08*t/{clip_duration:.6f}"
                elif animation == "driftright":
                    x_expr = f"({base_x})+W*.08*t/{clip_duration:.6f}"
                elif animation == "driftup":
                    y_expr = f"({base_y})-H*.07*t/{clip_duration:.6f}"
                elif animation == "driftdown":
                    y_expr = f"({base_y})+H*.07*t/{clip_duration:.6f}"
                elif animation in {"slideleftout", "revealleft"}:
                    x_expr = f"if(gt(t,{clip_duration-animation_duration:.6f}),({base_x})-W*(t-{clip_duration-animation_duration:.6f})/{animation_duration:.6f},{base_x})"
                elif animation in {"sliderightout", "revealright"}:
                    x_expr = f"if(gt(t,{clip_duration-animation_duration:.6f}),({base_x})+W*(t-{clip_duration-animation_duration:.6f})/{animation_duration:.6f},{base_x})"
                elif animation in {"slideupout", "revealup"}:
                    y_expr = f"if(gt(t,{clip_duration-animation_duration:.6f}),({base_y})-H*(t-{clip_duration-animation_duration:.6f})/{animation_duration:.6f},{base_y})"
                elif animation in {"slidedownout", "revealdown"}:
                    y_expr = f"if(gt(t,{clip_duration-animation_duration:.6f}),({base_y})+H*(t-{clip_duration-animation_duration:.6f})/{animation_duration:.6f},{base_y})"
                elif animation in {"whipleft", "cinematicleft"}:
                    x_expr = f"({base_x})-W*{'.22' if animation == 'whipleft' else '.06'}*t/{clip_duration:.6f}"
                elif animation in {"whipright", "cinematicright"}:
                    x_expr = f"({base_x})+W*{'.22' if animation == 'whipright' else '.06'}*t/{clip_duration:.6f}"
                elif animation == "rise":
                    y_expr = f"if(lt(t,{animation_duration:.6f}),({base_y})+H*.28*(1-t/{animation_duration:.6f}),{base_y})"
                elif animation == "drop":
                    y_expr = f"if(lt(t,{animation_duration:.6f}),({base_y})-H*.28*(1-t/{animation_duration:.6f}),{base_y})"
                elif animation == "float":
                    y_expr = f"({base_y})+sin(t*2.4)*H*.018"
                elif animation in {"wobble", "sway"}:
                    x_expr = f"({base_x})+sin(t*{10 if animation == 'wobble' else 3})*W*{'.018' if animation == 'wobble' else '.012'}"
                lines.append(
                    f"[clipbg{i}]{foreground_label}overlay=x='{x_expr}':y='{y_expr}':"
                    f"shortest=1:eval=frame{visible_filter},fps={target_fps},format=yuv420p,settb=AVTB"
                    f"{gap_video_filter}[v{i}]"
                )
            else:
                fast_path_segments += 1
                video_filters += (
                    f",setsar=1,fps={target_fps},settb=AVTB,"
                    f"setpts=N/({target_fps}*TB),format=yuv420p"
                )
                lines.append(
                    f"[{input_index}:v]{video_filters}{visible_filter}{gap_video_filter}[v{i}]"
                )
            audio_filters = f"atrim=start={start}:end={end}"
            if seg.get("reverse", False):
                audio_filters += ",areverse"
            audio_filters += f",asetpts=PTS-STARTPTS,{atempo_chain(speed)}"
            if seg.get("noiseReduction", False):
                audio_filters += ",afftdn=nf=-30:tn=1:gs=8"
            if seg.get("enhanceVoice", False):
                audio_filters += ",highpass=f=80,lowpass=f=12000,equalizer=f=3000:t=q:w=1:g=3,acompressor=threshold=.063:ratio=3:attack=15:release=250:makeup=2"
            if seg.get("normalizeAudio", False):
                audio_filters += ",loudnorm=I=-16:LRA=7:TP=-1.5"
            voice_changer = seg.get("voiceChanger", "none")
            if voice_changer == "deep":
                audio_filters += ",aresample=48000,asetrate=39360,aresample=48000,atempo=1.21951220"
            elif voice_changer == "chipmunk":
                audio_filters += ",aresample=48000,asetrate=60000,aresample=48000,atempo=.8"
            elif voice_changer == "robot":
                audio_filters += ",tremolo=f=35:d=.75,aecho=.8:.65:12:.18"
            channel_mode = seg.get("channelMode", "stereo")
            if channel_mode == "left":
                audio_filters += ",pan=stereo|c0=c0|c1=c0"
            elif channel_mode == "right":
                audio_filters += ",pan=stereo|c0=c1|c1=c1"
            elif channel_mode == "mono":
                audio_filters += ",pan=stereo|c0=.5*c0+.5*c1|c1=.5*c0+.5*c1"
            balance = seg.get("audioBalance", 0) / 100
            left_gain = 1.0 if balance <= 0 else 1.0 - balance
            right_gain = 1.0 if balance >= 0 else 1.0 + balance
            if abs(balance) > .001:
                audio_filters += f",pan=stereo|c0={left_gain:.5f}*c0|c1={right_gain:.5f}*c1"
            audio_fade_in = seg.get("audioFadeIn", 0)
            audio_fade_out = seg.get("audioFadeOut", 0)
            if audio_fade_in >= .01:
                audio_filters += f",afade=t=in:st=0:d={audio_fade_in:.5f}"
            if audio_fade_out >= .01:
                audio_filters += f",afade=t=out:st={max(0, clip_duration - audio_fade_out):.5f}:d={audio_fade_out:.5f}"
            clip_volume = 0 if job.get("mute_video_audio", False) or seg.get("muted", False) else seg.get("volume", 1)
            audio_filters += f",volume={clip_volume:.6f}"
            if gap_before >= .001:
                audio_filters += f",adelay={round(gap_before * 1000)}:all=1"
            if source_info.get("hasAudio", True):
                lines.append(f"[{input_index}:a]{audio_filters}[a{i}]")
            else:
                lines.append(
                    f"anullsrc=r=48000:cl=stereo,atrim=duration={clip_duration + gap_before},"
                    f"asetpts=PTS-STARTPTS,volume={clip_volume:.6f}[a{i}]"
                )

        current_video = "[v0]"
        current_audio = "[a0]"
        combined_duration = segment_durations[0]
        for index in range(n - 1):
            next_video = f"[joinv{index}]"
            next_audio = f"[joina{index}]"
            transition = transition_map.get(index)
            if transition:
                duration = transition["duration"]
                offset = max(0.0, combined_duration - duration)
                lines.append(
                    f"{current_video}[v{index + 1}]xfade="
                    f"transition={transition['type']}:duration={duration}:offset={offset}"
                    f"{next_video}"
                )
                lines.append(
                    f"{current_audio}[a{index + 1}]acrossfade=d={duration}:c1=tri:c2=tri"
                    f"{next_audio}"
                )
                combined_duration += segment_durations[index + 1] - duration
            else:
                lines.append(
                    f"{current_video}[v{index + 1}]concat=n=2:v=1:a=0{next_video}"
                )
                lines.append(
                    f"{current_audio}[a{index + 1}]concat=n=2:v=0:a=1{next_audio}"
                )
                combined_duration += segment_durations[index + 1]
            current_video = next_video
            current_audio = next_audio

        for index, image_item in enumerate(image_items):
            input_index = len(video_inputs) + len(text_overlay_paths) + len(sticker_overlay_paths) + index
            scaled_label = f"[imageasset{index}]"
            next_label = f"[imagev{index}]"
            image_mask = image_item.get("mask", "none")
            background_filters = ["format=rgba"]
            if image_item.get("backgroundMode") == "chroma":
                chroma_color = image_item.get("keyColor", "#00FF00").lstrip("#")
                similarity = image_item.get("keySimilarity", 25) / 100
                blend = image_item.get("keyBlend", 8) / 100
                background_filters.append(
                    f"colorkey=0x{chroma_color}:{similarity:.5f}:{blend:.5f}"
                )
            elif image_item.get("backgroundMode") == "brush" and image_item.get("brushStrokes"):
                brush_terms = []
                for stroke in image_item["brushStrokes"]:
                    radius = max(.01, min(.15, stroke.get("size", 12) / 200))
                    for point in stroke.get("points", []):
                        brush_terms.append(
                            "lte(pow((X-W*{x:.6f})/(min(W,H)*{r:.6f}),2)+"
                            "pow((Y-H*{y:.6f})/(min(W,H)*{r:.6f}),2),1)".format(
                                x=point["x"], y=point["y"], r=radius
                            )
                        )
                        if len(brush_terms) >= 120:
                            break
                    if len(brush_terms) >= 120:
                        break
                if brush_terms:
                    brush_condition = "+".join(brush_terms)
                    brush_alpha = (
                        f"if(gt({brush_condition},0),alpha(X,Y),0)"
                        if image_item.get("brushMode") == "keep"
                        else f"if(gt({brush_condition},0),0,alpha(X,Y))"
                    )
                    background_filters.append(
                        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                        f"a='{brush_alpha}'"
                    )
            background_prefix = ",".join(background_filters)
            if image_mask in {"circle", "ellipse", "rounded"}:
                mask_expression = alpha_mask_expression(
                    image_mask, image_item.get("maskScale", 100),
                    image_item.get("maskX", 50), image_item.get("maskY", 50)
                )
                mask_filter = (
                    f"{background_prefix},scale={render_width}:{render_height}:force_original_aspect_ratio=increase,"
                    f"crop={render_width}:{render_height},"
                    f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{mask_expression}'"
                )
                if image_item.get("maskFeather", 0) >= 1:
                    mask_filter += f",gblur=sigma={image_item['maskFeather'] / 3:.5f}:planes=8"
                lines.append(f"[{input_index}:v]{mask_filter}{scaled_label}")
                x_expr, y_expr = "0", "0"
            else:
                target_width = max(2, int(render_width * image_item["scale"] / 100))
                angle = image_item.get("rotation", 0) * math.pi / 180
                lines.append(
                    f"[{input_index}:v]{background_prefix},scale={target_width}:-2,"
                    f"rotate={angle:.8f}:ow=rotw(iw):oh=roth(ih):c=none,"
                    f"format=rgba{scaled_label}"
                )
                x_expr = f"max(0,min(W-w,W*{image_item['x'] / 100:.5f}-w/2))"
                y_expr = f"max(0,min(H-h,H*{image_item['y'] / 100:.5f}-h/2))"
            lines.append(
                f"{current_video}{scaled_label}overlay=x='{x_expr}':y='{y_expr}':"
                f"enable='between(t,{image_item['start']},{image_item['end']})':"
                f"eof_action=pass:shortest=1{next_label}"
            )
            current_video = next_label

        for index, text_item in enumerate(text_items):
            input_index = len(video_inputs) + index
            next_label = f"[textv{index}]"
            overlay_input = f"[{input_index}:v]"
            frames = text_item.get("transformKeyframes", [])
            x_expr = "0"
            y_expr = "0"
            if frames:
                text_scale = zoom_keyframe_scale_expression(100, frames)
                text_opacity = zoom_keyframe_opacity_expression(100, frames)
                text_opacity = re.sub(r"\bt\b", "T", text_opacity)
                source_width, source_height = text_overlay_sizes[index]
                maximum_scale = max(1.0, max(frame.get("scale", 100) for frame in frames) / 100)
                padded_width = max(4, int(math.ceil(source_width * maximum_scale / 2) * 2 + 4))
                padded_height = max(4, int(math.ceil(source_height * maximum_scale / 2) * 2 + 4))
                text_x = zoom_keyframe_focus_expression(frames, "x", text_item.get("x", 50))
                text_y = zoom_keyframe_focus_expression(frames, "y", text_item.get("y", 50))
                relative_time = f"(t-{text_item['start']:.8f})"
                text_x = re.sub(r"\bt\b", relative_time, text_x)
                text_y = re.sub(r"\bt\b", relative_time, text_y)
                animated_label = f"[textasset{index}]"
                lines.append(
                    f"{overlay_input}format=rgba,"
                    f"scale=w='max(2,trunc(iw*({text_scale})/2)*2)':"
                    f"h='max(2,trunc(ih*({text_scale})/2)*2)':eval=frame,"
                    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                    f"a='alpha(X,Y)*({text_opacity})',"
                    f"pad={padded_width}:{padded_height}:x='(ow-iw)/2':y='(oh-ih)/2':"
                    f"color=black@0{animated_label}"
                )
                overlay_input = animated_label
                x_expr = f"W*({text_x})-w/2"
                y_expr = f"H*({text_y})-h/2"
            lines.append(
                f"{current_video}{overlay_input}overlay=x='{x_expr}':y='{y_expr}':"
                f"enable='between(t,{text_item['start']},{text_item['end']})':"
                f"eof_action=pass:shortest=1{next_label}"
            )
            current_video = next_label
        for index, sticker_item in enumerate(sticker_items):
            input_index = len(video_inputs) + len(text_overlay_paths) + index
            next_label = f"[stickerv{index}]"
            lines.append(
                f"{current_video}[{input_index}:v]overlay=0:0:"
                f"enable='between(t,{sticker_item['start']},{sticker_item['end']})':"
                f"eof_action=pass:shortest=1{next_label}"
            )
            current_video = next_label
        lines.append(f"{current_video}null[outv]")

        audio_labels = []
        for index, audio_item in enumerate(audio_items):
            input_index = (
                len(video_inputs) + len(text_overlay_paths) + len(sticker_overlay_paths)
                + len(image_items) + index
            )
            label = f"[mediaa{index}]"
            layer_duration = audio_item["end"] - audio_item["start"]
            delay_ms = max(0, round(audio_item["start"] * 1000))
            lines.append(
                f"[{input_index}:a]atrim=start={audio_item['sourceStart']}:"
                f"duration={layer_duration},asetpts=PTS-STARTPTS,"
                f"volume={audio_item['volume']},adelay={delay_ms}:all=1{label}"
            )
            audio_labels.append(label)
        if audio_labels:
            lines.append(
                f"{current_audio}{''.join(audio_labels)}amix=inputs={len(audio_labels) + 1}:"
                f"duration=first:dropout_transition=0:normalize=0,alimiter=limit=.95[outa]"
            )
        else:
            lines.append(f"{current_audio}anull[outa]")
        
        with open(script_path, "w") as f:
            f.write(";\n".join(lines))
            
        cmd = [FFMPEG_BIN, "-y", "-nostdin", "-hide_banner"]
        if LOW_MEMORY_RENDER:
            cmd.extend(["-filter_complex_threads", "1"])
        for video_input in video_inputs:
            cmd.extend(["-i", video_input["path"]])
        for overlay_path in text_overlay_paths + sticker_overlay_paths:
            cmd.extend(["-framerate", str(target_fps), "-loop", "1", "-i", overlay_path])
        for image_item in image_items:
            cmd.extend(["-framerate", str(target_fps), "-loop", "1", "-i", image_item["path"]])
        for audio_item in audio_items:
            cmd.extend(["-i", audio_item["path"]])
        cmd.extend(ffmpeg_filter_script_args(script_path))
        cmd.extend(["-map", "[outv]", "-map", "[outa]"])
        
        fmt = job['format'].lower()
        crf = {"draft": 30, "standard": 23, "high": 18, "ultra": 14}[quality]
        preset_map = {"draft": "veryfast", "standard": "medium", "high": "slow", "ultra": "slower"}
        if LOW_MEMORY_RENDER:
            preset_map = {"draft": "ultrafast", "standard": "veryfast", "high": "faster", "ultra": "medium"}
        preset = preset_map[quality]
        render_fmt = "mp4" if fmt in {"gif", "mp3"} else fmt
        if render_fmt == "mp4":
            cmd.extend(["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
        elif fmt == "webm":
            cmd.extend(["-c:v", "libvpx-vp9", "-crf", str(crf), "-b:v", "0", "-c:a", "libopus", "-b:a", "160k"])
        elif fmt == "mkv":
            cmd.extend(["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.extend(["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
        if LOW_MEMORY_RENDER:
            cmd.extend(["-threads:v", str(RENDER_THREAD_LIMIT), "-threads:a", "1"])
            if render_fmt != "webm":
                cmd.extend([
                    "-x264-params",
                    f"threads={RENDER_THREAD_LIMIT}:lookahead_threads=1:sync-lookahead=0:rc-lookahead=10",
                ])
            
        cmd.extend(["-r", str(target_fps), render_path])
        
        text_message = f", {len(text_items)} metin" if text_items else ""
        sticker_message = f", {len(sticker_items)} sticker" if sticker_items else ""
        image_message = f", {len(image_items)} görsel" if image_items else ""
        audio_message = f", {len(audio_items)} ses" if audio_items else ""
        transition_message = f", {len(transitions)} geçiş" if transitions else ""
        await q.put({"type": "log", "message": f"FFmpeg komutu çalıştırılıyor (Toplam {n} parça{text_message}{sticker_message}{image_message}{audio_message}{transition_message}, ~{total_duration:.2f}s çıktı)."})
        if fast_path_segments:
            await q.put({
                "type": "log",
                "message": f"Hızlı render etkin: {fast_path_segments}/{n} klipte gereksiz saydamlık ve katman işlemleri atlandı.",
            })
        if LOW_MEMORY_RENDER:
            await q.put({
                "type": "log",
                "message": f"Windows düşük bellek renderı etkin: {RENDER_THREAD_LIMIT} encoder iş parçacığı, tek filtre iş parçacığı.",
            })
        
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stderr=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE
        )
        
        ffmpeg_stderr_tail = await collect_ffmpeg_stderr(proc, q, total_duration)

        await proc.wait()
        final_returncode = proc.returncode

        if final_returncode == 0 and fmt in {"gif", "mp3"}:
            await q.put({"type": "log", "message": "Seçilen son biçim hazırlanıyor..."})
            if fmt == "mp3":
                audio_bitrate = {"draft": "128k", "standard": "192k", "high": "256k", "ultra": "320k"}[quality]
                convert_cmd = [FFMPEG_BIN, "-y", "-i", render_path, "-vn", "-c:a", "libmp3lame", "-b:a", audio_bitrate, out_path]
            else:
                gif_fps = min(30, target_fps)
                gif_filter = (
                    f"fps={gif_fps},split[s0][s1];[s0]palettegen=max_colors="
                    f"{128 if quality == 'draft' else 256}[p];[s1][p]paletteuse=dither=bayer"
                )
                convert_cmd = [FFMPEG_BIN, "-y", "-i", render_path, "-vf", gif_filter, "-loop", "0", out_path]
            convert_proc = await asyncio.create_subprocess_exec(
                *convert_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            _, convert_error = await convert_proc.communicate()
            if convert_proc.returncode != 0:
                conversion_detail = convert_error.decode("utf-8", errors="ignore")
                ffmpeg_stderr_tail.extend(conversion_detail.splitlines()[-40:])
                await q.put({"type": "log", "message": conversion_detail[-1200:]})
                final_returncode = convert_proc.returncode
            try:
                os.remove(render_path)
            except OSError:
                pass

        if final_returncode == 0:
            await q.put({"type": "progress", "percent": 100})
            await q.put({"type": "log", "message": "Render başarıyla tamamlandı!"})
            await q.put({"type": "result", "download_url": f"/download/{job_id}/{fmt}"})
        else:
            await q.put({
                "type": "error",
                "message": format_ffmpeg_error(final_returncode, ffmpeg_stderr_tail),
            })
            
    except Exception as e:
        await q.put({"type": "error", "message": f"Hata oluştu: {str(e)}"})
    finally:
        await q.put(None)

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


# ══════════════════════════════════════════════════════════
#  Güncelleme API'si
# ══════════════════════════════════════════════════════════

@app.get("/api/version")
async def api_version():
    return {"version": APP_VERSION}


@app.get("/api/check-update")
async def api_check_update():
    """GitHub Releases API'sine bakarak yeni sürüm olup olmadığını kontrol eder."""
    if not GITHUB_REPO:
        return {"update_available": False, "reason": "GITHUB_REPO ayarlanmamış"}
    import urllib.request
    api_url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    req = urllib.request.Request(api_url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "OtomatikEdit-Updater/1.0",
    })
    try:
        ssl_ctx = _make_ssl_context()
        with urllib.request.urlopen(req, timeout=10, context=ssl_ctx) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return {"update_available": False, "reason": str(exc)}

    remote_tag = data.get("tag_name", "").lstrip("vV")
    if not remote_tag:
        return {"update_available": False, "reason": "Release tag bulunamadı"}

    def ver_tuple(v):
        parts = []
        for p in v.split("."):
            try:
                parts.append(int(p))
            except ValueError:
                parts.append(0)
        return tuple(parts)

    if ver_tuple(remote_tag) <= ver_tuple(APP_VERSION):
        return {"update_available": False, "current": APP_VERSION, "latest": remote_tag}

    # İlk ZIP asset'ini bul
    download_url = ""
    for asset in data.get("assets", []):
        if asset.get("name", "").endswith(".zip"):
            download_url = asset.get("browser_download_url", "")
            break

    return {
        "update_available": True,
        "current": APP_VERSION,
        "latest": remote_tag,
        "download_url": download_url,
        "release_notes": data.get("body", ""),
        "published_at": data.get("published_at", ""),
    }


@app.post("/api/apply-update")
async def api_apply_update(request: Request):
    """Güncelleme ZIP'ini indirir, dosyaları güvenli şekilde günceller."""
    body = await request.json()
    download_url = body.get("download_url", "").strip()
    if not download_url:
        raise HTTPException(400, "download_url gerekli")

    job_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue()
    jobs[job_id] = {"type": "update", "q": q}

    async def _apply():
        import urllib.request
        import tempfile
        import zipfile

        try:
            await q.put({"type": "log", "message": "Güncelleme indiriliyor..."})

            req = urllib.request.Request(download_url, headers={
                "User-Agent": "OtomatikEdit-Updater/1.0",
            })
            temp_zip = os.path.join(tempfile.gettempdir(), f"otamatik_update_{job_id}.zip")

            loop = asyncio.get_running_loop()

            def _download():
                ssl_ctx = _make_ssl_context()
                with urllib.request.urlopen(req, timeout=120, context=ssl_ctx) as resp, open(temp_zip, "wb") as out:
                    total = int(resp.headers.get("Content-Length", "0") or 0)
                    downloaded = 0
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        downloaded += len(chunk)
                        if total:
                            pct = min(100, round(downloaded / total * 100))
                            asyncio.run_coroutine_threadsafe(
                                q.put({"type": "progress", "percent": pct, "phase": "download"}),
                                loop,
                            )

            await asyncio.to_thread(_download)
            await q.put({"type": "log", "message": "İndirme tamamlandı. Dosyalar çıkarılıyor..."})

            # Yedek al
            os.makedirs(BACKUP_DIR, exist_ok=True)
            backup_targets = ["app.py", "templates", "requirements.txt",
                              "windows_setup.py", "version.json"]
            for name in backup_targets:
                src = os.path.join(BASE_DIR, name)
                dst = os.path.join(BACKUP_DIR, name)
                if os.path.isfile(src):
                    shutil.copy2(src, dst)
                elif os.path.isdir(src):
                    if os.path.exists(dst):
                        shutil.rmtree(dst)
                    shutil.copytree(src, dst)

            await q.put({"type": "log", "message": "Mevcut dosyalar yedeklendi (.backup/)."})

            # ZIP'i geçici dizine aç ve dosyaları kopyala
            temp_extract = os.path.join(tempfile.gettempdir(), f"otamatik_extract_{job_id}")
            if os.path.exists(temp_extract):
                shutil.rmtree(temp_extract)

            with zipfile.ZipFile(temp_zip) as zf:
                zf.extractall(temp_extract)

            # ZIP içinde tek bir kök dizin olabilir, onu tespit et
            top_items = os.listdir(temp_extract)
            source_dir = temp_extract
            if len(top_items) == 1:
                single = os.path.join(temp_extract, top_items[0])
                if os.path.isdir(single):
                    source_dir = single

            # Dosyaları kopyala (korunan dizinleri atla)
            copied = 0
            for item in os.listdir(source_dir):
                if item in _PROTECTED_DIRS:
                    continue
                src_path = os.path.join(source_dir, item)
                dst_path = os.path.join(BASE_DIR, item)
                if os.path.isdir(src_path):
                    if os.path.exists(dst_path):
                        shutil.rmtree(dst_path)
                    shutil.copytree(src_path, dst_path)
                else:
                    shutil.copy2(src_path, dst_path)
                copied += 1

            await q.put({"type": "log", "message": f"{copied} dosya/klasör güncellendi."})

            # Temizlik
            try:
                os.remove(temp_zip)
                shutil.rmtree(temp_extract, ignore_errors=True)
            except Exception:
                pass

            # Bağımlılıkları güncelle
            await q.put({"type": "log", "message": "Bağımlılıklar kontrol ediliyor..."})
            req_file = os.path.join(BASE_DIR, "requirements.txt")
            if os.path.isfile(req_file):
                venv_pip = None
                for candidate in [
                    os.path.join(BASE_DIR, ".venv-windows", "Scripts", "pip.exe"),
                    os.path.join(BASE_DIR, ".venv-windows", "Scripts", "pip3.exe"),
                    os.path.join(BASE_DIR, "venv", "bin", "pip3"),
                    os.path.join(BASE_DIR, "venv", "bin", "pip"),
                ]:
                    if os.path.isfile(candidate):
                        venv_pip = candidate
                        break
                if venv_pip:
                    proc = await asyncio.create_subprocess_exec(
                        venv_pip, "install", "-r", req_file,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                    )
                    stdout, _ = await proc.communicate()
                    pip_out = stdout.decode("utf-8", errors="replace").strip().split("\n")
                    for line in pip_out[-3:]:
                        if line.strip():
                            await q.put({"type": "log", "message": f"[pip] {line.strip()}"})

            # Yeni sürümü oku
            new_version = "?"
            try:
                with open(os.path.join(BASE_DIR, "version.json"), "r", encoding="utf-8") as f:
                    new_version = json.load(f).get("version", "?")
            except Exception:
                pass

            await q.put({"type": "progress", "percent": 100, "phase": "done"})
            await q.put({"type": "log", "message": f"✅ Güncelleme tamamlandı! Yeni sürüm: v{new_version}"})
            await q.put({"type": "result", "new_version": new_version})

        except Exception as exc:
            await q.put({"type": "error", "message": f"Güncelleme hatası: {exc}"})
        finally:
            await q.put(None)

    asyncio.create_task(_apply())
    return {"job_id": job_id}


def _project_file(project_id: str) -> str:
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", project_id or ""):
        raise HTTPException(400, "Geçersiz proje kimliği")
    return os.path.join(PROJECT_DIR, f"{project_id}.json")


@app.get("/projects")
async def list_projects():
    projects = []
    for filename in os.listdir(PROJECT_DIR):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(PROJECT_DIR, filename), "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            projects.append({
                "id": payload.get("id", filename[:-5]),
                "name": payload.get("name", "Adsız proje"),
                "updated_at": payload.get("updated_at", ""),
                "timeline_count": len(payload.get("timelines", [])),
            })
        except (OSError, ValueError, TypeError):
            continue
    projects.sort(key=lambda item: item.get("updated_at", ""), reverse=True)
    return {"projects": projects}


@app.get("/projects/{project_id}")
async def load_project(project_id: str):
    path = _project_file(project_id)
    if not os.path.isfile(path):
        raise HTTPException(404, "Proje bulunamadı")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as exc:
        raise HTTPException(500, "Proje dosyası okunamadı") from exc


@app.post("/projects")
async def save_project(request: Request):
    raw = await request.body()
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(413, "Proje verisi çok büyük")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(400, "Geçersiz proje verisi") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("timelines"), list):
        raise HTTPException(400, "Geçersiz proje yapısı")
    project_id = str(payload.get("id") or uuid.uuid4())
    path = _project_file(project_id)
    name = str(payload.get("name") or "Adsız proje").strip()[:80] or "Adsız proje"
    from datetime import datetime, timezone
    payload.update({
        "id": project_id,
        "name": name,
        "version": 2,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    temporary = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return {"id": project_id, "name": name, "updated_at": payload["updated_at"]}


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    path = _project_file(project_id)
    if not os.path.isfile(path):
        raise HTTPException(404, "Proje bulunamadı")
    os.remove(path)
    return {"deleted": True}


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    import shutil
    safe_name = os.path.basename(file.filename or "dosya")
    media_kind = get_media_kind(safe_name, file.content_type or "")
    if not media_kind:
        raise HTTPException(400, "Desteklenmeyen dosya türü")
    file_id = str(uuid.uuid4()) + "_" + safe_name
    filepath = os.path.join(UPLOAD_DIR, file_id)
    with open(filepath, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    duration = 0.0
    if media_kind in {"video", "audio"}:
        duration = await asyncio.to_thread(get_video_duration, filepath)
    return {
        "file_id": file_id,
        "name": safe_name,
        "media_kind": media_kind,
        "duration": duration,
        "url": f"/video/{file_id}",
    }

@app.post("/start-analysis")
async def start_analysis(
    file_id: str = Form(...),
    threshold: float = Form(-30.0),
    duration: float = Form(0.5),
    keywords: str = Form("")
):
    filepath = os.path.join(UPLOAD_DIR, os.path.basename(file_id))
    if not os.path.exists(filepath):
        raise HTTPException(404, "Dosya bulunamadı")
        
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "type": "analysis",
        "file_id": file_id,
        "filepath": filepath,
        "threshold": threshold,
        "duration": duration,
        "keywords": keywords,
        "q": asyncio.Queue()
    }
    asyncio.create_task(run_analysis_job(job_id))
    return {"job_id": job_id}

@app.post("/start-subtitles")
async def start_subtitles(
    file_id: str = Form(...),
    clip_start: float = Form(...),
    clip_end: float = Form(...),
    timeline_start: float = Form(0.0),
    speed: float = Form(1.0),
    target_language: str = Form(...),
):
    filepath = os.path.join(UPLOAD_DIR, os.path.basename(file_id))
    if not os.path.exists(filepath) or get_media_kind(file_id) != "video":
        raise HTTPException(404, "Altyazı oluşturulacak video bulunamadı")
    if target_language not in {"tr", "en"}:
        raise HTTPException(400, "Altyazı dili yalnızca Türkçe veya English olabilir")
    if not all(math.isfinite(value) for value in (clip_start, clip_end, timeline_start, speed)):
        raise HTTPException(400, "Geçersiz altyazı zaman bilgisi")
    duration = await asyncio.to_thread(get_video_duration, filepath)
    if clip_start < 0 or clip_end <= clip_start or clip_end > duration + 0.1:
        raise HTTPException(400, "Altyazı aralığı video sınırlarının dışında")
    if timeline_start < 0 or speed < 0.25 or speed > 4.0:
        raise HTTPException(400, "Geçersiz timeline veya hız değeri")

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "type": "subtitles",
        "file_id": file_id,
        "filepath": filepath,
        "clip_start": clip_start,
        "clip_end": clip_end,
        "timeline_start": timeline_start,
        "speed": speed,
        "target_language": target_language,
        "q": asyncio.Queue(),
    }
    asyncio.create_task(run_subtitle_job(job_id))
    return {"job_id": job_id}

@app.post("/start-render")
async def start_render(
    file_id: str = Form(...),
    fmt: str = Form("mp4"),
    fps: int = Form(30),
    quality: str = Form("standard"),
    segments: str = Form(...), # JSON string
    texts: str = Form("[]"),
    stickers: str = Form("[]"),
    transitions: str = Form("[]"),
    images: str = Form("[]"),
    audio_layers: str = Form("[]"),
    video_visible: bool = Form(True),
    mute_video_audio: bool = Form(False),
    width: int = Form(0),
    height: int = Form(0)
):
    filepath = os.path.join(UPLOAD_DIR, os.path.basename(file_id))
    if not os.path.exists(filepath):
        raise HTTPException(404, "Dosya bulunamadı")
        
    fmt = fmt.lower()
    if fmt not in ALLOWED_FORMATS:
        raise HTTPException(400, "Desteklenmeyen çıktı formatı")
    if fps not in {24, 25, 30, 50, 60}:
        raise HTTPException(400, "Desteklenmeyen FPS değeri")
    quality = quality.strip().lower()
    if quality not in ALLOWED_QUALITIES:
        raise HTTPException(400, "Desteklenmeyen kalite ayarı")
    if bool(width) != bool(height):
        raise HTTPException(400, "Çıktı genişliği ve yüksekliği birlikte gönderilmeli")
    if width or height:
        if width < 64 or height < 64 or width > 7680 or height > 4320:
            raise HTTPException(400, "Desteklenmeyen çıktı boyutu")
        if width % 2 or height % 2:
            raise HTTPException(400, "Çıktı boyutları çift sayı olmalı")

    job_id = str(uuid.uuid4())
    try:
        parsed_segments = json.loads(segments)
    except Exception:
        raise HTTPException(400, "Geçersiz bölümler")
    try:
        parsed_texts = json.loads(texts)
    except Exception:
        raise HTTPException(400, "Geçersiz metin katmanları")
    try:
        parsed_stickers = json.loads(stickers)
    except Exception:
        raise HTTPException(400, "Geçersiz sticker katmanları")
    try:
        parsed_transitions = json.loads(transitions)
    except Exception:
        raise HTTPException(400, "Geçersiz geçişler")
    try:
        parsed_images = json.loads(images)
    except Exception:
        raise HTTPException(400, "Geçersiz görsel katmanları")
    try:
        parsed_audio_layers = json.loads(audio_layers)
    except Exception:
        raise HTTPException(400, "Geçersiz ses katmanları")

    if not isinstance(parsed_segments, list) or not parsed_segments or len(parsed_segments) > 500:
        raise HTTPException(400, "Geçerli bir klip listesi gerekli")

    video_sources = {}
    normalized_segments = []
    for segment in parsed_segments:
        segment_file_id = os.path.basename(str(segment.get("fileId") or file_id))
        segment_path = os.path.join(UPLOAD_DIR, segment_file_id)
        if not os.path.exists(segment_path) or get_media_kind(segment_file_id) != "video":
            raise HTTPException(400, "Timeline'daki video dosyası bulunamadı")
        if segment_file_id not in video_sources:
            video_sources[segment_file_id] = {
                "fileId": segment_file_id,
                "path": segment_path,
                "duration": await asyncio.to_thread(get_video_duration, segment_path),
                "hasAudio": await asyncio.to_thread(video_has_audio, segment_path),
            }
        video_duration = video_sources[segment_file_id]["duration"]
        try:
            start = float(segment["start"])
            end = float(segment["end"])
            speed = float(segment.get("speed", 1))
            volume = float(segment.get("volume", 1))
            scale = float(segment.get("scale", 100))
            opacity = float(segment.get("opacity", 100))
            position_x = float(segment.get("x", 50))
            position_y = float(segment.get("y", 50))
            rotation = float(segment.get("rotation", 0))
            brightness = float(segment.get("brightness", 100))
            contrast = float(segment.get("contrast", 100))
            saturation = float(segment.get("saturation", 100))
            temperature = float(segment.get("temperature", 0))
            animation_duration = float(segment.get("animationDuration", 0.5))
            key_similarity = float(segment.get("keySimilarity", 25))
            key_blend = float(segment.get("keyBlend", 8))
            brush_size = float(segment.get("brushSize", 12))
            sharpen = float(segment.get("sharpen", 0))
            denoise = float(segment.get("denoise", 0))
            motion_blur = float(segment.get("motionBlur", 0))
            relight = float(segment.get("relight", 0))
            audio_fade_in = float(segment.get("audioFadeIn", 0))
            audio_fade_out = float(segment.get("audioFadeOut", 0))
            audio_balance = float(segment.get("audioBalance", 0))
            exposure = float(segment.get("exposure", 0))
            tint = float(segment.get("tint", 0))
            fade = float(segment.get("fade", 0))
            hue = float(segment.get("hue", 0))
            lightness = float(segment.get("lightness", 0))
            shadows = float(segment.get("shadows", 0))
            highlights = float(segment.get("highlights", 0))
            mask_scale = float(segment.get("maskScale", 100))
            mask_x = float(segment.get("maskX", 50))
            mask_y = float(segment.get("maskY", 50))
            mask_feather = float(segment.get("maskFeather", 0))
            raw_timeline_start = segment.get("timelineStart")
            timeline_start = None if raw_timeline_start is None else float(raw_timeline_start)
        except (KeyError, TypeError, ValueError):
            raise HTTPException(400, "Geçersiz klip sınırları")
        numeric_values = (
            start, end, speed, volume, scale, opacity, position_x, position_y,
            rotation, brightness, contrast, saturation, temperature, animation_duration,
            key_similarity, key_blend, brush_size, sharpen, denoise, motion_blur, relight,
            audio_fade_in, audio_fade_out, audio_balance, exposure, tint, fade,
            hue, lightness, shadows, highlights, mask_scale, mask_x, mask_y, mask_feather
        )
        if not all(math.isfinite(value) for value in numeric_values):
            raise HTTPException(400, "Geçersiz klip sınırları")
        if timeline_start is not None and (not math.isfinite(timeline_start) or timeline_start < 0):
            raise HTTPException(400, "Geçersiz timeline konumu")
        if start < 0 or end <= start or end > video_duration + 0.1:
            raise HTTPException(400, "Klip video süresinin dışında")
        effect = str(segment.get("effect", "none")).strip().lower()
        if effect not in ALLOWED_VIDEO_EFFECTS:
            raise HTTPException(400, "Desteklenmeyen video efekti")
        clip_filter = str(segment.get("filter", "none")).strip().lower()
        if clip_filter not in ALLOWED_CLIP_FILTERS:
            raise HTTPException(400, "Desteklenmeyen filtre")
        fit = str(segment.get("fit", "cover")).strip().lower()
        if fit not in ALLOWED_CLIP_FITS:
            raise HTTPException(400, "Desteklenmeyen kadraj ayarı")
        animation = str(segment.get("animation", "none")).strip().lower()
        if animation not in ALLOWED_CLIP_ANIMATIONS:
            raise HTTPException(400, "Desteklenmeyen klip animasyonu")
        background_mode = str(segment.get("backgroundMode", "none")).strip().lower()
        brush_mode = str(segment.get("brushMode", "keep")).strip().lower()
        blend_mode = str(segment.get("blendMode", "normal")).strip().lower()
        stabilization = str(segment.get("stabilization", "none")).strip().lower()
        voice_changer = str(segment.get("voiceChanger", "none")).strip().lower()
        channel_mode = str(segment.get("channelMode", "stereo")).strip().lower()
        lut = str(segment.get("lut", "none")).strip().lower()
        curve_preset = str(segment.get("curvePreset", "none")).strip().lower()
        mask = str(segment.get("mask", "none")).strip().lower()
        enum_values = (
            (background_mode, ALLOWED_BACKGROUND_MODES, "arka plan işlemi"),
            (brush_mode, ALLOWED_BRUSH_MODES, "fırça maske modu"),
            (blend_mode, ALLOWED_BLEND_MODES, "karıştırma modu"),
            (stabilization, ALLOWED_STABILIZATION, "sabitleme ayarı"),
            (voice_changer, ALLOWED_VOICE_CHANGERS, "ses değiştirici"),
            (channel_mode, ALLOWED_CHANNEL_MODES, "ses kanalı"),
            (lut, ALLOWED_LUTS, "LUT"),
            (curve_preset, ALLOWED_CURVES, "kavis ayarı"),
            (mask, ALLOWED_MASKS, "maske"),
        )
        for value, allowed, label in enum_values:
            if value not in allowed:
                raise HTTPException(400, f"Desteklenmeyen {label}")
        normalized_brush_strokes = []
        raw_brush_strokes = segment.get("brushStrokes", [])
        if isinstance(raw_brush_strokes, list):
            point_count = 0
            for raw_stroke in raw_brush_strokes[:40]:
                if not isinstance(raw_stroke, dict):
                    continue
                try:
                    stroke_size = max(2.0, min(30.0, float(raw_stroke.get("size", brush_size))))
                except (TypeError, ValueError):
                    stroke_size = max(2.0, min(30.0, brush_size))
                points = []
                for raw_point in raw_stroke.get("points", []) if isinstance(raw_stroke.get("points", []), list) else []:
                    if point_count >= 180 or not isinstance(raw_point, dict):
                        break
                    try:
                        point_x = max(0.0, min(1.0, float(raw_point.get("x", 0))))
                        point_y = max(0.0, min(1.0, float(raw_point.get("y", 0))))
                    except (TypeError, ValueError):
                        continue
                    if not math.isfinite(point_x) or not math.isfinite(point_y):
                        continue
                    points.append({"x": point_x, "y": point_y})
                    point_count += 1
                if points:
                    normalized_brush_strokes.append({"size": stroke_size, "points": points})
                if point_count >= 180:
                    break
        output_duration = (end - start) / max(0.25, min(4.0, speed))
        normalized_segments.append({
            "fileId": segment_file_id,
            "start": start,
            "end": min(end, video_duration),
            "effect": effect,
            "filter": clip_filter,
            "speed": max(0.25, min(4.0, speed)),
            "volume": max(0.0, min(2.0, volume)),
            "muted": bool(segment.get("muted", False)),
            "reverse": bool(segment.get("reverse", False)),
            "fit": fit,
            "scale": max(25.0, min(200.0, scale)),
            "zoomKeyframes": normalize_zoom_keyframes(segment.get("zoomKeyframes", []), output_duration),
            "opacity": max(0.0, min(100.0, opacity)),
            "x": max(0.0, min(100.0, position_x)),
            "y": max(0.0, min(100.0, position_y)),
            "rotation": max(-360.0, min(360.0, rotation)),
            "flipX": bool(segment.get("flipX", False)),
            "flipY": bool(segment.get("flipY", False)),
            "backgroundMode": background_mode,
            "keyColor": normalize_hex_color(segment.get("keyColor"), "#00FF00"),
            "keySimilarity": max(1.0, min(80.0, key_similarity)),
            "keyBlend": max(0.0, min(50.0, key_blend)),
            "brushMode": brush_mode,
            "brushSize": max(2.0, min(30.0, brush_size)),
            "brushStrokes": normalized_brush_strokes,
            "blendMode": blend_mode,
            "stabilization": stabilization,
            "sharpen": max(0.0, min(100.0, sharpen)),
            "denoise": max(0.0, min(100.0, denoise)),
            "deflicker": bool(segment.get("deflicker", False)),
            "opticalFlow": bool(segment.get("opticalFlow", False)),
            "motionBlur": max(0.0, min(100.0, motion_blur)),
            "autoReframe": bool(segment.get("autoReframe", False)),
            "relight": max(-100.0, min(100.0, relight)),
            "audioFadeIn": max(0.0, min(output_duration / 2, audio_fade_in)),
            "audioFadeOut": max(0.0, min(output_duration / 2, audio_fade_out)),
            "normalizeAudio": bool(segment.get("normalizeAudio", False)),
            "enhanceVoice": bool(segment.get("enhanceVoice", False)),
            "noiseReduction": bool(segment.get("noiseReduction", False)),
            "voiceChanger": voice_changer,
            "audioBalance": max(-100.0, min(100.0, audio_balance)),
            "channelMode": channel_mode,
            "brightness": max(0.0, min(200.0, brightness)),
            "contrast": max(0.0, min(200.0, contrast)),
            "saturation": max(0.0, min(200.0, saturation)),
            "temperature": max(-100.0, min(100.0, temperature)),
            "exposure": max(-100.0, min(100.0, exposure)),
            "tint": max(-100.0, min(100.0, tint)),
            "fade": max(0.0, min(100.0, fade)),
            "lut": lut,
            "hue": max(-180.0, min(180.0, hue)),
            "lightness": max(-100.0, min(100.0, lightness)),
            "curvePreset": curve_preset,
            "shadows": max(-100.0, min(100.0, shadows)),
            "highlights": max(-100.0, min(100.0, highlights)),
            "mask": mask,
            "maskScale": max(10.0, min(150.0, mask_scale)),
            "maskX": max(0.0, min(100.0, mask_x)),
            "maskY": max(0.0, min(100.0, mask_y)),
            "maskFeather": max(0.0, min(35.0, mask_feather)),
            "animation": animation,
            "animationDuration": max(0.1, min(2.0, animation_duration)),
            "timelineStart": timeline_start,
        })

    timeline_cursor = 0.0
    for segment in normalized_segments:
        duration = (segment["end"] - segment["start"]) / segment["speed"]
        if segment["timelineStart"] is None:
            segment["timelineStart"] = timeline_cursor
        timeline_cursor = max(timeline_cursor, segment["timelineStart"] + duration)
    normalized_segments.sort(key=lambda segment: segment["timelineStart"])
    previous_end = 0.0
    for segment in normalized_segments:
        duration = (segment["end"] - segment["start"]) / segment["speed"]
        if segment["timelineStart"] < previous_end - .02:
            raise HTTPException(400, "Video klipleri aynı kanalda üst üste binemez")
        previous_end = segment["timelineStart"] + duration
    hard_cut_duration = max(
        segment["timelineStart"] + (segment["end"] - segment["start"]) / segment["speed"]
        for segment in normalized_segments
    )
    normalized_transitions = normalize_transition_items(parsed_transitions, normalized_segments)
    normalized_texts = normalize_text_items(parsed_texts, hard_cut_duration)
    normalized_texts = adjust_texts_for_transitions(
        normalized_texts, normalized_transitions, normalized_segments
    )
    normalized_stickers = normalize_sticker_items(parsed_stickers, hard_cut_duration)
    normalized_stickers = adjust_texts_for_transitions(
        normalized_stickers, normalized_transitions, normalized_segments
    )
    normalized_images = normalize_image_layers(parsed_images, hard_cut_duration)
    normalized_images = adjust_texts_for_transitions(
        normalized_images, normalized_transitions, normalized_segments
    )
    normalized_audio_layers = normalize_audio_layers(parsed_audio_layers, hard_cut_duration)
    normalized_audio_layers = adjust_texts_for_transitions(
        normalized_audio_layers, normalized_transitions, normalized_segments
    )
    source_width, source_height = await asyncio.to_thread(get_video_dimensions, filepath)
        
    jobs[job_id] = {
        "type": "render",
        "file_id": file_id,
        "filepath": filepath,
        "format": fmt,
        "fps": fps,
        "quality": quality,
        "width": width,
        "height": height,
        "source_width": source_width,
        "source_height": source_height,
        "segments": normalized_segments,
        "texts": normalized_texts,
        "stickers": normalized_stickers,
        "images": normalized_images,
        "audio_layers": normalized_audio_layers,
        "transitions": normalized_transitions,
        "video_visible": video_visible,
        "mute_video_audio": mute_video_audio,
        "video_inputs": list(video_sources.values()),
        "q": asyncio.Queue()
    }
    asyncio.create_task(run_render_job(job_id))
    return {"job_id": job_id}

@app.get("/stream-events/{job_id}")
async def stream_events(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404)
        
    async def event_generator():
        while True:
            msg = await job["q"].get()
            if msg is None:
                break
            yield f"data: {json.dumps(msg)}\n\n"
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")

def send_bytes_range_requests(file_obj: typing.BinaryIO, start: int, end: int, chunk_size: int = 65536):
    with file_obj as f:
        f.seek(start)
        while (pos := f.tell()) <= end:
            read_size = min(chunk_size, end + 1 - pos)
            data = f.read(read_size)
            if not data:
                break
            yield data

@app.get("/waveform/{file_id}")
async def get_waveform(
    file_id: str,
    start: float = 0.0,
    end: float = 0.0,
    width: int = 800,
    height: int = 44,
):
    import hashlib
    import subprocess

    safe_id = os.path.basename(file_id)
    path = os.path.join(UPLOAD_DIR, safe_id)
    if not os.path.exists(path) or get_media_kind(safe_id) not in {"video", "audio"}:
        raise HTTPException(404, "Medya bulunamadı")
    duration = await asyncio.to_thread(get_video_duration, path)
    start = max(0.0, min(float(start), max(0.0, duration - .02)))
    end = max(start + .02, min(float(end) if end > 0 else duration, duration))
    width = max(80, min(1600, int(width)))
    height = max(24, min(96, int(height)))
    cache_key = hashlib.sha1(
        f"{safe_id}:{start:.3f}:{end:.3f}:{width}:{height}".encode("utf-8")
    ).hexdigest()
    output_path = os.path.join(WAVEFORM_DIR, f"{cache_key}.png")

    def generate_waveform():
        command = [
            FFMPEG_BIN, "-v", "error", "-y", "-ss", f"{start:.3f}",
            "-t", f"{end - start:.3f}", "-i", path,
            "-filter_complex",
            f"aformat=channel_layouts=mono,showwavespic=s={width}x{height}:colors=0x4ade80:draw=full",
            "-frames:v", "1", output_path,
        ]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return result.returncode == 0 and os.path.exists(output_path)

    if not os.path.exists(output_path):
        generated = await asyncio.to_thread(generate_waveform)
        if not generated:
            svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
                f'<path d="M0 {height / 2:.1f}H{width}" stroke="#4ade80" stroke-width="2" '
                'stroke-dasharray="3 4" opacity=".55"/></svg>'
            )
            return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=3600"})
    return FileResponse(
        output_path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )

@app.get("/video/{file_id}")
async def get_video(file_id: str, request: Request):
    path = os.path.join(UPLOAD_DIR, os.path.basename(file_id))
    if not os.path.exists(path):
        raise HTTPException(404)
        
    file_size = os.path.getsize(path)
    range_header = request.headers.get("range")
    
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Encoding": "identity",
        "Content-Length": str(file_size),
        "Access-Control-Allow-Origin": "*",
    }
    
    start = 0
    end = file_size - 1
    status_code = 200
    
    if range_header:
        try:
            range_value = range_header.removeprefix("bytes=").split(",", 1)[0]
            start_str, end_str = range_value.split("-", 1)
            if not start_str and end_str:
                suffix_size = min(file_size, max(0, int(end_str)))
                start, end = file_size - suffix_size, file_size - 1
            else:
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else file_size - 1
        except (ValueError, TypeError):
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
        if start < 0 or start >= file_size or end < start:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
        end = min(end, file_size - 1)
        status_code = 206
        headers["Content-Length"] = str(end - start + 1)
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        
    file_obj = open(path, "rb")
    return StreamingResponse(
        send_bytes_range_requests(file_obj, start, end),
        media_type=mimetypes.guess_type(path)[0] or "application/octet-stream",
        headers=headers,
        status_code=status_code,
    )

@app.get("/download/{job_id}/{fmt}")
async def download_file(job_id: str, fmt: str):
    if fmt not in ALLOWED_FORMATS:
        raise HTTPException(400, "Desteklenmeyen çıktı formatı")
    path = os.path.join(OUTPUT_DIR, f"out_{job_id}.{fmt}")
    if os.path.exists(path):
        return FileResponse(path, media_type="application/octet-stream", filename=f"edited_video.{fmt}")
    raise HTTPException(404, "Dosya bulunamadı")

if __name__ == "__main__":
    import uvicorn
    multiprocessing.freeze_support()
    host = os.environ.get("SMART_EDITOR_HOST", "0.0.0.0")
    try:
        port = int(os.environ.get("SMART_EDITOR_PORT", "4242"))
    except ValueError:
        port = 4242
    if os.environ.get("SMART_EDITOR_OPEN_BROWSER") == "1":
        import webbrowser
        browser_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
        threading.Timer(1.5, lambda: webbrowser.open(f"http://{browser_host}:{port}")).start()
    uvicorn.run(app, host=host, port=port)
