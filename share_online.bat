@echo off
title Depth Wizard - Share Online Link
echo ====================================================
echo        Generating Free Cloudflare Public Link
echo ====================================================
echo.
echo Connecting tunnel to http://localhost:5173 ...
echo.
echo Look for your public link below (e.g. https://...trycloudflare.com)
echo.
"%~dp0cloudflared.exe" tunnel --url http://localhost:5173
pause
