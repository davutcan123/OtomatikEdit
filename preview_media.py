"""Browser-compatible preview media, independent of project sources and exports."""

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import threading
import weakref


CACHE_VERSION = 1
LIGHT_LONG_EDGE = 960


class PreviewError(Exception):
    """The source could not be prepared for playback."""


class PreviewBusy(PreviewError):
    """The desktop backend is preparing to stop."""


@dataclass(frozen=True)
class MediaProfile:
    video_index: int
    audio_index: int | None
    width: int
    height: int
    native: bool


def source_fingerprint(path):
    stat = path.stat()
    identity = (CACHE_VERSION, path.name, stat.st_dev, stat.st_ino, stat.st_size,
                stat.st_mtime_ns, stat.st_ctime_ns)
    return sha256(repr(identity).encode("utf-8")).hexdigest()


def profile_media(path, data):
    streams = data.get("streams", [])
    video = next((item for item in streams if item.get("codec_type") == "video"
                  and not item.get("disposition", {}).get("attached_pic")), None)
    if not video or min(video.get("width", 0), video.get("height", 0)) <= 0:
        raise PreviewError("Videoda görüntü akışı bulunamadı.")
    audio_streams = [item for item in streams if item.get("codec_type") == "audio"]
    audio = next((item for item in audio_streams if item.get("disposition", {}).get("default")),
                 audio_streams[0] if audio_streams else {})
    codec, pixel = video.get("codec_name"), video.get("pix_fmt")
    audio_codec = audio.get("codec_name")
    suffix = path.suffix.lower()
    formats = data.get("format", {}).get("format_name", "").split(",")
    quicktime = bool({"mp4", "mov"} & set(formats)) and suffix in {".mp4", ".mov", ".m4v"}
    webm = "webm" in formats and suffix == ".webm"
    native = (
        quicktime and audio_codec in {None, "aac", "mp3"}
        and ((codec == "h264" and pixel in {"yuv420p", "yuvj420p"})
             or (codec == "hevc" and pixel in {"yuv420p", "yuvj420p", "yuv420p10le"}))
        or webm and codec in {"vp8", "vp9", "av1"} and audio_codec in {None, "opus", "vorbis"}
    )
    return MediaProfile(video["index"], audio.get("index"), video["width"], video["height"], bool(native))


class PreviewCache:
    def __init__(self, directory, ffmpeg, ffprobe, spawn, begin_work):
        self.directory = Path(directory)
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.spawn, self.begin_work = spawn, begin_work
        self.profiles = OrderedDict()
        self.lock = threading.Lock()
        self.in_flight = {}
        self.worker_limits = weakref.WeakKeyDictionary()

    async def _run(self, args, *, timeout, capture=False):
        process = await self.spawn(
            *args, stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.communicate()
            raise
        if process.returncode != 0:
            raise PreviewError("Video önizlemesi hazırlanamadı.")
        return stdout

    async def _shared(self, key, make_result):
        loop = asyncio.get_running_loop()
        key = (loop, *key)
        task = self.in_flight.get(key)
        if task is None:
            release = self.begin_work()

            async def worker():
                with self.lock:
                    limit = self.worker_limits.get(loop)
                    if limit is None:
                        limit = asyncio.Semaphore(1)
                        self.worker_limits[loop] = limit
                async with limit:
                    return await make_result()

            try:
                task = loop.create_task(worker())
            except BaseException:
                release()
                raise
            self.in_flight[key] = task

            def finished(completed):
                self.in_flight.pop(key, None)
                release()
                if not completed.cancelled():
                    completed.exception()

            task.add_done_callback(finished)
        # Playback uses independent byte range requests. A replaced or closed
        # media element must not cancel work still needed by another preview.
        return await asyncio.shield(task)

    async def _inspect(self, path, fingerprint):
        with self.lock:
            cached = self.profiles.get(fingerprint)
            if cached is not None:
                self.profiles.move_to_end(fingerprint)
                return cached

        async def probe():
            output = await self._run([
                self.ffprobe, "-v", "error", "-show_entries",
                "stream=index,codec_type,codec_name,pix_fmt,width,height:"
                "stream_disposition=default,attached_pic:format=format_name",
                "-of", "json", str(path),
            ], timeout=20, capture=True)
            profile = profile_media(path, json.loads(output))
            with self.lock:
                self.profiles[fingerprint] = profile
                self.profiles.move_to_end(fingerprint)
                while len(self.profiles) > 256:
                    self.profiles.popitem(last=False)
            return profile

        return await self._shared((fingerprint, "metadata"), probe)

    async def _encode(self, source, fingerprint, profile, target, light):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, name = tempfile.mkstemp(prefix=".pending-", suffix=".mp4", dir=self.directory)
        os.close(descriptor)
        temporary = Path(name)
        try:
            limit = f"min(1,{LIGHT_LONG_EDGE}/max(iw,ih))" if light else "1"
            scale = f"scale=w='max(2,trunc(iw*{limit}/2)*2)':h='max(2,trunc(ih*{limit}/2)*2)'"
            args = [
                self.ffmpeg, "-nostdin", "-y", "-hide_banner", "-v", "error",
                "-threads", "2", "-i", str(source), "-map", f"0:{profile.video_index}",
            ]
            if profile.audio_index is not None:
                args.extend(["-map", f"0:{profile.audio_index}", "-c:a", "aac", "-ac", "2", "-b:a", "160k"])
            args.extend([
                "-vf", scale, "-filter_threads", "2", "-c:v", "libx264",
                "-threads:v", "2", "-preset", "veryfast", "-crf", "22" if light else "19",
                "-pix_fmt", "yuv420p", "-fps_mode", "vfr", "-movflags", "+faststart",
                "-map_metadata", "-1", "-map_chapters", "-1", str(temporary),
            ])
            await self._run(args, timeout=3600)
            if not temporary.stat().st_size or source_fingerprint(source) != fingerprint:
                raise PreviewError("Önizleme hazırlanırken kaynak değişti.")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    async def resolve(self, source, mode):
        source = Path(source)
        fingerprint = source_fingerprint(source)
        profile = await self._inspect(source, fingerprint)
        light = mode == "light" and max(profile.width, profile.height) > LIGHT_LONG_EDGE
        if profile.native and not light and mode != "compatible":
            return source, "original"
        variant = "light" if light else "compatible"
        target = self.directory / f"{fingerprint}-{variant}.mp4"
        if not target.is_file() or not target.stat().st_size:
            await self._shared((fingerprint, variant), lambda: self._encode(source, fingerprint, profile, target, light))
        return target, variant
