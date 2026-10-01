#requires -Version 5.1
# Self-update for the Windows Go release package.
#   powershell -File tools\update.ps1            check and install the newest release
#   powershell -File tools\update.ps1 -Check     only report whether an update exists
# Game data lives in PostgreSQL and is never touched by this script.
param(
    [switch]$Check,
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$repo = 'Rinkore/web-fishing-game'
$script:token = $Token
if (-not $script:token -and $env:GITHUB_TOKEN) { $script:token = $env:GITHUB_TOKEN }
if (-not $script:token) {
    $tokenFile = Join-Path $PSScriptRoot '.github-token'
    if (Test-Path -LiteralPath $tokenFile) { $script:token = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
}

function Get-VersionParts([string]$value) {
    $bits = ($value -replace '^v', '') -split '\.'
    $numbers = @()
    foreach ($bit in $bits) {
        $n = 0
        if ([int]::TryParse($bit, [ref]$n)) { $numbers += $n } else { $numbers += 0 }
    }
    return $numbers
}

function Test-Newer([string]$candidate, [string]$current) {
    $a = Get-VersionParts $candidate
    $b = Get-VersionParts $current
    $len = [Math]::Max($a.Count, $b.Count)
    for ($i = 0; $i -lt $len; $i++) {
        $x = if ($i -lt $a.Count) { $a[$i] } else { 0 }
        $y = if ($i -lt $b.Count) { $b[$i] } else { 0 }
        if ($x -ne $y) { return ($x -gt $y) }
    }
    return $false
}

function Get-LocalVersion {
    $dataFile = Join-Path $root 'frontend\js\data.js'
    $match = [regex]::Match([IO.File]::ReadAllText($dataFile), "VERSION\s*=\s*'([^']+)'")
    if ($match.Success) { return $match.Groups[1].Value }
    return $null
}

function Get-Proxies {
    $list = @('')
    foreach ($candidate in @($env:HTTPS_PROXY, 'http://127.0.0.1:7890')) {
        if ($candidate -and ($list -notcontains $candidate)) { $list += $candidate }
    }
    return $list
}

function Get-ApiHeaders {
    $headers = @{ 'User-Agent' = 'web-fishing-game-updater'; 'Accept' = 'application/vnd.github+json' }
    if ($script:token) { $headers['Authorization'] = 'token ' + $script:token }
    return $headers
}

function Get-LatestRelease {
    $lastError = $null
    foreach ($proxy in Get-Proxies) {
        try {
            $args = @{
                Uri         = "https://api.github.com/repos/$repo/releases/latest"
                Headers     = Get-ApiHeaders
                ErrorAction = 'Stop'
            }
            if ($proxy) { $args['Proxy'] = $proxy }
            return Invoke-RestMethod @args
        } catch {
            $lastError = $_
        }
    }
    throw $lastError
}

function Save-File([string]$url, [string]$destination) {
    $lastError = $null
    foreach ($proxy in Get-Proxies) {
        try {
            $arguments = @('-fSL', '-o', $destination, '-H', 'User-Agent: web-fishing-game-updater')
            if ($script:token) { $arguments += @('-H', 'Authorization: token ' + $script:token) }
            if ($proxy) { $arguments += @('--proxy', $proxy) }
            $arguments += $url
            & curl.exe @arguments
            if ($LASTEXITCODE -ne 0) { throw "curl exit code $LASTEXITCODE" }
            return
        } catch {
            $lastError = $_
        }
    }
    throw $lastError
}

function Copy-Tree([string]$source, [string]$destination) {
    foreach ($entry in Get-ChildItem -LiteralPath $source -Force) {
        $target = Join-Path $destination $entry.Name
        if ($entry.PSIsContainer) {
            if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
            Copy-Tree $entry.FullName $target
        } else {
            Copy-Item -LiteralPath $entry.FullName -Destination $target -Force
        }
    }
}

$local = Get-LocalVersion
$shown = 'unknown'
if ($local) { $shown = $local }
Write-Host ('Current version: ' + $shown)

Write-Host 'Querying the newest GitHub release...'
$release = Get-LatestRelease
if (-not $release -or -not $release.tag_name) {
    throw 'Cannot query the release list. Private repositories need a token: set GITHUB_TOKEN, write tools\.github-token, or pass -Token.'
}
$tag = $release.tag_name
Write-Host ('Newest version: ' + $tag)

if ($local -and -not (Test-Newer $tag $local)) {
    Write-Host 'Already up to date.'
    exit 0
}
if ($Check) {
    Write-Host ('Update available: ' + $tag + ' (current ' + $local + ').')
    exit 2
}

$asset = @($release.assets) | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
$url = if ($asset) { $asset.browser_download_url } else { $release.zipball_url }
if (-not $url) { throw 'The release has no downloadable zip asset.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ('fishing-update-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$zipPath = Join-Path $temp 'release.zip'
$extractPath = Join-Path $temp 'extract'
New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

try {
    Write-Host ('Downloading ' + $url)
    Save-File $url $zipPath

    Write-Host 'Extracting...'
    & tar.exe -xf $zipPath -C $extractPath
    if ($LASTEXITCODE -ne 0) { throw 'Extraction failed.' }

    $source = $extractPath
    $entries = @(Get-ChildItem -LiteralPath $extractPath -Force)
    if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $source = $entries[0].FullName }

    Write-Host 'Replacing program files (database and player data are untouched)...'
    Copy-Tree $source $root
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}

Write-Host ('Update complete: ' + $local + ' -> ' + $tag)
Write-Host 'Restart the game with run.bat; browsers pick up the new frontend automatically.'