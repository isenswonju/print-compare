@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
echo 인수인계용 압축 파일을 바탕화면에 만듭니다.
echo.
where py >nul 2>nul
if not errorlevel 1 (
  py -3 tools\package_handover.py
) else (
  python tools\package_handover.py
)
echo.
pause
