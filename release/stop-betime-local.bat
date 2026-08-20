@echo off
setlocal
cd /d "%~dp0"
title Stop Betime Local
powershell -ExecutionPolicy Bypass -File ".\stop-betime-local.ps1"
pause

