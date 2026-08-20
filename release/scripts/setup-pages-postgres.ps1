param(
    [string]$ProjectName = "betime-solution",
    [string]$ConnectionString = "",
    [string]$HyperdriveName = "betime-prod",
    [switch]$Deploy
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Require-Command($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Command not found: $name"
    }
}

function Get-ResolvedConnectionString {
    param([string]$RawValue)

    $value = $RawValue
    if (-not $value) { $value = $env:PG_URL }
    if (-not $value) { $value = $env:DATABASE_URL }
    if (-not $value) {
        throw "PG connection string is missing. Pass -ConnectionString or set PG_URL."
    }

    $value = $value.Trim()
    if ($value -notmatch '^postgres(ql)?://') {
        throw "Connection string must start with postgres:// or postgresql://"
    }

    $uri = [System.Uri]$value
    $host = ""
    if ($uri.Host) {
        $host = $uri.Host.ToLowerInvariant()
    }
    if ($host -in @("localhost", "127.0.0.1", "::1")) {
        throw "Cloudflare Pages cannot connect to localhost PostgreSQL. Use a public Postgres host such as Neon, Supabase, Railway, Render, or RDS."
    }

    return $value
}

function Get-HyperdriveIdByName {
    param([string]$Name)

    $json = & npx wrangler hyperdrive list --json 2>$null
    if (-not $json) { return $null }

    $items = $json | ConvertFrom-Json
    $match = $items | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($match) { return $match.id }
    return $null
}

function New-OrGetHyperdrive {
    param(
        [string]$Name,
        [string]$PgUrl
    )

    $existingId = Get-HyperdriveIdByName -Name $Name
    if ($existingId) {
        Write-Host "Using existing Hyperdrive: $Name ($existingId)" -ForegroundColor Green
        return $existingId
    }

    Write-Step "Creating Hyperdrive '$Name'"
    $output = & npx wrangler hyperdrive create $Name "--connection-string=$PgUrl" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to create Hyperdrive.`n$output"
    }

    $joined = ($output | Out-String)
    if ($joined -match '([0-9a-f]{32})') {
        $id = $Matches[1]
        Write-Host "Created Hyperdrive: $id" -ForegroundColor Green
        return $id
    }

    $fallbackId = Get-HyperdriveIdByName -Name $Name
    if ($fallbackId) { return $fallbackId }
    throw "Hyperdrive was created but the id could not be detected automatically."
}

function Update-WranglerToml {
    param(
        [string]$FilePath,
        [string]$HyperdriveId
    )

    $raw = Get-Content -Path $FilePath -Raw
    $hyperdriveBlockPattern = '(?ms)^\[\[hyperdrive\]\]\r?\n.*?(?=^\[\[|\Z)'
    $raw = [System.Text.RegularExpressions.Regex]::Replace($raw, $hyperdriveBlockPattern, '')
    $raw = $raw.TrimEnd("`r", "`n")

    $block = @"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "$HyperdriveId"
"@

    Set-Content -Path $FilePath -Value ($raw + $block + "`r`n")
}

Require-Command npx

Write-Step "Checking Wrangler login"
& npx wrangler whoami | Out-Host

$pgUrl = Get-ResolvedConnectionString -RawValue $ConnectionString
Write-Step "Using PostgreSQL host $(([System.Uri]$pgUrl).Host)"

$hyperdriveId = New-OrGetHyperdrive -Name $HyperdriveName -PgUrl $pgUrl

Write-Step "Updating wrangler.toml"
Update-WranglerToml -FilePath (Join-Path $PSScriptRoot "..\\wrangler.toml") -HyperdriveId $hyperdriveId

Write-Step "Saving PG_URL as Cloudflare Pages secret"
$pgUrl | & npx wrangler pages secret put PG_URL --project-name $ProjectName
if ($LASTEXITCODE -ne 0) {
    throw "Unable to save PG_URL secret to Pages project $ProjectName"
}

if ($Deploy) {
    Write-Step "Deploying Pages project"
    & npx wrangler pages deploy deploy/pages_bundle --project-name $ProjectName | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Pages deploy failed"
    }
}

Write-Host ""
Write-Host "PostgreSQL setup completed." -ForegroundColor Green
Write-Host "Project     : $ProjectName"
Write-Host "Hyperdrive  : $HyperdriveName ($hyperdriveId)"
Write-Host "Health check: https://$ProjectName.pages.dev/api/health"
