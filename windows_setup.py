"""Windows setup helper for Smart Video Editor.

Downloads a private FFmpeg/FFprobe copy when neither a local nor a system
installation is available. Desktop packaging uses --bundled to install the
pinned copy even when a system installation is present.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parent
LOCAL_BIN = ROOT / "tools" / "ffmpeg" / "bin"
FFMPEG_URL = "https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip"
FFMPEG_SHA256 = "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673"


def local_executable(name: str) -> Path:
    return LOCAL_BIN / f"{name}.exe"


def resolve_executable(name: str) -> str | None:
    local = local_executable(name)
    if local.is_file():
        return str(local)
    return shutil.which(name)


def executable_works(path: str | None) -> bool:
    if not path:
        return False
    try:
        result = subprocess.run(
            [path, "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def check_tools(verbose: bool = True) -> bool:
    ffmpeg = resolve_executable("ffmpeg")
    ffprobe = resolve_executable("ffprobe")
    ok = executable_works(ffmpeg) and executable_works(ffprobe)
    if verbose:
        if ok:
            print(f"[OK] FFmpeg: {ffmpeg}")
            print(f"[OK] FFprobe: {ffprobe}")
        else:
            print("[HATA] FFmpeg veya FFprobe bulunamadı.")
    return ok


def download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "SmartVideoEditor-Windows-Setup/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as output:
        total = int(response.headers.get("Content-Length", "0") or 0)
        downloaded = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            downloaded += len(chunk)
            if total:
                percent = min(100, round(downloaded / total * 100))
                print(f"\rFFmpeg indiriliyor: %{percent}", end="", flush=True)
    print()


def install_ffmpeg(*, bundled: bool = False) -> None:
    if not bundled and check_tools(verbose=False):
        print("[OK] FFmpeg ve FFprobe zaten hazır.")
        return

    print("Projeye özel Windows FFmpeg sürümü indiriliyor...")
    LOCAL_BIN.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="install-", dir=LOCAL_BIN.parent) as temp_dir:
        staging = Path(temp_dir)
        archive = staging / "ffmpeg.zip"
        download(FFMPEG_URL, archive)
        checksum = hashlib.sha256()
        with archive.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                checksum.update(chunk)
        if checksum.hexdigest() != FFMPEG_SHA256:
            raise RuntimeError("FFmpeg arşivinin SHA-256 doğrulaması başarısız oldu.")

        names = ("ffmpeg", "ffprobe")
        with zipfile.ZipFile(archive) as package:
            for name in names:
                executable = local_executable(name).name
                suffix = f"/bin/{executable}"
                member = next((entry for entry in package.namelist() if entry.lower().endswith(suffix)), None)
                if not member:
                    raise RuntimeError(f"İndirilen pakette {executable} bulunamadı.")
                with package.open(member) as source, (staging / executable).open("wb") as output:
                    shutil.copyfileobj(source, output)

        if not all(executable_works(str(staging / local_executable(name).name)) for name in names):
            raise RuntimeError("İndirilen FFmpeg veya FFprobe çalıştırılamadı.")
        for name in names:
            target = local_executable(name)
            (staging / target.name).replace(target)
    print("[OK] FFmpeg ve FFprobe projeye kuruldu.")


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Yalnızca gerekli araçları kontrol et")
    mode.add_argument("--bundled", action="store_true", help="Paketleme için sabit FFmpeg sürümünü kur")
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        print("[HATA] Python 3.10 veya daha yeni bir sürüm gereklidir.")
        return 1
    try:
        if args.check:
            return 0 if check_tools() else 1
        install_ffmpeg(bundled=args.bundled)
        return 0
    except Exception as error:
        print(f"[HATA] Windows hazırlığı tamamlanamadı: {error}")
        print("İnternet bağlantısını kontrol edip WINDOWS_KUR.bat dosyasını yeniden çalıştırın.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
