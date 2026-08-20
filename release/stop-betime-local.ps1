$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "betime-port.ps1")

$portFile = Get-BetimePortFilePath -Root $root
$selectedPort = $null
if (Test-Path $portFile) {
    $rawPort = (Get-Content -Path $portFile -Raw).Trim()
    if ($rawPort -match '^\d+$') {
        $selectedPort = [int]$rawPort
    }
}

Get-CimInstance Win32_Process |
    Where-Object {
        $cmd = $_.CommandLine
        if ($cmd -like '*wrangler pages dev deploy/pages_bundle*') {
            return $true
        }
        if ($cmd -like '*workerd.exe*serve*' -and $cmd -like '*socket-addr=entry=127.0.0.1:*') {
            if ($selectedPort) {
                return $cmd -like "*socket-addr=entry=127.0.0.1:$selectedPort*"
            }
            return $true
        }
        return $false
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
    }

Write-Host "Stopped local Betime worker processes." -ForegroundColor Green
