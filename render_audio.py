"""Pure FFmpeg audio graph builders for clip joins and timeline layers."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from render_timing import SourceTrim, TimelineClip


VOICE_CHANGERS = {
    "deep": "aresample=48000,asetrate=39360,aresample=48000,atempo=1.21951220",
    "chipmunk": "aresample=48000,asetrate=60000,aresample=48000,atempo=.8",
    "robot": "tremolo=f=35:d=.75,aecho=.8:.65:12:.18",
}
CHANNEL_MODES = {
    "left": "pan=stereo|c0=c0|c1=c0",
    "right": "pan=stereo|c0=c1|c1=c1",
    "mono": "pan=stereo|c0=.5*c0+.5*c1|c1=.5*c0+.5*c1",
}
VOICE_ENHANCEMENT = (
    "highpass=f=80,lowpass=f=12000,equalizer=f=3000:t=q:w=1:g=3,"
    "acompressor=threshold=.063:ratio=3:attack=15:release=250:makeup=2"
)


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


def clip_audio_filter(source, destination, segment, timing: TimelineClip, trim: SourceTrim, *, mute):
    duration = timing.duration
    if source is None:
        return f"anullsrc=r=48000:cl=stereo,atrim=duration={duration:.8f}{destination}"

    filters = [f"atrim=start={trim.start}:end={trim.end}"]
    if timing.clock.reverse:
        filters.append("areverse")
    filters.extend(["asetpts=PTS-STARTPTS", atempo_chain(timing.clock.speed)])
    if trim.missing_handle > .00001:
        filters.append(f"adelay={round(trim.missing_handle * 1000)}:all=1")
    if segment.get("noiseReduction", False):
        filters.append("afftdn=nf=-30:tn=1:gs=8")
    if segment.get("enhanceVoice", False):
        filters.append(VOICE_ENHANCEMENT)
    if segment.get("normalizeAudio", False):
        filters.append("loudnorm=I=-16:LRA=7:TP=-1.5")
    voice_changer = VOICE_CHANGERS.get(segment.get("voiceChanger", "none"))
    if voice_changer:
        filters.append(voice_changer)
    channel_mode = CHANNEL_MODES.get(segment.get("channelMode", "stereo"))
    if channel_mode:
        filters.append(channel_mode)
    balance = segment.get("audioBalance", 0) / 100
    if abs(balance) > .001:
        left_gain, right_gain = 1.0 - max(0, balance), 1.0 + min(0, balance)
        filters.append(f"pan=stereo|c0={left_gain:.5f}*c0|c1={right_gain:.5f}*c1")

    fade_in, fade_out = segment.get("audioFadeIn", 0), segment.get("audioFadeOut", 0)
    if fade_in >= .01:
        filters.append(f"afade=t=in:st={timing.preroll:.8f}:d={fade_in:.5f}")
    if fade_out >= .01:
        fade_start = max(0, timing.clock.duration - fade_out) + timing.preroll
        filters.append(f"afade=t=out:st={fade_start:.5f}:d={fade_out:.5f}")
    volume = 0 if mute or segment.get("muted", False) or segment.get("trackMuted", False) else segment.get("volume", 1)
    filters.append(f"volume={volume:.6f}")
    if timing.gap >= .001:
        filters.append(f"adelay={round(timing.gap * 1000)}:all=1")

    # Audio EOF may precede video EOF. Give the join a complete clip span.
    filters.extend(["aresample=48000", f"apad=whole_dur={duration:.8f}", f"atrim=duration={duration:.8f}"])
    return f"{source}{','.join(filters)}{destination}"


def join_audio(left, right, destination, *, overlap=None):
    merge = "concat=n=2:v=0:a=1" if overlap is None else f"acrossfade=d={overlap}:c1=tri:c2=tri"
    return f"{left}{right}{merge}{destination}"


def mix_audio_layers(base, layers, first_input):
    if not layers:
        return [f"{base}anull[outa]"]
    lines, labels = [], []
    for index, layer in enumerate(layers):
        label = f"[mediaa{index}]"
        duration = layer["end"] - layer["start"]
        delay_ms = max(0, round(layer["start"] * 1000))
        lines.append(
            f"[{first_input + index}:a]atrim=start={layer['sourceStart']}:"
            f"duration={duration},asetpts=PTS-STARTPTS,"
            f"volume={layer['volume']},adelay={delay_ms}:all=1{label}"
        )
        labels.append(label)
    lines.append(
        f"{base}{''.join(labels)}amix=inputs={len(labels) + 1}:"
        "duration=first:dropout_transition=0:normalize=0,alimiter=limit=.95:latency=1[outa]"
    )
    return lines
