"""Plan one display tick and bounded decode windows for PNG export."""

import math

from render_timing import (
    MICROSECONDS_PER_SECOND,
    displayed_output_frame,
    first_output_frame,
    output_frame_time_us,
    plan_render_timing,
    plan_video_frames,
    snapshot_source_window,
    source_frame_samples,
)
from render_video_tracks import next_track_clip, video_track_groups


def prepare_snapshot_job(job, timeline_time, canvas_height=1080):
    """Select at most two active video inputs per track and a short window.

    Snapshot time is the editor's original timeline (including gaps), not the
    transition-shortened video export. The active transition occupies the final
    `duration` seconds of the outgoing clip, matching preview playback.
    """
    fps = job["fps"]
    segments = job["segments"]
    multitrack = job.get("multitrack", False)
    transitions = job["transitions"]
    # The legacy single-track export shortens overlaps. Its snapshots stay on
    # the editor ruler, while multitrack transitions have actual source handles.
    ruler_transitions = transitions if multitrack else []
    layer_duration = job.get("snapshot_timeline_duration", 0)
    timing = plan_render_timing(segments, ruler_transitions, multitrack=multitrack, layer_duration=layer_duration)
    spans = plan_video_frames(segments, timing, ruler_transitions, fps, multitrack=multitrack)
    final_frame = max(0, first_output_frame(timing.output_duration, fps) - 1)
    frame = displayed_output_frame(min(max(0.0, timeline_time), final_frame / fps), fps)
    # Source sampling, transition progress and overlays share the displayed tick.
    time_at = frame / fps
    sources = {source["fileId"]: source for source in job["video_inputs"]}

    def track_selection(indices):
        for transition in transitions:
            left = transition["boundary"]
            if left not in indices:
                continue
            right = next_track_clip(segments, left)
            if multitrack:
                first = spans[right].join_start
            else:
                end_time = segments[left]["timelineStart"] + timing.clips[left].clock.duration
                first = first_output_frame(end_time - transition["duration"], fps)
            if first <= frame < spans[left].end:
                progress = (frame - first) / fps
                overlap = (spans[left].end - first) / fps
                right_frame = frame - (spans[right].picture_start if multitrack else first)
                chosen = [(left, frame - spans[left].picture_start), (right, right_frame)]
                return chosen, {**transition, "duration": overlap}, progress
        return ([
            (index, frame - spans[index].picture_start)
            for index in indices if spans[index].picture_start <= frame < spans[index].end
        ], None, 0.0)

    selected, snapshot_tracks = [], []
    transition_at, transition_elapsed = None, 0.0
    if multitrack:
        for track, indices in video_track_groups(segments).items():
            chosen, transition, progress = track_selection(indices)
            if chosen:
                positions = list(range(len(selected), len(selected) + len(chosen)))
                snapshot_tracks.append({"track": track, "indices": positions,
                                        "transition": transition, "transition_elapsed": progress})
                selected.extend(chosen)
    else:
        selected, transition_at, transition_elapsed = track_selection(range(len(segments)))
    snapshot_segments, snapshot_sources = [], []
    for index, (original_index, body_frame) in enumerate(selected):
        seg = segments[original_index]
        clip_timing = timing.clips[original_index]
        span = spans[original_index]
        source = sources[seg["fileId"]]
        decoded_duration = source.get("duration", seg["end"])
        # Seek to bounded context, but retain the original PTS after seeking.
        # Resetting to the first decoded packet shifts VFR and off-grid trims.
        sampling_elapsed = body_frame / fps - clip_timing.preroll
        window = snapshot_source_window(
            clip_timing.clock, sampling_elapsed, decoded_duration, allow_preroll=multitrack,
        )
        first = max(0, body_frame - math.ceil(.5 * fps))
        last = max(body_frame, min(span.pictures - 1, body_frame + math.ceil(.25 * fps)))
        samples = source_frame_samples(
            clip_timing.clock, fps, clip_timing.preroll, first, last, snapshot=True,
        )
        source_trim = clip_timing.source_trim(decoded_duration)
        window_end = min(source_trim.end, window.source_start + window.source_duration + 1e-7)
        identifier = f"snapshot-{index}"
        snapshot_sources.append({
            **source, "fileId": identifier, "snapshot_seek": window.source_start,
            "snapshot_duration": window.source_duration, "snapshot_end": window_end,
            "snapshot_samples": samples, "snapshot_frame": body_frame - first, "snapshot_preroll": clip_timing.preroll,
        })
        snapshot_segments.append({**seg, "fileId": identifier, "timelineStart": 0,
                                  "snapshot_elapsed": max(0, sampling_elapsed)})
    selected_clip_frames = {segments[index].get("clipId"): local_frame for index, local_frame in selected}
    frame_us = output_frame_time_us(frame, fps)

    def prepare_layer(item):
        return {**item, "start": 0, "end": 1, "snapshot_elapsed": time_at - item["start"],
                "snapshot_layer_duration": item["end"] - item["start"], "_reference_height": canvas_height}

    for kind in ("texts", "stickers"):
        job[kind] = [
            prepare_layer(item) for item in job[kind]
            if item["start"] <= time_at <= item["end"]
            and (item.get("kind") != "subtitle" or time_at < item["end"])
        ]
    snapshot_images = []
    for item in job["images"]:
        owner = item.get("ownerClipId") if multitrack else None
        visible = item["start"] <= time_at <= item["end"]
        start_us = round(item["start"] * MICROSECONDS_PER_SECOND)
        end_us = round(item["end"] * MICROSECONDS_PER_SECOND)
        frame_visible = start_us <= frame_us <= end_us
        active = owner in selected_clip_frames if owner else visible or frame_visible
        if not active:
            continue
        elapsed_us = (output_frame_time_us(selected_clip_frames[owner], fps)
                      if owner else frame_us - start_us)
        snapshot_images.append({
            **prepare_layer(item), "_snapshot_visible": bool(owner) or visible,
            "_snapshot_frame_visible": bool(owner) or frame_visible,
            "_snapshot_frame_elapsed_us": elapsed_us,
        })
    job["images"] = snapshot_images
    job.update({"type": "snapshot", "format": "png", "segments": snapshot_segments,
                "video_inputs": snapshot_sources, "audio_layers": [], "transitions": [],
                "snapshot": {"timeline_time": time_at, "transition": transition_at,
                             "transition_elapsed": transition_elapsed, "tracks": snapshot_tracks}})
    width = job["width"] or job["source_width"] or 1920
    height = job["height"] or job["source_height"] or 1080
    ratio = min(1.0, 3840 / max(width, height))
    job["width"] = max(2, int(width * ratio) // 2 * 2)
    job["height"] = max(2, int(height * ratio) // 2 * 2)
