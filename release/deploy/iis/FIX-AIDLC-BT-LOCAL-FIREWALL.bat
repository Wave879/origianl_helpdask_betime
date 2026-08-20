@echo off
setlocal

net session >nul 2>&1
if errorlevel 1 (
  echo This must run as Administrator on the BETIME Docker host.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Opening Docker nginx port 80 for the ARR reverse proxy...
echo Remote ARR: 192.168.0.227
echo Local port: 80
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$name='BETIME Docker nginx 80 from ARR';" ^
  "$existing=Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue;" ^
  "if ($existing) { Remove-NetFirewallRule -DisplayName $name };" ^
  "New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -RemoteAddress 192.168.0.227 -Profile Any | Out-Null;" ^
  "Write-Host 'OK: firewall rule installed.' -ForegroundColor Green"

echo.
echo Verify from the ARR server:
echo   powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing http://192.168.100.12/web/api/health"
echo.
pause
