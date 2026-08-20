@echo off
setlocal
cd /d "%~dp0"
title Betime Docker
echo Starting Betime Docker stack on http://127.0.0.1:19120/web/
echo.
docker compose up -d --build
if not exist ".tmp" mkdir ".tmp"
echo 19120> ".tmp\betime-local-port.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (-not (Get-NetTCPConnection -LocalPort 3129 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath node -ArgumentList 'scripts\aidlc-bt-forward-proxy.cjs' -WorkingDirectory '%CD%' -WindowStyle Hidden }"
echo.
echo Health check: http://127.0.0.1:19120/web/api/health
pause
