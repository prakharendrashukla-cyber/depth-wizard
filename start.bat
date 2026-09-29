@echo off
setlocal enabledelayedexpansion
title Depth Wizard - Launcher
color 0B

echo ================================================================
echo                   DEPTH WIZARD - LAUNCHER
echo ================================================================
echo.

:: 1. Detect Python
set PYTHON_CMD=
py --version >nul 2>&1
if %errorlevel% equ 0 (
    set PYTHON_CMD=py
) else (
    python --version >nul 2>&1
    if !errorlevel! equ 0 (
        set PYTHON_CMD=python
    )
)

if "%PYTHON_CMD%"=="" (
    color 0C
    echo [ERROR] Python is not installed or not in your PATH!
    echo Please install Python 3.10+ from https://www.python.org/downloads/
    echo (Make sure to check "Add Python to PATH" during installation)
    echo.
    pause
    exit /b 1
)

echo [OK] Detected Python: %PYTHON_CMD%

:: 2. Detect Node.js
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in your PATH!
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Detected Node.js / NPM

:: 3. Check / Auto-install Frontend Dependencies
cd /d "%~dp0frontend"
if not exist "node_modules\" (
    echo.
    echo [*] First time setup: Installing Frontend packages (Vite, React, Three.js)...
    echo This may take 1-2 minutes on first run. Please wait...
    call npm install
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to install frontend packages. Check your internet connection.
        pause
        exit /b 1
    )
)

:: 4. Check / Auto-install Backend Dependencies
cd /d "%~dp0backend"
%PYTHON_CMD% -c "import fastapi, uvicorn, PIL" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [*] Installing Backend Python packages (FastAPI, Uvicorn, Pillow)...
    echo This may take a minute. Please wait...
    %PYTHON_CMD% -m pip install -r requirements.txt
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to install backend packages.
        pause
        exit /b 1
    )
)

echo.
echo ================================================================
echo [1/2] Starting FastAPI Backend on http://127.0.0.1:8000 ...
cd /d "%~dp0backend"
start "Depth Wizard [Backend]" cmd /k "%PYTHON_CMD% -m uvicorn app.main:app --host 127.0.0.1 --port 8000"

echo [2/2] Starting React + Three.js Frontend on http://localhost:5173 ...
cd /d "%~dp0frontend"
start "Depth Wizard [Frontend]" cmd /k "npm run dev -- --host 0.0.0.0"

echo.
echo Waiting for servers to initialize...
timeout /t 5 /nobreak >nul

echo Opening browser at http://localhost:5173 ...
start http://localhost:5173

echo.
echo ================================================================
echo  Depth Wizard is now RUNNING!
echo  Keep the two server terminal windows OPEN while using the app.
echo ================================================================
echo.
pause
