param(
    [string]$ShortcutName = "Betime Local AutoStart.cmd"
)

$ErrorActionPreference = "Stop"

$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$startupLauncher = Join-Path $startupDir $ShortcutName

if (Test-Path $startupLauncher) {
    Remove-Item $startupLauncher -Force
}

Write-Host "Removed auto-start launcher: $startupLauncher" -ForegroundColor Green
