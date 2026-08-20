@echo off
setlocal
cd /d "%~dp0"
title Stop Betime Docker
docker compose down
pause
