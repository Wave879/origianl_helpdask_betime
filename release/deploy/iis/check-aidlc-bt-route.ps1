$ErrorActionPreference = "Continue"

$checks = @(
    @{ Name = "Local Docker nginx"; Url = "http://192.168.100.12:19120/web/api/health" },
    @{ Name = "Local host nginx"; Url = "http://127.0.0.1:19120/web/api/health" },
    @{ Name = "Public domain"; Url = "https://aidlc-bt.demotoday.net/web/" }
)

foreach ($check in $checks) {
    Write-Host ""
    Write-Host "== $($check.Name) ==" -ForegroundColor Cyan
    Write-Host $check.Url
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $check.Url -TimeoutSec 15
        Write-Host "HTTP $($response.StatusCode)" -ForegroundColor Green
        if ($response.Content) {
            $preview = $response.Content
            if ($preview.Length -gt 300) {
                $preview = $preview.Substring(0, 300)
            }
            Write-Host $preview
        }
    } catch {
        Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "DNS from this machine:" -ForegroundColor Cyan
Resolve-DnsName aidlc-bt.demotoday.net -ErrorAction Continue
