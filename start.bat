@echo off
setlocal
title Depth Wizard
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Run setup.bat first.
    goto fail
)
echo Starting Depth Wizard at http://localhost:8000
echo Keep this window open. Press Ctrl+C to stop the server.
".venv\Scripts\python.exe" run_single_server.py --host 127.0.0.1 --port 8000 --open-browser
if errorlevel 1 goto fail
exit /b 0

:fail
pause
exit /b 1
