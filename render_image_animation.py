"""Image-local animation expressions, matching the editor's clip animation cards.

All expressions use seconds relative to the image's timeline start.  Unlike the
video zoompan path, these describe an RGBA object, never a cropped video frame.
"""
import math


def image_animation_expressions(name, total, duration):
    total = max(.05, float(total))
    duration = max(.05, float(duration))
    enter = f"min(1,max(0,t/{duration:.8f}))"
    leave = f"min(1,max(0,({total:.8f}-t)/{duration:.8f}))"
    progress = f"min(1,max(0,t/{total:.8f}))"
    wave = f"sin(({progress})*2*PI)"
    quick = f"sin(({enter})*4*PI)"
    result = dict(scale_x="1", scale_y="1", angle="0", x="0", y="0",
                  opacity="1", brightness="1", contrast="1", blur="0")

    def scale(value):
        result["scale_x"] = result["scale_y"] = value

    if name in {"fade", "cinematic"}:
        result["opacity"] = f"min({enter},{leave})"
    elif name in {"fadein", "slideleft", "slideright", "slideup", "slidedown",
                  "pop", "bounce", "rotatein", "flipx", "flipy", "blurin",
                  "zoominfast", "focusin", "spin", "rise", "drop", "elastic"}:
        result["opacity"] = enter
    elif name in {"fadeout", "rotateout", "blurout", "zoomoutfast", "focusout",
                  "slideleftout", "sliderightout", "slideupout", "slidedownout",
                  "revealleft", "revealright", "revealup", "revealdown", "spinout"}:
        result["opacity"] = leave
    if name == "zoom":
        scale(f"1+({progress})*.1")
    elif name == "zoomout":
        scale(f"1.12-({progress})*.12")
    elif name in {"slideleft", "slideright", "slideup", "slidedown"}:
        axis = "x" if name in {"slideleft", "slideright"} else "y"
        sign = -1 if name in {"slideleft", "slidedown"} else 1
        result[axis] = f"(1-({enter}))*{sign * 1.1}"
    elif name == "pop":
        scale(f".55+.45*min(1,({enter})*1.35)")
    elif name == "pulse":
        scale(f"1+({wave})*.035")
    elif name == "bounce":
        result["y"] = f"-abs({quick})*(1-({enter}))*.35"
    elif name in {"rotatein", "rotateout", "spin", "spinout"}:
        edge = enter if name in {"rotatein", "spin"} else leave
        sign = -1 if name in {"rotatein", "spin"} else 1
        full = name in {"spin", "spinout"}
        result["angle"] = f"(1-({edge}))*{sign * (2 * math.pi if full else math.pi * 24 / 180):.8f}"
        scale(f"{'.7' if full else '.82'}+({edge})*{'.3' if full else '.18'}")
    elif name == "swing":
        result["angle"] = f"({wave})*{math.pi * 4 / 180:.8f}"
    elif name == "shake":
        result["x"] = f"({quick})*(1-({enter}))*.04"
    elif name.startswith("drift"):
        axis = "x" if name in {"driftleft", "driftright"} else "y"
        sign = -1 if name in {"driftleft", "driftup"} else 1
        result[axis] = f"({progress})*{sign * (.08 if axis == 'x' else .07)}"
        scale("1.06")
    elif name.startswith("kenburns"):
        axis = "x" if name in {"kenburnsleft", "kenburnsright"} else "y"
        sign = -1 if name in {"kenburnsleft", "kenburnsup"} else 1
        result[axis] = f"({progress})*{sign * .06}"
        scale(f"1.04+({progress})*.08")
    elif name in {"flipx", "flipy"}:
        result["scale_x" if name == "flipx" else "scale_y"] = f"cos((1-({enter}))*PI)"
    elif name in {"blurin", "blurout"}:
        edge = enter if name == "blurin" else leave
        result["blur"] = f"(1-({edge}))*10"
        scale(f"1.08-({edge})*.08")
    elif name == "flash":
        result["brightness"] = f"1+(1-({enter}))*2.2"
        result["opacity"] = f"max(.25,{enter})"
    elif name == "heartbeat":
        scale(f"1+max(0,sin(({progress})*8*PI))*.055")
    elif name == "cinematic":
        scale(f"1.08-({progress})*.04")
        result["contrast"] = f"1.18-({enter})*.08"
    elif name in {"zoominfast", "focusin", "zoomoutfast", "focusout"}:
        entering = name in {"zoominfast", "focusin"}
        edge = enter if entering else leave
        scale(f".78+({edge})*.22" if entering else f"1+({edge})*.22")
        if name.startswith("focus"):
            result["blur"] = f"(1-({edge}))*8"
    elif name in {"slideleftout", "sliderightout", "slideupout", "slidedownout",
                  "revealleft", "revealright", "revealup", "revealdown"}:
        axis = "x" if name.endswith(("left", "right", "leftout", "rightout")) else "y"
        sign = -1 if name in {"slideleftout", "slideupout", "revealleft", "revealup"} else 1
        result[axis] = f"(1-({leave}))*{sign * 1.1}"
    elif name in {"whipleft", "whipright", "cinematicleft", "cinematicright"}:
        sign = -1 if name.endswith("left") else 1
        result["x"] = f"({progress})*{sign * (.22 if name.startswith('whip') else .06)}"
        scale("1.08")
        if name.startswith("whip"):
            result["blur"] = f"abs({wave})*2"
        else:
            result["contrast"] = "1.08"
    elif name in {"rise", "drop"}:
        result["y"] = f"(1-({enter}))*{.28 if name == 'rise' else -.28}"
    elif name == "elastic":
        scale(f"1+sin(({enter})*4*PI)*(1-({enter}))*.18")
    elif name == "rubber":
        result["scale_x"] = f"1+sin(({progress})*8*PI)*.06"
        result["scale_y"] = f"1-sin(({progress})*8*PI)*.04"
    elif name == "wobble":
        result["x"] = f"sin(({progress})*10*PI)*.018"
        result["angle"] = f"sin(({progress})*10*PI)*{math.pi * 5 / 180:.8f}"
    elif name in {"flicker", "strobe"}:
        result["brightness"] = f"1+max(0,sin(({progress})*{18 if name == 'flicker' else 24}*PI))*{.2 if name == 'flicker' else .45}"
    elif name == "breathe":
        scale(f"1+sin(({progress})*6*PI)*.025")
    elif name == "float":
        result["y"] = f"sin(({progress})*5*PI)*.018"
    elif name == "sway":
        result["angle"] = f"sin(({progress})*4*PI)*{math.pi * 3.2 / 180:.8f}"
    return result
