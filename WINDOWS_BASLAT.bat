@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Otomatik Edit

if not exist ".venv-windows\Scripts\python.exe" (
  echo Ilk kurulum baslatiliyor...
  call WINDOWS_KUR.bat
  if errorlevel 1 exit /b 1
)

if exist "tools\ffmpeg\bin\ffmpeg.exe" set "SMART_EDITOR_FFMPEG=%CD%\tools\ffmpeg\bin\ffmpeg.exe"
if exist "tools\ffmpeg\bin\ffprobe.exe" set "SMART_EDITOR_FFPROBE=%CD%\tools\ffmpeg\bin\ffprobe.exe"
set "SMART_EDITOR_HOST=127.0.0.1"
set "SMART_EDITOR_PORT=4242"
set "SMART_EDITOR_OPEN_BROWSER=1"
set "SMART_EDITOR_GITHUB_REPO=davutcan123/OtomatikEdit"
set "PYTHONUTF8=1"

".venv-windows\Scripts\python.exe" windows_setup.py --check
if errorlevel 1 (
  echo FFmpeg eksik. Kurulum yeniden calistiriliyor...
  ".venv-windows\Scripts\python.exe" windows_setup.py
  if errorlevel 1 goto failed
)

rem ── Bagimliliklari kontrol et (guncelleme sonrasi yeni paket varsa yukle) ──
set "HASH_FILE=.req-hash"
set "NEW_HASH="
for /f %%h in ('certutil -hashfile requirements.txt MD5 2^>nul ^| findstr /v "hash certutil"') do (
  if not defined NEW_HASH set "NEW_HASH=%%h"
)
set "OLD_HASH="
if exist "%HASH_FILE%" set /p OLD_HASH=<"%HASH_FILE%"
if not "%NEW_HASH%"=="%OLD_HASH%" (
  echo Bagimliliklarda degisiklik algilandi, guncelleniyor...
  ".venv-windows\Scripts\python.exe" -m pip install --prefer-binary -r requirements.txt
  echo %NEW_HASH%>"%HASH_FILE%"
)

echo.
echo Otomatik Edit baslatiliyor: http://127.0.0.1:4242
echo Bu pencereyi programi kullanirken kapatma.
echo Programi durdurmak icin bu pencerede Ctrl+C tuslarina bas.
echo.
".venv-windows\Scripts\python.exe" app.py
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo [HATA] Program baslatilamadi. Yukaridaki mesaji kontrol et.
echo.
pause
exit /b 1
