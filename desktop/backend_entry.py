"""Frozen server entry point, including a model-download-free packaging check."""

import multiprocessing


def self_test(backend):
    import importlib
    import json
    from pathlib import Path
    import subprocess
    import sys
    import tempfile

    # These are loaded lazily during transcription/translation. Import them in
    # the frozen binary so a missing hook fails the build, not a user's project.
    for module in (
        "faster_whisper", "faster_whisper.vad", "ctranslate2", "onnxruntime",
        "av", "tokenizers", "huggingface_hub", "argostranslate.package",
        "argostranslate.translate", "sentencepiece", "stanza", "torch",
        "PIL.Image", "certifi",
    ):
        importlib.import_module(module)

    from faster_whisper.vad import get_vad_model
    get_vad_model()  # Bundled speech detection ONNX file; no network request.
    worker = multiprocessing.get_context("spawn").Process(
        target=print, args=("Frozen worker check passed.",),
    )
    worker.start()
    worker.join(timeout=30)
    if worker.is_alive():
        worker.terminate()
        worker.join(timeout=5)
        raise RuntimeError("Frozen multiprocessing worker did not finish")
    if worker.exitcode != 0:
        raise RuntimeError(f"Frozen multiprocessing worker failed: {worker.exitcode}")
    for executable in (backend.FFMPEG_BIN, backend.FFPROBE_BIN):
        if getattr(sys, "frozen", False) and not Path(executable).resolve().is_relative_to(
            Path(sys._MEIPASS).resolve()
        ):
            raise RuntimeError(f"Media tool was not resolved from the package: {executable}")
        subprocess.run([executable, "-version"], check=True, capture_output=True, timeout=30)
    for resource in ("templates/index.html", "static/editor.css", "version.json"):
        if not (Path(backend.RESOURCE_DIR) / resource).is_file():
            raise RuntimeError(f"Missing packaged resource: {resource}")

    # An actual encode/decode checks dependent DLL/dylib discovery and codecs,
    # which running FFmpeg's version command alone cannot establish.
    with tempfile.TemporaryDirectory(prefix="otomatik-edit-package-check-") as temp:
        output = Path(temp) / "smoke.mp4"
        subprocess.run([
            backend.FFMPEG_BIN, "-v", "error", "-y", "-f", "lavfi", "-i",
            "color=c=blue:s=320x180:r=30:d=0.2", "-f", "lavfi", "-i",
            "sine=frequency=440:duration=0.2", "-c:v", "libx264", "-pix_fmt",
            "yuv420p", "-threads", "1", "-c:a", "aac", "-shortest", str(output),
        ], check=True, stdout=subprocess.DEVNULL, timeout=60)
        metadata = json.loads(subprocess.check_output([
            backend.FFPROBE_BIN, "-v", "error", "-show_streams", "-of", "json", str(output),
        ], timeout=30))
        codecs = {stream["codec_name"] for stream in metadata["streams"]}
        if not {"h264", "aac"}.issubset(codecs):
            raise RuntimeError(f"Unexpected packaged render codecs: {codecs}")
    print("Desktop backend self-test passed (AI imports, VAD, worker, assets, H.264/AAC).", flush=True)


if __name__ == "__main__":
    # PyInstaller must divert multiprocessing workers before importing the app.
    # Importing app under its own module name also keeps worker targets picklable.
    multiprocessing.freeze_support()
    import os
    import sys
    import app as backend

    if "--self-test" in sys.argv:
        self_test(backend)
    else:
        import uvicorn
        uvicorn.run(
            backend.app,
            host=os.environ.get("SMART_EDITOR_HOST", "127.0.0.1"),
            port=int(os.environ.get("SMART_EDITOR_PORT", "4242")),
        )
