@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
REM Initial setup. Double-click this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup-windows.ps1"
pause
