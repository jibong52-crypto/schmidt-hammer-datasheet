@echo off
rem Starts the server so a phone on the SAME Wi-Fi can open the app, and shows a QR code to scan.
rem (Close this window to stop. Use start.bat for PC-only access.)
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org
  pause
  exit /b 1
)
title Schmidt hammer datasheet - phone access
node server.mjs --lan
pause
