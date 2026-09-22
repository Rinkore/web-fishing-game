$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist/release.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('fishing-release-test-' + [Guid]::NewGuid().ToString('N'))
$savedLocation = Get-Location
$savedRepo = $env:GITHUB_REPOSITORY
$savedToken = $env:GITHUB_TOKEN
$global:fishingReleaseTestState = @{ requests=@(); missingRelease=$false; badUpload=$false; remoteCommit=''; moveAfterUpload=$false }
$global:fishingReleaseTestState.missingRelease = $false
$global:fishingReleaseTestState.badUpload = $false
function Invoke-RestMethod {
    param($Method = 'GET', $Uri, $Headers, $ContentType, $Body, $InFile)
    $global:fishingReleaseTestState.requests += "$Method $Uri"
    if ($Uri -match '/git/ref/tags/') { return @{object=@{type='tag';sha=('a'*40)}} }
    if ($Uri -match '/git/tags/') { return @{object=@{type='commit';sha=$global:fishingReleaseTestState.remoteCommit}} }
    if ($Uri -match '/releases/tags/') {
        if ($global:fishingReleaseTestState.missingRelease) {
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Not Found', [System.Net.Http.HttpResponseMessage]::new(404))
        }
        return @{ id=12; upload_url='https://uploads.github.com/repos/example/game/releases/12/assets{?name,label}'; assets=@(@{id=99;name='linux-release.json'}); html_url='https://github.com/example/game/releases/tag/v1.2.3' }
    }
    if ($Method -eq 'Delete') { return }
    if ($InFile) {
        if ($global:fishingReleaseTestState.moveAfterUpload) { $global:fishingReleaseTestState.remoteCommit='0'*40 }
        $digest = (Get-FileHash -LiteralPath $InFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($global:fishingReleaseTestState.badUpload) { $digest = '0' * 64 }
        return @{ state='uploaded';size=(Get-Item -LiteralPath $InFile).Length;digest="sha256:$digest" }
    }
    $json = [Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json
    if ($json.name -cne 'v1.2.3 topic') { throw 'Unexpected release title' }
    if ($Method -eq 'POST' -and -not $json.draft) { throw 'New release must start as draft' }
    return @{ id=12;upload_url='https://uploads.github.com/repos/example/game/releases/12/assets{?name,label}';assets=@();html_url='https://github.com/example/game/releases/tag/v1.2.3' }
}
function Expect-Rejected([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action } catch { if ($_.Exception.Message -notlike "*$Message*") { throw }; $rejected=$true }
    if (-not $rejected) { throw "Expected rejection: $Message" }
}
try {
    New-Item -ItemType Directory -Path "$sandbox/dist", "$sandbox/bundle" -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination "$sandbox/dist/release.ps1"
    Set-Content -LiteralPath "$sandbox/dist/notes-v1.2.3.md" -Value "v1.2.3 topic`nRelease body." -Encoding utf8
    Set-Content -LiteralPath "$sandbox/bundle/web-fishing-game-linux-amd64.tar.gz" -Value 'synthetic package bytes' -Encoding utf8
    & git -C $sandbox init -q
    & git -C $sandbox -c user.name=Test -c user.email=test@example.invalid add dist
    & git -C $sandbox -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
    & git -C $sandbox tag v1.2.3
    & git -C $sandbox remote add origin git@github.com:example/game.git
    if ($LASTEXITCODE) { throw 'Git fixture failed' }
    $commit = (& git -C $sandbox rev-parse HEAD).Trim()
    $global:fishingReleaseTestState.remoteCommit=$commit
    $manifest = @{ version='v1.2.3';sourceCommit=$commit;asset='web-fishing-game-linux-amd64.tar.gz';sha256=(Get-FileHash "$sandbox/bundle/web-fishing-game-linux-amd64.tar.gz").Hash.ToLowerInvariant();migrationsSha256=('a'*64) }
    $manifestPath = "$sandbox/bundle/linux-release.json"
    function Write-Manifest { $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8 }
    Write-Manifest
    $env:GITHUB_REPOSITORY='example/game'
    $env:GITHUB_TOKEN='synthetic-test-token'
    & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath -ValidateOnly
    if ($global:fishingReleaseTestState.requests.Count) { throw 'ValidateOnly must not access GitHub' }
    $originalHash=$manifest.sha256
    $manifest.sha256='0'*64; Write-Manifest
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath } 'checksum mismatch'
    $manifest.sha256=$originalHash
    $manifest.sourceCommit='0'*40; Write-Manifest
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath } 'differs from release tag'
    $manifest.sourceCommit=$commit
    $manifest.asset='../other.tar.gz'; Write-Manifest
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath } 'Unsupported Linux asset'
    $manifest.asset='web-fishing-game-linux-amd64.tar.gz'; Write-Manifest
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath -SkipAsset } 'cannot be combined'
    $env:GITHUB_REPOSITORY='other/game'
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath } 'repository differs'
    $env:GITHUB_REPOSITORY='example/game'
    if ($global:fishingReleaseTestState.requests.Count) { throw 'Invalid artifacts must fail before publishing' }
    & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath
    $uploads=@($global:fishingReleaseTestState.requests | Where-Object { $_ -like '*uploads.github.com*' })
    if ($uploads.Count -ne 2 -or $uploads[0] -notlike '*tar.gz' -or $uploads[1] -notlike '*linux-release.json') { Write-Output ($global:fishingReleaseTestState.requests -join [Environment]::NewLine); throw 'Publish package before manifest' }
    if ($global:fishingReleaseTestState.requests[-1] -notlike 'PATCH */releases/12') { throw 'Release publication must be last' }
    $global:fishingReleaseTestState.requests=@(); $global:fishingReleaseTestState.missingRelease=$true
    & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath
    if (-not @($global:fishingReleaseTestState.requests | Where-Object { $_ -like 'POST */releases' }).Count) { throw 'Missing release must be created as draft' }
    $global:fishingReleaseTestState.requests=@(); $global:fishingReleaseTestState.badUpload=$true
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath } 'digest mismatch'
    if (@($global:fishingReleaseTestState.requests | Where-Object { $_ -like 'PATCH *' }).Count) { throw 'Corrupt upload must not publish a release' }
    $global:fishingReleaseTestState.badUpload=$false
    $global:fishingReleaseTestState.requests=@()
    $global:fishingReleaseTestState.remoteCommit='0'*40
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath } 'Remote release tag moved'
    if (@($global:fishingReleaseTestState.requests | Where-Object { $_ -match '^(POST|PATCH|Delete) ' }).Count) { throw 'Stale tag must fail before writes' }
    $global:fishingReleaseTestState.remoteCommit=$commit
    $global:fishingReleaseTestState.requests=@()
    $global:fishingReleaseTestState.moveAfterUpload=$true
    Expect-Rejected { & "$sandbox/dist/release.ps1" -Version v1.2.3 -LinuxManifest $manifestPath } 'Remote release tag moved'
    if (@($global:fishingReleaseTestState.requests | Where-Object { $_ -like 'PATCH *' }).Count) { throw 'Tag moving during upload must prevent publication' }
    Write-Output 'Release publishing checks passed: validation, SSH remote, artifact rejection, draft creation, upload ordering, upload digest failure and tag races.'
} finally {
    Remove-Variable fishingReleaseTestState -Scope Global -ErrorAction SilentlyContinue
    Set-Location $savedLocation
    $env:GITHUB_REPOSITORY=$savedRepo
    $env:GITHUB_TOKEN=$savedToken
    $resolved=[IO.Path]::GetFullPath($sandbox)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) -and (Split-Path $resolved -Leaf) -like 'fishing-release-test-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
