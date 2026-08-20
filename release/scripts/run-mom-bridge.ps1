param(
  [int]$Port = 9001
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$scriptPath = Join-Path $projectRoot "scripts\mom_bridge_server.py"

$env:MOM_BRIDGE_PORT = "$Port"

if (-not $env:AZURE_SPEECH_KEY -and $env:AZURE_KEY) {
  $env:AZURE_SPEECH_KEY = $env:AZURE_KEY
}
if (-not $env:AZURE_SPEECH_KEY -and $env:MAI_KEY) {
  $env:AZURE_SPEECH_KEY = $env:MAI_KEY
}
if (-not $env:AZURE_SPEECH_ENDPOINT -and $env:AZURE_ENDPOINT) {
  $env:AZURE_SPEECH_ENDPOINT = $env:AZURE_ENDPOINT
}
if (-not $env:AZURE_SPEECH_REGION) {
  $env:AZURE_SPEECH_REGION = if ($env:AZURE_REGION) { $env:AZURE_REGION } elseif ($env:MAI_REGION) { $env:MAI_REGION } else { "eastus" }
}

$pythonCandidates = @(
  "C:\Users\wave\AppData\Local\Programs\Python\Python310\python.exe",
  "python"
)

$python = $pythonCandidates | Where-Object {
  if ($_ -eq "python") {
    return [bool](Get-Command python -ErrorAction SilentlyContinue)
  }
  Test-Path $_
} | Select-Object -First 1

if (-not $python) {
  throw "Python executable was not found."
}

& $python -u $scriptPath
