@echo off
rem Starts a local web server for the Schmidt hammer data sheet app and opens the browser.
rem (OCR engine files cannot be loaded when index.html is opened directly with file://)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org
  pause
  exit /b 1
)
node server.mjs
pause
