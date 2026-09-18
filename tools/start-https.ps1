#requires -Version 5.1
# Launch THIS release through the HTTPS proxy installed by the Windows package.
$ErrorActionPreference = 'Stop'
try {
    $marker = Join-Path $env:ProgramData 'FishGameHTTPS-9000\install.json'
    if (-not (Test-Path -LiteralPath $marker)) {
        throw 'HTTPS is not installed. Run Install-HTTPS.bat from the HTTPS installation package as administrator first.'
    }
    $config = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($config.package -ne 'fishgame-https-9000-v1') { throw 'Invalid HTTPS installation marker. Reinstall the HTTPS package.' }
    if (@(Get-NetTCPConnection -State Listen -LocalPort 9001 -ErrorAction SilentlyContinue).Count) {
        throw 'Port 9001 is already in use. Enter q in the old game console to save and stop it before starting this release.'
    }
    $env:PORT = '9001'
    if ($config.dataDir) { $env:FISHING_DATA_DIR = $config.dataDir }
    $gameDir = Split-Path $PSScriptRoot -Parent
    Set-Location -LiteralPath $gameDir
    Write-Host ('Starting game from: ' + $gameDir)
    Write-Host 'Game backend: http://127.0.0.1:9001'
    Write-Host 'Public URL: https://ipv4.rinkore.com:9000'
    Write-Host 'Keep the Caddy task running. Enter q here to save and stop the game.'
    & '.\run.bat'
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
