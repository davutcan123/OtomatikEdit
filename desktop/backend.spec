# -*- mode: python ; coding: utf-8 -*-
"""Build on the target OS/architecture; model weights are downloaded on first use."""
import os
from pathlib import Path
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

root = Path(SPECPATH).parent
datas = [(str(root / name), name) for name in ("templates", "static")]
datas += [(str(root / "version.json"), ".")]
datas += [(str(root / "build" / "backend-notices"), "licenses")]
binaries = [
    (os.environ[f"SMART_EDITOR_{name.upper()}"], "tools/ffmpeg/bin")
    for name in ("ffmpeg", "ffprobe")
]
hiddenimports = [
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
]
# Package-specific source/data needed by lazy loaders. Standard contributed
# hooks handle native stacks such as torch, numpy, Pillow, PyAV and tokenizers.
# Whisper's VAD ONNX data must ship even though larger speech weights do not.
for package in ("faster_whisper", "argostranslate", "stanza"):
    datas += collect_data_files(package)
    hiddenimports += collect_submodules(package, filter=lambda name: ".tests" not in name)
for package in ("ctranslate2", "onnxruntime", "sentencepiece"):
    binaries += collect_dynamic_libs(package)
    datas += collect_data_files(package)
    hiddenimports += collect_submodules(package, filter=lambda name: not any(
        name == prefix or name.startswith(prefix + ".") for prefix in (
            "onnxruntime.quantization", "onnxruntime.transformers", "onnxruntime.tools",
            "onnxruntime.datasets", "onnxruntime.backend",
        )
    ) and ".tests" not in name)
for distribution in ("faster-whisper", "argostranslate", "ctranslate2", "uvicorn"):
    datas += copy_metadata(distribution, recursive=True)

analysis = Analysis(
    [str(root / "desktop" / "backend_entry.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Training/conversion stacks are not part of local CPU inference.
    excludes=["tensorflow", "tensorboard", "jax", "IPython", "notebook", "pytest"],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz, analysis.scripts, [], exclude_binaries=True,
    name="OtomatikEditBackend", debug=False, bootloader_ignore_signals=False,
    strip=False, upx=False, console=True,
)
bundle = COLLECT(
    executable, analysis.binaries, analysis.datas,
    strip=False, upx=False, name="OtomatikEditBackend",
)
