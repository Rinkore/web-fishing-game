param(
    [Parameter(Mandatory=$true)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Version,
    [switch]$NameOnly,
    [switch]$SkipAsset,
    [string]$LinuxManifest,
    [switch]$ValidateOnly,
    [string]$Token
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$remote = (& git remote get-url origin).Trim()
$uri = $null
if ($remote -match '^git@github\.com:([\w.-]+/[\w.-]+?)(?:\.git)?$') {
    $repo = $Matches[1]
} else {
    $uri = [Uri]$remote
    $repo = $uri.AbsolutePath.Trim('/') -replace '\.git$', ''
    if ($uri.Host -ne 'github.com' -or $repo -notmatch '^[\w.-]+/[\w.-]+$') { throw 'Unsupported GitHub remote' }
}
if ($env:GITHUB_REPOSITORY -and $env:GITHUB_REPOSITORY -ine $repo) { throw 'Workflow repository differs from origin' }
if ($LinuxManifest -and ($NameOnly -or $SkipAsset)) { throw 'LinuxManifest cannot be combined with NameOnly or SkipAsset' }
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
$assets = @()
if ($LinuxManifest) {
    $manifestPath = (Resolve-Path -LiteralPath $LinuxManifest).Path
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.version -cne $Version -or $manifest.sourceCommit -cne $tag.Trim()) { throw 'Linux manifest version/commit differs from release tag' }
    if ($manifest.asset -cne 'web-fishing-game-linux-amd64.tar.gz') { throw 'Unsupported Linux asset name' }
    if ($manifest.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $manifest.migrationsSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid Linux manifest checksum' }
    $headCommit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $headCommit -cne $manifest.sourceCommit) { throw 'Checkout differs from Linux release source' }
    $packagePath = Join-Path (Split-Path $manifestPath -Parent) $manifest.asset
    if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.sha256) { throw 'Linux package checksum mismatch' }
    $assets = @(
        @{ Name = $manifest.asset; Path = $packagePath },
        @{ Name = 'linux-release.json'; Path = $manifestPath }
    )
} elseif (-not $SkipAsset -and -not $NameOnly) {
    $packedCommit = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web-fishing-game-win64\SOURCE_COMMIT.txt')).Trim()
    if ($packedCommit -ne $tag) { throw 'Package source commit differs from release tag' }
    $zip = Join-Path $PSScriptRoot 'web-fishing-game-win64.zip'
    $sum = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected = ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web-fishing-game-win64/SHA256SUMS.txt')) -split '\s+')[0]
    if ($sum -ne $expected) { throw 'Package checksum mismatch' }
    $assets = @(
        @{ Name = 'web-fishing-game-win64.zip'; Path = $zip },
        @{ Name = 'SHA256SUMS.txt'; Path = (Join-Path $PSScriptRoot 'web-fishing-game-win64/SHA256SUMS.txt') }
    )
}
if ($ValidateOnly) {
    Write-Host "Validated $Version ($($tag.Trim())); no release was published."
    return
}
if (-not $Token) { $Token = $env:GITHUB_TOKEN }
if (-not $Token -and $uri -and $uri.UserInfo) {
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
function Assert-RemoteTag {
    $ref = Invoke-RestMethod -Uri "$api/git/ref/tags/$Version" -Headers $headers
    $object = $ref.object
    for ($depth = 0; $depth -lt 5 -and $object.type -eq 'tag'; $depth++) {
        if ($object.sha -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid remote tag object' }
        $peeled = Invoke-RestMethod -Uri "$api/git/tags/$($object.sha)" -Headers $headers
        $object = $peeled.object
    }
    if ($object.type -ne 'commit' -or $object.sha -cne $tag.Trim()) { throw 'Remote release tag moved; refuse to publish stale artifacts' }
}
Assert-RemoteTag
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
        foreach ($assetSpec in $assets) {
            $assetName = $assetSpec.Name
            foreach ($old in @($release.assets | Where-Object { $_.name -eq $assetName })) {
                Invoke-RestMethod -Method Delete -Uri "$api/releases/assets/$($old.id)" -Headers $headers | Out-Null
            }
            $file = $assetSpec.Path
            $upload = ($release.upload_url -replace '\{.*$', '') + '?name=' + [Uri]::EscapeDataString($assetName)
            $asset = Invoke-RestMethod -Method Post -Uri $upload -Headers $headers -ContentType 'application/octet-stream' -InFile $file
            if ($asset.state -ne 'uploaded' -or $asset.size -ne (Get-Item -LiteralPath $file).Length) { throw 'Uploaded asset size mismatch' }
            if ($asset.digest) {
                $localDigest = 'sha256:' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($asset.digest -ne $localDigest) { throw 'Uploaded asset digest mismatch' }
            }
        }
    }
    Assert-RemoteTag
    $release = JsonRequest PATCH "$api/releases/$($release.id)" @{name=$name; body=$notes; draft=$false; prerelease=$false; make_latest='true'}
}
Write-Host "Published $($release.html_url)"
