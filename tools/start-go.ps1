#requires -Version 5.1
# Launcher for the Go game server. Used by run.bat and Start-Game-HTTPS.bat.
#   powershell -File tools\start-go.ps1 [-Listen 127.0.0.1:9000]
# Reads optional config.env next to the release root (KEY=VALUE per line):
#   FISHING_GO_DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=disable
#   FISHING_GO_TIMEZONE=Asia/Shanghai
param(
    [string]$Listen = ''
)

$ErrorActionPreference = 'Stop'

$gameDir = Split-Path -Parent $PSScriptRoot

function Import-ConfigEnv([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    foreach ($line in Get-Content -LiteralPath $path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $index = $trimmed.IndexOf('=')
        if ($index -lt 1) { continue }
        $name = $trimmed.Substring(0, $index).Trim()
        $value = $trimmed.Substring($index + 1).Trim()
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

Import-ConfigEnv (Join-Path $gameDir 'config.env')

if ($Listen) { $env:FISHING_GO_LISTEN = $Listen }
if (-not $env:FISHING_GO_LISTEN) { $env:FISHING_GO_LISTEN = '127.0.0.1:9000' }
if (-not $env:FISHING_GO_FRONTEND_DIR) { $env:FISHING_GO_FRONTEND_DIR = Join-Path $gameDir 'frontend' }

if (-not $env:FISHING_GO_DATABASE_URL) {
    Write-Host 'FISHING_GO_DATABASE_URL is required.'
    Write-Host ('Create ' + (Join-Path $gameDir 'config.env') + ' with:')
    Write-Host 'FISHING_GO_DATABASE_URL=postgres://user:password@127.0.0.1:5432/fishing?sslmode=disable'
    Write-Host 'FISHING_GO_TIMEZONE=Asia/Shanghai'
    exit 2
}

Set-Location -LiteralPath $gameDir
$packaged = Join-Path $gameDir 'game.exe'
if (Test-Path -LiteralPath $packaged) {
    Write-Host ('Starting Go server on ' + $env:FISHING_GO_LISTEN + ' (frontend: ' + $env:FISHING_GO_FRONTEND_DIR + ')')
    & $packaged
    exit $LASTEXITCODE
}

$go = (Get-Command go -ErrorAction SilentlyContinue)
if (-not $go) {
    Write-Host 'game.exe is missing and no Go toolchain was found on PATH.'
    exit 3
}
Write-Host ('Starting Go server from source on ' + $env:FISHING_GO_LISTEN)
Push-Location (Join-Path $gameDir 'server-go')
try {
    & $go.Source run ./cmd/game
    exit $LASTEXITCODE
} finally {
    Pop-Location
}