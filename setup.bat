@echo off
setlocal
title Depth Wizard - Setup
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto install
py -3.12 --version >nul 2>&1
if not errorlevel 1 (
    py -3.12 -m venv .venv
    goto checkenv
)
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Install Python 3.12 and Node.js 22 LTS, then run setup.bat again.
    goto fail
)
python -m venv .venv
:checkenv
if not exist ".venv\Scripts\python.exe" goto fail

:install
".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)"
if errorlevel 1 (
    echo [ERROR] This dependency set needs Python 3.12. Recreate .venv with Python 3.12.
    goto fail
)
echo [1/3] Installing pinned Python dependencies into .venv...
".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
if errorlevel 1 goto fail
".venv\Scripts\python.exe" -m pip install --no-deps timm==0.6.12
if errorlevel 1 goto fail
echo [2/3] Installing locked frontend dependencies...
cd frontend
call npm ci
if errorlevel 1 goto fail
echo [3/3] Building the frontend...
call npm run build
if errorlevel 1 goto fail
cd ..
if not exist ".env" copy /y .env.example .env >nul
echo Setup complete. Run start.bat, then create your first account in the browser.
if /i not "%~1"=="--no-pause" pause
exit /b 0

:fail
echo [ERROR] Setup failed. Review the error above before starting the app.
if /i not "%~1"=="--no-pause" pause
exit /b 1
