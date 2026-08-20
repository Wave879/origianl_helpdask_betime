param(
    [string]$PgUrl = "postgres://postgres:123456@localhost:5432/Betime_DB",
    [int]$Port = 8788,
    [string]$LoginPath = "/login"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "betime-port.ps1")

function Wait-ForHttpOk {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        } catch {
        }
        Start-Sleep -Seconds 1
    }

    return $false
}

$root = Split-Path -Parent $PSScriptRoot
$desiredPort = [int]$Port
$selectedPort = $desiredPort

Write-Host ""
Write-Host "Betime local launcher" -ForegroundColor Cyan
Write-Host "Requested port : $desiredPort" -ForegroundColor Green
Write-Host "DB URL  : $PgUrl" -ForegroundColor Green
Write-Host ""

if (-not (Test-BetimePortOpen -HostName "127.0.0.1" -PortNumber 5432)) {
    Write-Host "PostgreSQL is not running on localhost:5432" -ForegroundColor Red
    Write-Host "Please start PostgreSQL service 'postgresql-x64-16' first." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-BetimePortOpen -HostName "127.0.0.1" -PortNumber $selectedPort)) {
    Write-Host "Starting Betime worker..." -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts\ensure-betime-local.ps1") -PgUrl $PgUrl -Port $desiredPort | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Unable to start Betime worker." -ForegroundColor Red
        exit $LASTEXITCODE
    }
} else {
    Write-Host "Betime worker is already running on port $selectedPort" -ForegroundColor Green
}

$selectedPort = Read-BetimePortFile -Root $root -DefaultPort $desiredPort
$loginUrl = "http://127.0.0.1:$selectedPort$LoginPath"
$healthUrl = "http://127.0.0.1:$selectedPort/api/health"

& powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts\write-nginx-betime-conf.ps1") -Port $selectedPort | Out-Host

Write-Host "Waiting for web app..." -ForegroundColor Cyan
if (-not (Wait-ForHttpOk -Url $healthUrl -TimeoutSeconds 20)) {
    Write-Host "Web app did not become ready in time." -ForegroundColor Red
    Write-Host "Check betime-auto.err.log or wrangler-local.err.log for details." -ForegroundColor Yellow
    exit 1
}

Write-Host "Opening login page..." -ForegroundColor Cyan
Start-Process $loginUrl

Write-Host ""
Write-Host "Betime is ready." -ForegroundColor Green
Write-Host "Login page : $loginUrl"
Write-Host "Health     : $healthUrl"
exit 0
