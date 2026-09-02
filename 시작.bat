@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
REM Start Codex in this project folder. Double-click this file.
cd /d "%~dp0"
if not exist "web\node_modules" (
  echo 첫 실행 세팅이 필요합니다. 설치를 자동으로 시작합니다.
  call "%~dp0설치.bat"
)
where codex >nul 2>nul
if errorlevel 1 (
  echo Codex not found. Please run the setup file first.
  pause
  exit /b 1
)
codex
