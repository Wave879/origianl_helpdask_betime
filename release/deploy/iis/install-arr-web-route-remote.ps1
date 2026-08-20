param(
    [string]$ComputerName = "192.168.0.227",
    [string]$HostName = "aidlc-bt.demotoday.net",
    [string]$NginxBaseUrl = "http://192.168.100.12:19120",
    [PSCredential]$Credential
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window (Run as administrator)."
}

if (-not $Credential) {
    $Credential = Get-Credential -Message "Enter an administrator account for $ComputerName"
}

$installer = Join-Path $PSScriptRoot "install-arr-web-route.ps1"
if (-not (Test-Path -LiteralPath $installer)) {
    throw "Installer not found: $installer"
}

$trustedHostsPath = "WSMan:\localhost\Client\TrustedHosts"
$originalTrustedHosts = ""
$trustedHostsChanged = $false
$winRmStarted = $false
$session = $null
$remoteInstaller = "C:\Windows\Temp\betime-install-arr-web-route-$([guid]::NewGuid().ToString('N')).ps1"

try {
    $winRmService = Get-Service WinRM
    if ($winRmService.Status -ne "Running") {
        Start-Service WinRM
        $winRmStarted = $true
    }

    $originalTrustedHosts = [string](Get-Item -LiteralPath $trustedHostsPath).Value
    $trustedHosts = @($originalTrustedHosts.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($originalTrustedHosts -ne "*" -and $trustedHosts -notcontains $ComputerName) {
        $newTrustedHosts = @($trustedHosts + $ComputerName) -join ","
        Set-Item -LiteralPath $trustedHostsPath -Value $newTrustedHosts -Force
        $trustedHostsChanged = $true
    }

    $session = New-PSSession -ComputerName $ComputerName -Credential $Credential -Authentication Negotiate
    Copy-Item -LiteralPath $installer -Destination $remoteInstaller -ToSession $session

    Invoke-Command -Session $session -ScriptBlock {
        param($InstallerPath, $SiteHostName, $Upstream)
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
        & $InstallerPath -HostName $SiteHostName -NginxBaseUrl $Upstream
    } -ArgumentList $remoteInstaller, $HostName, $NginxBaseUrl
} finally {
    if ($session) {
        Invoke-Command -Session $session -ScriptBlock {
            param($InstallerPath)
            Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
        } -ArgumentList $remoteInstaller -ErrorAction SilentlyContinue
        Remove-PSSession -Session $session
    }

    if ($trustedHostsChanged) {
        Set-Item -LiteralPath $trustedHostsPath -Value $originalTrustedHosts -Force
    }

    if ($winRmStarted) {
        Stop-Service WinRM
    }
}

Write-Host "Remote IIS route installation completed." -ForegroundColor Green
Write-Host "Verify: https://$HostName/web/" -ForegroundColor Cyan
