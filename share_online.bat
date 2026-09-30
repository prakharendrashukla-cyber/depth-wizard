@echo off
setlocal
title Depth Wizard - Share Online
cd /d "%~dp0"
if exist "tools\cloudflared.exe" goto share
if not exist tools mkdir tools
echo Downloading cloudflared from the official release...
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'tools\cloudflared.exe.download'; Move-Item -LiteralPath 'tools\cloudflared.exe.download' -Destination 'tools\cloudflared.exe' -Force"
if errorlevel 1 (
    echo [ERROR] Download failed. Check your connection and try again.
    pause
    exit /b 1
)
:share
echo Run start.bat first. Sharing http://localhost:8000 over HTTPS.
echo Use the generated HTTPS address; each visitor must register or log in.
"tools\cloudflared.exe" tunnel --url http://localhost:8000
pause
