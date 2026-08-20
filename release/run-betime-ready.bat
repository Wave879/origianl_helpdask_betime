@echo off
setlocal
cd /d "%~dp0"
title Betime Ready
powershell -ExecutionPolicy Bypass -File ".\scripts\run-betime-ready.ps1"
echo.
pause
