"""Shared source, clip and timeline clocks for FFmpeg render and snapshots."""
import math
from dataclasses import dataclass

from render_video_tracks import next_track_clip


@dataclass(frozen=True)
class ClipClock:
    source_start: float
    source_end: float
    speed: float
    reverse: bool

    @classmethod
    def from_segment(cls, segment):
        return cls(segment["start"], segment["end"], segment.get("speed", 1), segment.get("reverse", False))

    @property
    def duration(self):
        return self.output_time(self.source_start if self.reverse else self.source_end)

    def source_time(self, elapsed):
        """Map output seconds since clip start to the original media."""
        if self.reverse:
            return self.source_end - elapsed * self.speed
        return self.source_start + elapsed * self.speed

    def output_time(self, source_time):
        """Map original media seconds to seconds since clip start."""
        source_elapsed = (
            self.source_end - source_time if self.reverse else source_time - self.source_start
        )
        return source_elapsed / self.speed

    def video_timestamp_filters(self, *, snapshot_base=None, missing_handle=0):
        filters = f"setpts=(PTS-STARTPTS)/{self.speed:.8f}"
        if snapshot_base is not None:
            filters += f"+{snapshot_base:.8f}/TB"
        elif missing_handle > .00001:
            filters += f",tpad=start_duration={missing_handle:.8f}:start_mode=clone"
        return filters


@dataclass(frozen=True)
class SourceTrim:
    start: float
    end: float
    missing_handle: float


@dataclass(frozen=True)
class TimelineClip:
    clock: ClipClock
    gap: float
    preroll: float

    @property
    def duration(self):
        """Length of each stream sent to the track join, including padding."""
        return self.clock.duration + self.gap + self.preroll

    def source_trim(self, source_duration):
        start, end = self.clock.source_start, self.clock.source_end
        if not self.preroll:
            return SourceTrim(start, end, 0.0)
        earliest = self.clock.source_time(-self.preroll)
        if self.clock.reverse:
            end = min(source_duration, earliest)
            first_source_time = end
        else:
            start = max(0, earliest)
            first_source_time = start
        missing = max(0, self.preroll + self.clock.output_time(first_source_time))
        return SourceTrim(start, end, missing)


@dataclass(frozen=True)
class RenderTiming:
    clips: tuple[TimelineClip, ...]
    video_duration: float
    output_duration: float


def plan_render_timing(segments, transitions, *, multitrack, layer_duration, snapshot_fps=None):
    """Calculate clip spans once for video, audio and the timeline background."""
    prerolls = {
        next_track_clip(segments, item["boundary"]): item["duration"] for item in transitions
    } if multitrack else {}
    track_ends = {}
    clips = []
    for index, segment in enumerate(segments):
        clock = ClipClock.from_segment(segment)
        track = segment.get("videoTrack", 1) if multitrack else 1
        previous_end = track_ends.get(track, 0.0)
        start = max(0.0, float(segment.get("timelineStart", previous_end)))
        clips.append(TimelineClip(clock, max(0.0, start - previous_end), prerolls.get(index, 0.0)))
        track_ends[track] = start + clock.duration

    if multitrack:
        video_duration = max(track_ends.values(), default=0)
    else:
        video_duration = sum(clip.duration for clip in clips) - sum(item["duration"] for item in transitions)
    output_duration = 1 / snapshot_fps if snapshot_fps else max(video_duration, layer_duration)
    return RenderTiming(tuple(clips), video_duration, output_duration)


@dataclass(frozen=True)
class SnapshotWindow:
    source_start: float
    source_duration: float
    output_base: float
    trim_time: float


def snapshot_source_window(clock, elapsed, source_duration, *, allow_preroll):
    """Bound the decode window while retaining the clip-local seek and PTS."""
    if allow_preroll and elapsed < 0:
        target = min(source_duration, max(0, clock.source_time(elapsed)))
        trim_time = clock.output_time(target)
        window_start = clock.source_time(trim_time - .5)
        window_end = clock.source_time(trim_time + .25)
        lower_bound, upper_bound = 0, source_duration
    else:
        trim_time = elapsed
        window_start = clock.source_time(max(0, elapsed - .5))
        window_end = clock.source_time(elapsed + .25)
        lower_bound, upper_bound = clock.source_start, clock.source_end
    if clock.reverse:
        source_start, source_end = max(lower_bound, window_end), min(upper_bound, window_start)
        first_source_time = source_end
    else:
        source_start, source_end = max(lower_bound, window_start), min(upper_bound, window_end)
        first_source_time = source_start
    return SnapshotWindow(
        source_start, max(.01, source_end - source_start),
        clock.output_time(first_source_time), trim_time,
    )


def normalize_zoom_cadence(filters, fps, *, snapshot_base=None):
    # zoompan emits one frame per input and resets PTS. Resample the speed-
    # adjusted stream before it can discard the input clock and its EOF units.
    if ",zoompan=" not in filters:
        return filters
    filters = filters.replace(",zoompan=", f",fps={fps},zoompan=", 1)
    if snapshot_base is not None:
        filters = filters.replace(f":fps={fps}", f":fps={fps},setpts=PTS+{snapshot_base:.8f}/TB")
    return filters


MICROSECONDS_PER_SECOND = 1_000_000


def display_frame_time_us(time, fps):
    """Return the timestamp of the export frame still displayed at this time."""
    frame = math.floor(time * fps + 1e-7)
    return frame * MICROSECONDS_PER_SECOND // fps


def align_output_frame_timestamps(fps):
    """Use the same AVTB tick for a frame on either side of framesync."""
    return f"settb=AVTB,setpts=trunc(round(PTS*TB*{fps})*{MICROSECONDS_PER_SECOND}/{fps})"


def gif_clock_filters(fps, *, start=0, snapshot_elapsed_us=None, cycle_duration=0):
    """Sample GIF timestamps on the timeline frame grid or a snapshot at zero."""
    if snapshot_elapsed_us is None:
        offset = round(start * MICROSECONDS_PER_SECOND)
        fps_opts = ""
    else:
        cycle_us = round(cycle_duration * MICROSECONDS_PER_SECOND)
        elapsed = max(0, snapshot_elapsed_us)
        # Reuse one source cycle without advancing through the preceding loops.
        offset = -(elapsed % cycle_us) if cycle_us > 0 else 0
        fps_opts = ":start_time=0"
    # Round timestamps up so a GIF frame first appears on or after its
    # source timestamp. The same rule samples the reduced cycle at PTS zero.
    # Match the main stream's AVTB frame timestamps. Implicit framesync
    # rescaling can round the secondary tick up by one microsecond.
    return (
        f"settb=AVTB,setpts=PTS-STARTPTS{offset:+d},fps={fps}:round=up{fps_opts},"
        + align_output_frame_timestamps(fps)
    )
