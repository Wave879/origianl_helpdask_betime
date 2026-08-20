function Test-BetimePortOpen {
    param(
        [string]$HostName = "127.0.0.1",
        [int]$PortNumber
    )

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($HostName, $PortNumber, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(1200, $false)
        if (-not $ok) {
            $client.Close()
            return $false
        }
        $client.EndConnect($async)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Get-BetimeFreePort {
    param(
        [int]$PreferredPort = 8788,
        [int]$StartPort = 8788
    )

    $preferred = [Math]::Max(0, [int]$PreferredPort)
    if ($preferred -gt 0 -and -not (Test-BetimePortOpen -HostName "127.0.0.1" -PortNumber $preferred)) {
        return $preferred
    }

    $start = [Math]::Max(1024, [int]$StartPort)
    for ($port = $start; $port -lt 65535; $port++) {
        if (-not (Test-BetimePortOpen -HostName "127.0.0.1" -PortNumber $port)) {
            return $port
        }
    }

    throw "No free TCP port found."
}

function Get-BetimePortFilePath {
    param([string]$Root)

    return Join-Path $Root ".tmp\betime-local-port.txt"
}

function Write-BetimePortFile {
    param(
        [string]$Root,
        [int]$Port
    )

    $portFile = Get-BetimePortFilePath -Root $Root
    $portDir = Split-Path -Parent $portFile
    New-Item -ItemType Directory -Force -Path $portDir | Out-Null
    Set-Content -Path $portFile -Value ([string]$Port)
    return $portFile
}

function Read-BetimePortFile {
    param(
        [string]$Root,
        [int]$DefaultPort = 8788
    )

    $portFile = Get-BetimePortFilePath -Root $Root
    if (Test-Path $portFile) {
        $raw = (Get-Content -Path $portFile -Raw).Trim()
        if ($raw -match '^\d+$') {
            return [int]$raw
        }
    }

    return [int]$DefaultPort
}
