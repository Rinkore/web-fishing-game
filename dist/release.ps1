param(
    [Parameter(Mandatory=$true)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Version,
    [switch]$NameOnly,
    [switch]$SkipAsset,
    [string]$Token
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$remote = (& git remote get-url origin).Trim()
$uri = [Uri]$remote
$repo = $uri.AbsolutePath.Trim('/').Replace('.git', '')
if ($uri.Host -ne 'github.com' -or $repo -notmatch '^[\w.-]+/[\w.-]+$') { throw 'Unsupported GitHub remote' }
if (-not $Token) { $Token = $env:GITHUB_TOKEN }
if (-not $Token -and $uri.UserInfo) {
    $parts = $uri.UserInfo.Split(':', 2)
    $Token = [Uri]::UnescapeDataString($parts[$parts.Length - 1])
}
if (-not $Token) {
    $credential = "protocol=https`nhost=github.com`n`n" | & git credential fill 2>$null
    $line = $credential | Where-Object { $_.StartsWith('password=') } | Select-Object -First 1
    if ($line) { $Token = $line.Substring(9) }
}
if (-not $Token) { throw 'No GitHub publishing credential available' }
$headers = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'FISHGAME-release'; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$api = "https://api.github.com/repos/$repo"
$notes = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "notes-$Version.md"))
$firstLine = ($notes -split '\r?\n')[0]
$match = [regex]::Match($firstLine, 'v\d+\.\d+\.\d+.*$')
if (-not $match.Success -or -not $match.Value.StartsWith("$Version ")) { throw 'Release title must begin with the requested version' }
$name = $match.Value
function JsonRequest($method, $url, $body) {
    $json = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8 -Compress))
    Invoke-RestMethod -Method $method -Uri $url -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $json
}
$tag = & git rev-parse "$Version^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Create and push the release tag first' }
if (-not $SkipAsset -and -not $NameOnly) {
    $packedCommit = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web-fishing-game-win64\SOURCE_COMMIT.txt')).Trim()
    if ($packedCommit -ne $tag) { throw 'Package source commit differs from release tag' }
    $zip = Join-Path $PSScriptRoot 'web-fishing-game-win64.zip'
    $sum = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected = ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web-fishing-game-win64/SHA256SUMS.txt')) -split '\s+')[0]
    if ($sum -ne $expected) { throw 'Package checksum mismatch' }
}
$release = $null
try { $release = Invoke-RestMethod -Uri "$api/releases/tags/$Version" -Headers $headers }
catch { if ([int]$_.Exception.Response.StatusCode -ne 404) { throw } }
if (-not $release) {
    if ($NameOnly) { throw 'Release not found' }
    $release = JsonRequest POST "$api/releases" @{ tag_name=$Version; name=$name; body=$notes; draft=$true; prerelease=$false }
}
if ($NameOnly) {
    $release = JsonRequest PATCH "$api/releases/$($release.id)" @{name=$name}
} else {
    if (-not $SkipAsset) {
        foreach ($assetName in @('web-fishing-game-win64.zip', 'SHA256SUMS.txt')) {
            foreach ($old in @($release.assets | Where-Object { $_.name -eq $assetName })) {
                Invoke-RestMethod -Method Delete -Uri "$api/releases/assets/$($old.id)" -Headers $headers | Out-Null
            }
            $file = if ($assetName -eq 'SHA256SUMS.txt') { Join-Path $PSScriptRoot 'web-fishing-game-win64/SHA256SUMS.txt' } else { Join-Path $PSScriptRoot $assetName }
            $upload = ($release.upload_url -replace '\{.*$', '') + '?name=' + [Uri]::EscapeDataString($assetName)
            $asset = Invoke-RestMethod -Method Post -Uri $upload -Headers $headers -ContentType 'application/octet-stream' -InFile $file
            if ($asset.state -ne 'uploaded' -or $asset.size -ne (Get-Item -LiteralPath $file).Length) { throw 'Uploaded asset size mismatch' }
            if ($asset.digest) {
                $localDigest = 'sha256:' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($asset.digest -ne $localDigest) { throw 'Uploaded asset digest mismatch' }
            }
        }
    }
    $release = JsonRequest PATCH "$api/releases/$($release.id)" @{name=$name; body=$notes; draft=$false; prerelease=$false; make_latest='true'}
}
Write-Host "Published $($release.html_url)"
