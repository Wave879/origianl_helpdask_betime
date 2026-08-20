@echo off
setlocal
cd /d "%~dp0"
title Betime Local
echo Starting Betime local worker on an available 127.0.0.1 port
echo.
call npm run local:pages
