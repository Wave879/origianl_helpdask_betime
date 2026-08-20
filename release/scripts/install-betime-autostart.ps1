param(
    [string]$ShortcutName = "Betime Local AutoStart.cmd"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $root "start-betime-local.bat"
$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$startupLauncher = Join-Path $startupDir $ShortcutName

@(
    "@echo off"
    "cd /d `"$root`""
    "call `"$launcherPath`""
) | Set-Content -Path $startupLauncher -Encoding ASCII

Write-Host ""
Write-Host "Installed auto-start launcher:" -ForegroundColor Green
Write-Host $startupLauncher -ForegroundColor Green
Write-Host "It will start Betime local worker after you sign in." -ForegroundColor Green
