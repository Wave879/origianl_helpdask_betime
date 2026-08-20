param(
    [string]$HostName = "aidlc-bt.demotoday.net",
    [string]$NginxBaseUrl = "http://192.168.100.12",
    [switch]$SkipUpstreamCheck
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window (Run as administrator)."
}

Import-Module WebAdministration
Add-Type -AssemblyName "Microsoft.Web.Administration"

$upstreamHealthUrl = $NginxBaseUrl.TrimEnd("/") + "/web/api/health"
if (-not $SkipUpstreamCheck) {
    try {
        $upstreamResponse = Invoke-WebRequest -UseBasicParsing -Uri $upstreamHealthUrl -TimeoutSec 15
        if ($upstreamResponse.StatusCode -ne 200) {
            throw "Unexpected HTTP status $($upstreamResponse.StatusCode)"
        }
    } catch {
        throw "BETIME upstream is not reachable from this IIS server: $upstreamHealthUrl. $($_.Exception.Message)"
    }
}

$serverManager = New-Object Microsoft.Web.Administration.ServerManager
$site = $serverManager.Sites | Where-Object {
    $_.Bindings | Where-Object {
        $_.Host -eq $HostName
    }
} | Select-Object -First 1

if (-not $site) {
    $site = $serverManager.Sites | Where-Object {
        $_.State -eq [Microsoft.Web.Administration.ObjectState]::Started -and
        ($_.Bindings | Where-Object { $_.Protocol -in @("http", "https") })
    } | Sort-Object {
        if ($_.Name -match "arr|proxy|reverse|default") { 0 } else { 1 }
    }, Name | Select-Object -First 1
}

if (-not $site) {
    throw "No running IIS HTTP/HTTPS site found. Add a site binding for $HostName or run this on the ARR reverse proxy server."
}

$backupName = "Before-Betime-Web-" + (Get-Date -Format "yyyyMMdd-HHmmss")
Backup-WebConfiguration -Name $backupName

$config = $serverManager.GetApplicationHostConfiguration()
try {
    $rulesSection = $config.GetSection("system.webServer/rewrite/rules", $site.Name)
} catch {
    throw "IIS URL Rewrite is not installed or its configuration section is unavailable."
}
$rules = $rulesSection.GetCollection()
$managedRuleNames = @(
    "BETIME - Normalize web prefix",
    "BETIME - Proxy web landing",
    "BETIME - Proxy web app",
    "BETIME - Normalize main prefix",
    "BETIME - Proxy main landing",
    "BETIME - Proxy main app",
    "BETIME - Proxy root files"
)

for ($index = $rules.Count - 1; $index -ge 0; $index--) {
    if ($managedRuleNames -contains [string]$rules[$index]["name"]) {
        $rules.RemoveAt($index)
    }
}

function New-RewriteRule {
    param(
        [string]$Name,
        [string]$Pattern,
        [string]$ActionType,
        [string]$Url,
        [string]$RedirectType = ""
    )

    $rule = $rules.CreateElement("rule")
    $rule["name"] = $Name
    $rule["stopProcessing"] = $true
    $rule.GetChildElement("match")["url"] = $Pattern

    $conditions = $rule.GetChildElement("conditions")
    $conditions["logicalGrouping"] = "MatchAll"
    $hostCondition = $conditions.GetCollection().CreateElement("add")
    $hostCondition["input"] = "{HTTP_HOST}"
    $hostCondition["pattern"] = "^$([regex]::Escape($HostName))$"
    $conditions.GetCollection().Add($hostCondition)

    $action = $rule.GetChildElement("action")
    $action["type"] = $ActionType
    $action["url"] = $Url
    if ($RedirectType) {
        $action["redirectType"] = $RedirectType
    }

    return $rule
}

$newRules = @(
    (New-RewriteRule "BETIME - Normalize web prefix" "^web$" "Redirect" "/web/" "Permanent"),
    (New-RewriteRule "BETIME - Proxy web landing" "^web/?$" "Rewrite" "$NginxBaseUrl/web/"),
    (New-RewriteRule "BETIME - Proxy web app" "^web/(.*)" "Rewrite" "$NginxBaseUrl/web/{R:1}"),
    (New-RewriteRule "BETIME - Proxy root files" "^(assets/betime_solution/.*|shared\.js|config\.js)$" "Rewrite" "$NginxBaseUrl/{R:1}")
)

for ($index = $newRules.Count - 1; $index -ge 0; $index--) {
    $rules.AddAt(0, $newRules[$index])
}

try {
    $proxySection = $config.GetSection("system.webServer/proxy")
} catch {
    throw "IIS Application Request Routing (ARR) is not installed."
}
$proxySection["enabled"] = $true
$proxySection["preserveHostHeader"] = $true
$proxySection["reverseRewriteHostInResponseHeaders"] = $false
$serverManager.CommitChanges()

Write-Host "Installed /web ARR rules on site '$($site.Name)'." -ForegroundColor Green
Write-Host "Backup: $backupName" -ForegroundColor Green
Write-Host "Upstream: $NginxBaseUrl" -ForegroundColor Green
Write-Host "Verify: https://$HostName/web/" -ForegroundColor Cyan
