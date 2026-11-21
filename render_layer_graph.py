"""FFmpeg expressions and graph stages for timed visual overlays."""

import math
import re

from render_image_animation import image_animation_expressions
from render_timing import MICROSECONDS_PER_SECOND


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


def _keyframe_expression(base_value, keyframes, read_value):
    anchors = [(0.0, base_value / 100, "smoother")]
    for frame in keyframes:
        anchor = (frame["time"], read_value(frame) / 100, frame.get("easing", "smoother"))
        if frame["time"] <= .0001:
            anchors[0] = anchor
        else:
            anchors.append(anchor)
    expression = f"{anchors[-1][1]:.8f}"
    for (left_time, left_value, _), (right_time, right_value, easing) in reversed(list(zip(anchors, anchors[1:]))):
        span = max(.0001, right_time - left_time)
        progress = f"((t-{left_time:.8f})/{span:.8f})"
        eased = zoom_keyframe_easing_expression(progress, easing)
        value = f"({left_value:.8f}+({right_value-left_value:.8f})*({eased}))"
        expression = f"if(lt(t,{right_time:.8f}),{value},{expression})"
    return expression


def zoom_keyframe_scale_expression(base_scale: float, keyframes: list[dict]) -> str:
    return _keyframe_expression(max(25.0, min(300.0, base_scale)), keyframes, lambda frame: frame["scale"])


def zoom_keyframe_focus_expression(keyframes: list[dict], axis: str, base_value: float = 50) -> str:
    return _keyframe_expression(max(0.0, min(100.0, base_value)), keyframes, lambda frame: frame.get(axis, 50))


def zoom_keyframe_opacity_expression(base_opacity: float, keyframes: list[dict]) -> str:
    return _keyframe_expression(max(0.0, min(100.0, base_opacity)), keyframes, lambda frame: frame.get("opacity", 100))


def snapshot_time_expression(expression, elapsed, fps):
    return re.sub(
        r"\b(t|it|T|on)\b",
        lambda match: f"{elapsed * fps if match.group(0) == 'on' else elapsed:.8f}",
        expression,
    )


def freeze_snapshot_expressions(filters, elapsed, fps):
    # Only quoted FFmpeg expressions contain time variables. Bare t=in (fade)
    # and format/option names must remain untouched.
    return re.sub(r"'([^']*)'", lambda match: "'" + snapshot_time_expression(match.group(1), elapsed, fps) + "'", filters)


def layer_time_expression(expression, item, fps, snapshot, variable="t"):
    if snapshot:
        return snapshot_time_expression(expression, item["snapshot_elapsed"], fps)
    return re.sub(r"\bt\b", f"max(0,{variable}-{item['start']:.8f})", expression)


def image_effect_chain(lines, source, label, effect, intensity):
    """Apply existing color presets without discarding an imported PNG's alpha.

    eq/hue and several other FFmpeg filters negotiate formats without alpha.
    Keep the original channel separate and reattach it after RGB processing.
    Intensity blends color only; transparent pixels cannot turn into a box.
    """
    if not effect or intensity <= 0:
        return source
    amount = max(0.0, min(1.0, intensity / 100))
    lines.append(f"{source}format=rgba,split=2[{label}color][{label}alpha0]")
    lines.append(f"[{label}alpha0]alphaextract[{label}alpha]")
    if amount < .99999:
        lines.append(f"[{label}color]format=gbrp,split=2[{label}original][{label}process]")
        lines.append(f"[{label}process]{effect},format=gbrp[{label}effect]")
        lines.append(f"[{label}original][{label}effect]blend=all_expr='A*(1-{amount:.8f})+B*{amount:.8f}'[{label}rgb]")
    else:
        lines.append(f"[{label}color]{effect},format=gbrp[{label}rgb]")
    lines.append(f"[{label}rgb][{label}alpha]alphamerge,format=rgba[{label}]")
    return f"[{label}]"


def image_visibility_expression(item):
    start, end = item["start"], item["end"]
    if item.get("_gif"):
        start_us = round(start * MICROSECONDS_PER_SECOND)
        end_us = round(end * MICROSECONDS_PER_SECOND)
        return f"between(round(t*{MICROSECONDS_PER_SECOND}),{start_us},{end_us})"
    return f"between(t,{start},{end})"


def append_animated_image(lines, source, destination, item, index, width, height,
                          base_width, base_height, fps, snapshot):
    """Compose an image object on a fixed RGBA surface at its own local time.

    Variable-size scale outputs must not reach overlay framesync: that can reset
    its frame queue and cause stutter. rotate centers into a fixed transparent
    surface, bounded by the largest visible portion of this image object.
    """
    frames = item.get("transformKeyframes", [])
    animation = image_animation_expressions(
        item.get("animation", "none"),
        item.get("snapshot_layer_duration", item["end"] - item["start"]),
        item.get("animationDuration", 1),
    )

    def local(expression, variable="t"):
        return layer_time_expression(expression, item, fps, snapshot, variable)

    scale = zoom_keyframe_scale_expression(100, frames)
    opacity = zoom_keyframe_opacity_expression(item.get("opacity", 100), frames)
    focus_x = zoom_keyframe_focus_expression(frames, "x", item.get("x", 50))
    focus_y = zoom_keyframe_focus_expression(frames, "y", item.get("y", 50))
    sx = f"({scale})*({animation['scale_x']})"
    sy = f"({scale})*({animation['scale_y']})"
    if item.get("effect") == "mirror":
        sx += f"*(1-2*{item.get('effectIntensity', 100) / 100:.8f})"
    angle = f"{item.get('rotation', 0) * math.pi / 180:.8f}+({animation['angle']})"
    opacity = f"({opacity})*({animation['opacity']})"
    # Slide percentages are local image-box distances. The keyframe transform
    # scales this inner animation, as in the preview's nested CSS transforms.
    dx = f"({animation['x']})*{base_width}*({scale})"
    dy = f"({animation['y']})*{base_height}*({scale})"
    base_angle = item.get("rotation", 0) * math.pi / 180
    x = f"W*({focus_x})-w/2+({dx})*{math.cos(base_angle):.8f}-({dy})*{math.sin(base_angle):.8f}"
    y = f"H*({focus_y})-h/2+({dx})*{math.sin(base_angle):.8f}+({dy})*{math.cos(base_angle):.8f}"
    # Keep small objects compact. Very large objects need only the portion that
    # can reach the canvas, including the extra off-center travel of slide cards.
    maximum_scale = max([1.0] + [frame["scale"] / 100 for frame in frames])
    maximum_width, maximum_height = base_width * maximum_scale * 1.25, base_height * maximum_scale * 1.25
    rotated = item.get("rotation", 0) != 0 or animation["angle"] != "0"
    bound_width = bound_height = math.hypot(maximum_width, maximum_height)
    if not rotated:
        bound_width, bound_height = maximum_width, maximum_height
    movement = 1.1 if animation["x"] != "0" or animation["y"] != "0" else 0
    extra_travel = movement * maximum_scale * math.hypot(base_width, base_height)
    stage_width = max(4, 2 * math.ceil(min(bound_width, 2 * (width + extra_travel)) / 2) + 4)
    stage_height = max(4, 2 * math.ceil(min(bound_height, 2 * (height + extra_travel)) / 2) + 4)
    filters = ["format=rgba"]
    needs_opacity = (item.get("opacity", 100) != 100 or animation["opacity"] != "1"
                     or any(frame.get("opacity", 100) != 100 for frame in frames))
    if needs_opacity or animation["brightness"] != "1" or animation["contrast"] != "1":
        brightness = local(animation["brightness"], "T")
        contrast = local(animation["contrast"], "T")
        channels = [f"{ch}='clip(clip({ch}(X,Y)*({brightness}),0,255)*({contrast})+127.5*(1-({contrast})),0,255)'"
                    for ch in "rgb"]
        filters.append("geq=" + ":".join(channels) + f":a='alpha(X,Y)*({local(opacity, 'T')})'")
    # Evaluate opacity/color on the compact image before expanding it. A pure
    # position/zoom animation needs no per-pixel geq operation at all.
    filters.extend([
        f"hflip=enable='lt({local(sx)},0)'",
        f"vflip=enable='lt({local(sy)},0)'",
        f"scale=w='max(2,trunc({base_width}*abs({local(sx)})/2)*2)':"
        f"h='max(2,trunc({base_height}*abs({local(sy)})/2)*2)':eval=frame",
        f"rotate='{local(angle)}':ow={stage_width}:oh={stage_height}:c=none",
    ])
    label = f"imageanimated{index}"
    lines.append(f"{source}{','.join(filters)},setsar=1[{label}]")
    if animation["blur"] != "0":
        # A continuous blend avoids stepped radius changes and preserves alpha
        # around the image edge. This approximates CSS's variable Gaussian blur.
        blur_amount = local(f"min(1,({animation['blur']})/10)", "T")
        lines.append(f"[{label}]split=2[{label}sharp][{label}blur0]")
        lines.append(f"[{label}blur0]gblur=sigma=5[{label}blur]")
        lines.append(f"[{label}sharp][{label}blur]blend=all_expr='A*(1-({blur_amount}))+B*({blur_amount})'[{label}soft]")
        label += "soft"
    lines.append(f"{destination}[{label}]overlay=x='{local(x)}':y='{local(y)}':eval=frame:"
                 f"enable='{image_visibility_expression(item)}':eof_action=pass:shortest=1[imagev{index}]")
    return f"[imagev{index}]"


def append_text_overlay(lines, current_video, index, input_index, text_item, position, size, fps, snapshot):
    next_label = f"[textv{index}]"
    overlay_input = f"[textcached{index}]"
    lines.append(f"[{input_index}:v]loop=loop=-1:size=1:start=0,setpts=N/({fps}*TB){overlay_input}")
    frames = text_item.get("transformKeyframes", [])
    x_expr, y_expr = map(str, position)
    if frames:
        text_scale = zoom_keyframe_scale_expression(100, frames)
        text_opacity = zoom_keyframe_opacity_expression(100, frames)
        text_scale = layer_time_expression(text_scale, text_item, fps, snapshot)
        text_opacity = layer_time_expression(text_opacity, text_item, fps, snapshot, "T")
        source_width, source_height = size
        maximum_scale = max(1.0, max(frame.get("scale", 100) for frame in frames) / 100)
        padded_width = max(4, int(math.ceil(source_width * maximum_scale / 2) * 2 + 4))
        padded_height = max(4, int(math.ceil(source_height * maximum_scale / 2) * 2 + 4))
        text_x = zoom_keyframe_focus_expression(frames, "x", text_item.get("x", 50))
        text_y = zoom_keyframe_focus_expression(frames, "y", text_item.get("y", 50))
        text_x = layer_time_expression(text_x, text_item, fps, snapshot)
        text_y = layer_time_expression(text_y, text_item, fps, snapshot)
        animated_label = f"[textasset{index}]"
        # Evaluate opacity on fixed-size input pixels and center the
        # changing scale on a constant canvas for overlay framesync.
        lines.append(
            f"{overlay_input}format=rgba,"
            "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
            f"a='alpha(X,Y)*({text_opacity})',"
            f"scale=w='max(2,trunc(iw*({text_scale})/2)*2)':"
            f"h='max(2,trunc(ih*({text_scale})/2)*2)':eval=frame,"
            f"rotate=0:ow={padded_width}:oh={padded_height}:c=none,setsar=1{animated_label}"
        )
        overlay_input = animated_label
        x_expr = f"W*({text_x})-w/2"
        y_expr = f"H*({text_y})-h/2"
    start, end = text_item["start"], text_item["end"]
    visibility = f"between(t,{start},{end})"
    if not snapshot and text_item["kind"] == "subtitle":
        visibility = f"gte(t,{start})*lt(t,{end})"
    lines.append(
        f"{current_video}{overlay_input}overlay=x='{x_expr}':y='{y_expr}':"
        f"enable='{visibility}':eof_action=pass:shortest=1{next_label}"
    )
    return next_label


def append_sticker_overlay(lines, current_video, index, input_index, sticker_item, position, fps):
    next_label = f"[stickerv{index}]"
    x, y = position
    lines.append(f"[{input_index}:v]loop=loop=-1:size=1:start=0,setpts=N/({fps}*TB)[stickercached{index}]")
    lines.append(
        f"{current_video}[stickercached{index}]overlay={x}:{y}:"
        f"enable='between(t,{sticker_item['start']},{sticker_item['end']})':"
        f"eof_action=pass:shortest=1{next_label}"
    )
    return next_label
