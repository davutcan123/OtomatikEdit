@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Otomatik Edit - Windows Kurulum

echo.
echo Otomatik Edit Windows icin hazirlaniyor...
echo.

set "PYTHON_CMD="
where py >nul 2>nul
if errorlevel 1 goto try_python

py -3.11 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=py -3.11"
if defined PYTHON_CMD goto python_ready

py -3.12 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=py -3.12"
if defined PYTHON_CMD goto python_ready

py -3.10 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=py -3.10"
if defined PYTHON_CMD goto python_ready

:try_python
where python >nul 2>nul
if errorlevel 1 goto python_missing
python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 goto python_missing
set "PYTHON_CMD=python"

:python_ready
echo [1/3] Windows sanal ortami hazirlaniyor...
if not exist ".venv-windows\Scripts\python.exe" (
  %PYTHON_CMD% -m venv ".venv-windows"
  if errorlevel 1 goto failed
)

echo [2/3] Gerekli kutuphaneler kuruluyor...
".venv-windows\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 goto failed
".venv-windows\Scripts\python.exe" -m pip install --prefer-binary -r requirements.txt
if errorlevel 1 goto failed

echo [3/3] Video motoru kontrol ediliyor...
".venv-windows\Scripts\python.exe" windows_setup.py
if errorlevel 1 goto failed

echo.
echo [TAMAM] Kurulum basariyla tamamlandi.
echo Bundan sonra WINDOWS_BASLAT.bat dosyasina cift tiklaman yeterli.
echo.
pause
exit /b 0

:python_missing
echo.
echo [HATA] Uyumlu Python bulunamadi.
echo Python 3.11 64-bit surumunu https://www.python.org/downloads/windows/ adresinden kur.
echo Kurulumda "Add python.exe to PATH" secenegini isaretle ve bu dosyayi yeniden ac.
echo.
pause
exit /b 1

:failed
echo.
echo [HATA] Kurulum tamamlanamadi. Yukaridaki hata mesajini kontrol et.
echo.
pause
exit /b 1
