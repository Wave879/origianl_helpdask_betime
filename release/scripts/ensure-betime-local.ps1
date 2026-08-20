param(
    [string]$PgUrl = "postgres://postgres:123456@localhost:5432/Betime_DB",
    [int]$Port = 8788
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "betime-port.ps1")

if (-not (Test-BetimePortOpen -HostName "127.0.0.1" -PortNumber 5432)) {
    Write-Host "PostgreSQL is not running on localhost:5432" -ForegroundColor Yellow
    exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$selectedPort = Get-BetimeFreePort -PreferredPort $Port -StartPort $Port
Write-BetimePortFile -Root $root -Port $selectedPort | Out-Null

if (Test-BetimePortOpen -HostName "127.0.0.1" -PortNumber $selectedPort) {
    Write-Host "Betime local worker is already running on port $selectedPort" -ForegroundColor Green
    exit 0
}

$env:XDG_CONFIG_HOME = Join-Path $root ".xdg"
New-Item -ItemType Directory -Force -Path $env:XDG_CONFIG_HOME | Out-Null
$logOut = Join-Path $root "betime-auto.out.log"
$logErr = Join-Path $root "betime-auto.err.log"
$command = "cd /d `"$root`" && npx wrangler pages dev deploy/pages_bundle --port $selectedPort --compatibility-date 2026-04-27 -b PG_URL=$PgUrl"

$odooUrl = [Environment]::GetEnvironmentVariable("ODOO_URL")
if ([string]::IsNullOrWhiteSpace($odooUrl)) {
    $odooUrl = [Environment]::GetEnvironmentVariable("ODOO_BASE_URL")
}
if ([string]::IsNullOrWhiteSpace($odooUrl)) {
    $odooUrl = "http://bt.dev.demotoday.net"
}
$odooDb = [Environment]::GetEnvironmentVariable("ODOO_DB")
if ([string]::IsNullOrWhiteSpace($odooDb)) {
    $odooDb = "bt-helpdesk"
}
$odooLogin = [Environment]::GetEnvironmentVariable("ODOO_LOGIN")
if ([string]::IsNullOrWhiteSpace($odooLogin)) {
    $odooLogin = "admin"
}
$odooPassword = [Environment]::GetEnvironmentVariable("ODOO_PASSWORD")
if ([string]::IsNullOrWhiteSpace($odooPassword)) {
    $odooPassword = "bt@admin"
}
$odooChannel = [Environment]::GetEnvironmentVariable("ODOO_CHANNEL")
if ([string]::IsNullOrWhiteSpace($odooChannel)) {
    $odooChannel = "Website"
}
$odooDirectCreate = [Environment]::GetEnvironmentVariable("ODOO_DIRECT_CREATE")
if ([string]::IsNullOrWhiteSpace($odooDirectCreate)) {
    $odooDirectCreate = "1"
}
$odooLocalFallback = [Environment]::GetEnvironmentVariable("ODOO_LOCAL_FALLBACK")
if ([string]::IsNullOrWhiteSpace($odooLocalFallback)) {
    $odooLocalFallback = "1"
}
$command += " -b ODOO_URL=$odooUrl -b ODOO_DB=$odooDb -b ODOO_LOGIN=$odooLogin -b ODOO_PASSWORD=$odooPassword -b ODOO_CHANNEL=$odooChannel -b ODOO_DIRECT_CREATE=$odooDirectCreate -b ODOO_LOCAL_FALLBACK=$odooLocalFallback"

foreach ($name in @(
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_ENDPOINT",
    "AZURE_SPEECH_REGION",
    "AZURE_KEY",
    "AZURE_REGION",
    "MAI_KEY",
    "MAI_REGION",
    "AZURE_AI_URL",
    "AZURE_AI_KEY",
    "AZURE_AI_MODEL",
    "AZURE_AI_ENDPOINT",
    "AZURE_AI_DEPLOYMENT",
    "AZURE_AI_API_VERSION",
    "AZURE_AI_MODELS_CHAT_URL",
    "AZURE_AI_MODELS_CHAT_KEY",
    "AZURE_AI_MODELS_CHAT_MODEL",
    "AZURE_AI_MODELS_CHAT_ENDPOINT",
    "AZURE_AI_MODELS_CHAT_DEPLOYMENT",
    "AZURE_AI_MODELS_CHAT_API_VERSION",
    "AZURE_OPENAI_CHAT_URL",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_KEY",
    "OAI_ENDPOINT",
    "OAI_DEPLOY",
    "OAI_API_VERSION",
    "OAI_KEY",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_API_PROVIDER",
    "OPENROUTER_API_KEY",
    "OPENROUTER_EMBEDDING_MODEL",
    "OPENROUTER_EMBEDDING_URL",
    "OPENROUTER_HTTP_REFERER",
    "OPENROUTER_APP_TITLE",
    "QDRANT_BRIDGE_API_KEY",
    "QDRANT_BRIDGE_ALLOW_UNAUTH",
    "QDRANT_URL",
    "QDRANT_CLUSTER_URL",
    "QDRANT_ENDPOINT",
    "QDRANT_DB_API_KEY",
    "QDRANT_CLOUD_API_KEY",
    "QDRANT_DATABASE_API_KEY",
    "QDRANT_COLLECTION",
    "QDRANT_DISTANCE"
)) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        $command += " -b $name=$value"
    }
}

Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", $command `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr

Start-Sleep -Seconds 5

if (Test-BetimePortOpen -HostName "127.0.0.1" -PortNumber $selectedPort) {
    Write-Host "Betime local worker started on http://127.0.0.1:$selectedPort" -ForegroundColor Green
    exit 0
}

Write-Host "Betime local worker did not start correctly. Check betime-auto.err.log" -ForegroundColor Red
exit 1
