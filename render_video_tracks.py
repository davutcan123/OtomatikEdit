"""Track layout and source-space crop helpers shared by render and snapshots."""
import math


def normalize_video_track(value=1):
    if isinstance(value, bool):
        raise ValueError("Video kanalı pozitif bir tam sayı olmalı")
    try:
        track = int(value)
        if track < 1 or float(value) != track:
            raise ValueError
    except (TypeError, ValueError, OverflowError):
        raise ValueError("Video kanalı pozitif bir tam sayı olmalı") from None
    return track


def normalize_source_crop(value=None):
    if value is None:
        return {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
    if not isinstance(value, dict):
        raise ValueError("Geçersiz video kırpma alanı")
    try:
        crop = {key: float(value.get(key, default)) for key, default in
                (("x", 0), ("y", 0), ("width", 1), ("height", 1))}
    except (TypeError, ValueError):
        raise ValueError("Geçersiz video kırpma alanı") from None
    if (not all(math.isfinite(number) for number in crop.values())
            or not 0 <= crop["x"] < 1 or not 0 <= crop["y"] < 1
            or crop["width"] <= 0 or crop["height"] <= 0):
        raise ValueError("Kırpma alanı kaynak görüntünün içinde olmalı")
    crop["width"] = min(crop["width"], 1 - crop["x"])
    crop["height"] = min(crop["height"], 1 - crop["y"])
    return crop


def source_crop_filter(crop):
    crop = normalize_source_crop(crop)
    if crop == {"x": 0, "y": 0, "width": 1, "height": 1}:
        return ""
    # Respect chroma-grid alignment and clamp the final two-pixel minimum at
    # source edges. The original upload is never rewritten.
    return (f"crop=w='max(2,trunc(iw*{crop['width']:.10f}/2)*2)':"
            f"h='max(2,trunc(ih*{crop['height']:.10f}/2)*2)':"
            f"x='min(iw-ow,trunc(iw*{crop['x']:.10f}/2)*2)':"
            f"y='min(ih-oh,trunc(ih*{crop['y']:.10f}/2)*2)'")


def video_track_groups(segments):
    groups = {}
    for index, segment in enumerate(segments):
        groups.setdefault(segment.get("videoTrack", 1), []).append(index)
    return {track: indices for track, indices in sorted(groups.items())}


def next_track_clip(segments, boundary):
    if not 0 <= boundary < len(segments):
        return None
    track = segments[boundary].get("videoTrack", 1)
    return next((index for index in range(boundary + 1, len(segments))
                 if segments[index].get("videoTrack", 1) == track), None)


def shift_clip_filter_time(filters, offset, fps=30):
    """Keep keyframes/animations at clip time zero during incoming pre-roll."""
    import re
    if offset <= 0:
        return filters
    def quoted(match):
        expression = re.sub(r"\b(t|T|it)\b", lambda variable: f"max(0,{variable.group(0)}-{offset:.8f})", match.group(1))
        expression = re.sub(r"\bon\b", f"max(0,on-{offset * fps:.8f})", expression)
        return "'" + expression + "'"
    filters = re.sub(r"'([^']*)'", quoted, filters)
    # FFmpeg fade's start is a literal option, not a quoted time expression.
    return re.sub(r"(fade=t=(?:in|out):st=)([0-9.]+)",
                  lambda match: match.group(1) + f"{float(match.group(2)) + offset:.8f}", filters)


def compose_video_tracks(lines, segments, segment_durations, transitions, total_duration,
                         width, height, fps, snapshot=None):
    """Join each track, then composite alpha video and mix audio in wall time."""
    def crossfade(left, right, transition, offset, target):
        # xfade interpolates each channel independently. Interpolate premultiplied
        # RGB so a partially transparent fade cannot darken the lower track twice.
        stem = target.strip("[]")
        lines.append(f"{left}format=gbrap,premultiply=inplace=1[{stem}left]")
        lines.append(f"{right}format=gbrap,premultiply=inplace=1[{stem}right]")
        lines.append(f"[{stem}left][{stem}right]xfade=transition={transition['type']}:"
                     f"duration={transition['duration']:.8f}:offset={offset:.8f},"
                     f"unpremultiply=inplace=1,format=yuva444p{target}")

    groups = video_track_groups(segments)
    tracks = []
    if snapshot:
        for number, track in enumerate(snapshot["tracks"]):
            indices = track["indices"]
            video = f"[v{indices[0]}]"
            if track["transition"]:
                transition = track["transition"]
                label = f"[snaptrack{number}]"
                crossfade(video, f"[v{indices[1]}]", transition, -track["transition_elapsed"], label)
                video = label
            tracks.append((video, None))
    else:
        for number, indices in enumerate(groups.values()):
            video, audio = f"[v{indices[0]}]", f"[a{indices[0]}]"
            duration = segment_durations[indices[0]]
            for left, right in zip(indices, indices[1:]):
                next_video, next_audio = f"[track{number}v{right}]", f"[track{number}a{right}]"
                transition = transitions.get(left)
                if transition:
                    overlap = transition["duration"]
                    crossfade(video, f"[v{right}]", transition, max(0, duration - overlap), next_video)
                    lines.append(f"{audio}[a{right}]acrossfade=d={overlap:.8f}:c1=tri:c2=tri{next_audio}")
                    duration += segment_durations[right] - overlap
                else:
                    lines.append(f"{video}[v{right}]concat=n=2:v=1:a=0{next_video}")
                    lines.append(f"{audio}[a{right}]concat=n=2:v=0:a=1{next_audio}")
                    duration += segment_durations[right]
                video, audio = next_video, next_audio
            tracks.append((video, audio))
    lines.append(f"color=c=black:s={width}x{height}:r={fps}:d={max(1 / fps, total_duration):.8f},"
                 f"settb=AVTB,setpts=N/({fps}*TB)[trackbackground]")
    current = "[trackbackground]"
    for number, (video, _) in enumerate(tracks):
        target = f"[trackcomposite{number}]"
        lines.append(f"{current}{video}overlay=0:0:eof_action=pass:repeatlast=0:shortest=0{target}")
        current = target
    audio = None
    if not snapshot:
        audio = "[trackmix]"
        if tracks:
            labels = "".join(label for _, label in tracks)
            lines.append(f"{labels}amix=inputs={len(tracks)}:duration=longest:dropout_transition=0:normalize=0,"
                         f"alimiter=limit=.95:latency=1,apad=whole_dur={total_duration:.8f},atrim=duration={total_duration:.8f}{audio}")
        else:
            lines.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={total_duration:.8f}{audio}")
    return current, audio
