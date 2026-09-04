"""Windows setup helper for Smart Video Editor.

Downloads a private FFmpeg/FFprobe copy when neither a bundled nor a system
installation is available. No administrator permission or PATH change is
required.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parent
LOCAL_BIN = ROOT / "tools" / "ffmpeg" / "bin"
FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"


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


def install_ffmpeg() -> None:
    if check_tools(verbose=False):
        print("[OK] FFmpeg ve FFprobe zaten hazır.")
        return

    print("FFmpeg bulunamadı. Projeye özel Windows sürümü indiriliyor...")
    LOCAL_BIN.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="smart-editor-ffmpeg-") as temp_dir:
        archive = Path(temp_dir) / "ffmpeg.zip"
        download(FFMPEG_URL, archive)
        with zipfile.ZipFile(archive) as package:
            members = package.namelist()
            for executable in ("ffmpeg.exe", "ffprobe.exe"):
                suffix = f"/bin/{executable}".lower()
                member = next((name for name in members if name.lower().endswith(suffix)), None)
                if not member:
                    raise RuntimeError(f"İndirilen pakette {executable} bulunamadı.")
                target = LOCAL_BIN / executable
                with package.open(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)

    if not check_tools(verbose=False):
        raise RuntimeError("FFmpeg indirildi ancak çalıştırılamadı.")
    print("[OK] FFmpeg ve FFprobe projeye kuruldu.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Yalnızca gerekli araçları kontrol et")
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        print("[HATA] Python 3.10 veya daha yeni bir sürüm gereklidir.")
        return 1
    try:
        if args.check:
            return 0 if check_tools() else 1
        install_ffmpeg()
        return 0
    except Exception as error:
        print(f"[HATA] Windows hazırlığı tamamlanamadı: {error}")
        print("İnternet bağlantısını kontrol edip WINDOWS_KUR.bat dosyasını yeniden çalıştırın.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
