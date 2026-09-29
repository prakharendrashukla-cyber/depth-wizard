@echo off
title Depth Wizard - One-Time Setup
echo ====================================================
echo             Depth Wizard Setup
echo ====================================================
echo.

echo [1/2] Installing Backend Python packages (PyTorch, FastAPI, Transformers)...
cd /d "%~dp0backend"
py -m pip install -r requirements.txt || python -m pip install -r requirements.txt

echo.
echo [2/2] Installing Frontend React / Three.js packages...
cd /d "%~dp0frontend"
call npm install

echo.
echo ====================================================
echo Setup complete! Now you can double-click start.bat
echo ====================================================
pause
