@echo off
REM Start Codex in this project folder. Double-click this file.
cd /d "%~dp0"
where codex >nul 2>nul
if errorlevel 1 (
  echo Codex not found. Please run the setup file first.
  pause
  exit /b 1
)
codex
