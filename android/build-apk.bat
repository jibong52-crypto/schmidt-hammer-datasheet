@echo off
rem Builds the standalone Android APK (downloads JDK + Android build tools on the first run, ~600 MB).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
pause
