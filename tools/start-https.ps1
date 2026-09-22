#requires -Version 5.1
# Launch THIS release through the HTTPS proxy installed by the Windows package.
$ErrorActionPreference = 'Stop'
try {
    $marker = Join-Path $env:ProgramData 'FishGameHTTPS-9000\install.json'
    if (-not (Test-Path -LiteralPath $marker)) {
        throw 'HTTPS is not installed. Run Install-HTTPS.bat from the HTTPS installation package as administrator first.'
    }
    $config = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($config.package -notin @('fishgame-https-9000-v1', 'fishgame-https-9000-v2')) { throw 'Invalid HTTPS installation marker. Reinstall the HTTPS package.' }
    if (@(Get-NetTCPConnection -State Listen -LocalPort 9001 -ErrorAction SilentlyContinue).Count) {
        throw 'Port 9001 is already in use. Stop the running game process before starting this release.'
    }
    $gameDir = Split-Path -Parent $PSScriptRoot
    Write-Host ('Starting game from: ' + $gameDir)
    Write-Host 'Game backend: http://127.0.0.1:9001'
    Write-Host 'Public URL: https://ipv4.rinkore.com:9000'
    Write-Host 'Keep the Caddy task running. Press Ctrl+C in this window to stop the game.'
    # The Go server binds loopback only and never trusts forwarded headers, so
    # the local Caddy proxy stays the single public entry point.
    & (Join-Path $PSScriptRoot 'start-go.ps1') -Listen '127.0.0.1:9001'
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}