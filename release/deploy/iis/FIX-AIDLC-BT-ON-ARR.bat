@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo This must run as Administrator on the IIS/ARR server.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Installing BETIME /web route for aidlc-bt.demotoday.net ...
echo Upstream: http://192.168.100.12
echo.

echo Checking upstream from this ARR server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://192.168.100.12/web/api/health' -TimeoutSec 15; if ($r.StatusCode -ne 200) { throw ('HTTP ' + $r.StatusCode) }; Write-Host 'UPSTREAM OK' -ForegroundColor Green } catch { Write-Host ('UPSTREAM FAILED: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
  echo.
  echo ARR cannot reach http://192.168.100.12/web/api/health.
  echo Fix routing or firewall between 192.168.0.227 and 192.168.100.12 first.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-arr-web-route.ps1" -HostName "aidlc-bt.demotoday.net" -NginxBaseUrl "http://192.168.100.12"
if errorlevel 1 (
  echo.
  echo ARR route installation FAILED. IIS configuration was not verified.
  pause
  exit /b 1
)

echo.
echo Verifying public route from this ARR server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://aidlc-bt.demotoday.net/web/' -TimeoutSec 20; Write-Host ('OK: ' + $r.StatusCode) -ForegroundColor Green } catch { Write-Host ('FAILED: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"

pause
