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


def first_output_frame(time, fps):
    """The first display tick at or after a timeline boundary."""
    return math.ceil(time * fps - 1e-7)


def displayed_output_frame(time, fps):
    return math.floor(time * fps + 1e-7)


@dataclass(frozen=True)
class VideoFrameSpan:
    join_start: int
    picture_start: int
    end: int
    overlap: int

    @property
    def gap(self):
        return self.picture_start - self.join_start

    @property
    def pictures(self):
        return self.end - self.picture_start


def plan_video_frames(segments, timing, transitions, fps, *, multitrack):
    """Place half-open video spans on a common, absolute frame grid.

    Decoder frame counts never set a track's cut positions. Audio retains its
    continuous timeline. A legacy single track still shortens at each overlap.
    """
    incoming = {
        next_track_clip(segments, item["boundary"]): item["duration"] for item in transitions
    }
    previous = {}
    result = []
    for index, (segment, clip) in enumerate(zip(segments, timing.clips)):
        track = segment.get("videoTrack", 1) if multitrack else 1
        previous_time, previous_frame = previous.get(track, (0., 0))
        overlap_time = incoming.get(index, 0.)
        join_time = previous_time - overlap_time
        join_start = min(previous_frame, max(0, first_output_frame(join_time, fps)))
        picture_time = join_time + clip.gap
        end_time = join_time + clip.duration
        end = max(previous_frame, first_output_frame(end_time, fps))
        picture_start = min(end, max(join_start, first_output_frame(picture_time, fps)))
        result.append(VideoFrameSpan(join_start, picture_start, end, previous_frame - join_start))
        previous[track] = end_time, end
    return tuple(result)


@dataclass(frozen=True)
class SourceSamples:
    origin: float
    first_source_tick: int
    count: int
    timeline_offset: float
    reverse: bool


def source_frame_samples(clock, fps, preroll, first, last, *, snapshot=False):
    """Describe exact decoded source samples for a contiguous body frame range.

    Sample reverse playback on the same lattice in ascending source order,
    then reverse the resulting frames. Reversing decoded VFR frames directly
    associates their original durations with unrelated pictures.
    """
    origin = clock.source_time(-preroll)
    first_source_tick = -last if clock.reverse else first
    offset = first / fps if snapshot else 0
    return SourceSamples(origin, first_source_tick, last - first + 1, offset, clock.reverse)


@dataclass(frozen=True)
class SnapshotWindow:
    source_start: float
    source_duration: float


def snapshot_source_window(clock, elapsed, source_duration, *, allow_preroll):
    """Bound the decode window around the selected source picture."""
    if allow_preroll and elapsed < 0:
        target = min(source_duration, max(0, clock.source_time(elapsed)))
        trim_time = clock.output_time(target)
        window_start = clock.source_time(trim_time - .5)
        window_end = clock.source_time(trim_time + .25)
        lower_bound, upper_bound = 0, source_duration
    else:
        window_start = clock.source_time(max(0, elapsed - .5))
        window_end = clock.source_time(elapsed + .25)
        lower_bound, upper_bound = clock.source_start, clock.source_end
    if clock.reverse:
        source_start, source_end = max(lower_bound, window_end), min(upper_bound, window_start)
    else:
        source_start, source_end = max(lower_bound, window_start), min(upper_bound, window_end)
    return SnapshotWindow(source_start, max(.01, source_end - source_start))


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


def output_frame_time_us(frame, fps):
    return frame * MICROSECONDS_PER_SECOND // fps


def align_output_frame_timestamps(fps):
    """Use the same AVTB tick for a frame on either side of framesync."""
    return f"settb=AVTB,setpts=trunc(round(PTS*TB*{fps})*{MICROSECONDS_PER_SECOND}/{fps})"


def gif_clock_filters(fps, *, start=0, start_frame=0, snapshot_elapsed_us=None, cycle_duration=0):
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
        f"setpts=PTS+{start_frame},"
        + align_output_frame_timestamps(fps)
    )


def crossfade_boundaries(segments, transitions):
    """Return the ruler cut and overlap duration of each legacy transition."""
    boundaries = []
    for transition in transitions:
        clip = segments[transition["boundary"]]
        boundary = clip.get("timelineStart", 0) + ClipClock.from_segment(clip).duration
        boundaries.append((boundary, transition["duration"]))
    return boundaries


def subtitle_frame_interval(start, end, *, fps, duration):
    """Keep millisecond cue times and cover a real frame when a cue has none."""
    start_ms = round(start * 1000)
    end_ms = max(start_ms, round(end * 1000))
    first_frame = (start_ms * fps + 999) // 1000
    last_frame = max(0, math.ceil(duration * fps - 1e-7) - 1)
    visible_frame = min(first_frame, last_frame)
    visible_ms = visible_frame * 1000 // fps
    # A cue after the last frame begins on that frame. The half-open end must
    # include the chosen frame even when it falls between two milliseconds.
    return min(start_ms, visible_ms) / 1000, max(end_ms, visible_ms + 1) / 1000


def resolve_export_range(start, end, *, fps, timeline_duration, output_duration, segments, transitions):
    """Project the ruler endpoints onto the already composed export clock."""
    if start is None and end is None:
        return None
    if (start is None or end is None or not all(map(math.isfinite, (start, end)))
            or not 0 <= start < end <= timeline_duration + .00001):
        raise ValueError("Giriş ve çıkış noktaları timeline sınırları içinde olmalı.")

    boundaries = crossfade_boundaries(segments, transitions)

    def projected(time):
        # The incoming section already consumed by an overlap shares its end
        # with the outgoing transition in the legacy single-channel renderer.
        removed = sum(min(duration, max(0, time - boundary)) for boundary, duration in boundaries)
        return min(time - removed, output_duration)

    first, last = projected(start), projected(end)
    if last - first + .00001 < 1 / fps:
        raise ValueError("İşaretli çıktı aralığı en az bir kare sürmeli.")
    return first, last
