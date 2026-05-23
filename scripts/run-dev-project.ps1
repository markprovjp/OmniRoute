param(
  [int]$DashboardPort = 20132,
  [int]$ApiPort = 20133,
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (!$async.AsyncWaitHandle.WaitOne(800)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Load-EnvFile([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    if ($_ -match "^\s*#") { return }
    if ($_ -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

if ($Install -or !(Test-Path -LiteralPath (Join-Path $repo "node_modules"))) {
  Write-Step "Installing npm dependencies"
  npm install
}

if (Test-TcpPort "127.0.0.1" $DashboardPort) {
  throw "Dashboard port $DashboardPort is already in use. Pass -DashboardPort <port> to choose another one."
}

if (Test-TcpPort "127.0.0.1" $ApiPort) {
  throw "API port $ApiPort is already in use. Pass -ApiPort <port> to choose another one."
}

Load-EnvFile (Join-Path $repo ".env")

$dataDir = Join-Path $repo ".data\dev"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$env:NODE_ENV = "development"
$env:HOST = "0.0.0.0"
$env:HOSTNAME = "0.0.0.0"
$env:PORT = [string]$DashboardPort
$env:DASHBOARD_PORT = [string]$DashboardPort
$env:API_PORT = [string]$ApiPort
$env:API_HOST = "0.0.0.0"
$env:NEXT_PUBLIC_BASE_URL = "http://localhost:$DashboardPort"
$env:DATA_DIR = $dataDir
$env:REQUIRE_API_KEY = "false"
$env:AUTH_COOKIE_SECURE = "false"
$env:OMNIROUTE_USE_TURBOPACK = "0"
$env:OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1"

Write-Step "Starting OmniRoute dev server with SQLite"
Write-Host "Dashboard: http://localhost:$DashboardPort" -ForegroundColor Green
Write-Host "API:       http://localhost:$DashboardPort/v1" -ForegroundColor Green
Write-Host "Data dir:  $dataDir" -ForegroundColor Green
Write-Host ""

npm run dev
