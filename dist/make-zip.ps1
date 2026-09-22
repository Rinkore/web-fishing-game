$ver = 'v0.21.4'
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $PSScriptRoot 'web-fishing-game-win64'
$zip = Join-Path $PSScriptRoot 'web-fishing-game-win64.zip'
Set-Location -LiteralPath $root
$dataSource = Get-Content -LiteralPath (Join-Path $root 'frontend\js\data.js') -Raw
$versionMatch = [regex]::Match($dataSource, "const VERSION = '([^']+)'")
if (-not $versionMatch.Success) { throw 'Cannot read frontend version' }
$version = $versionMatch.Groups[1].Value
if ($version -ne $ver) { throw 'Package version does not match data.js' }
# Only the single current build directory may be replaced.
$resolvedStage = [IO.Path]::GetFullPath($stage)
if ($resolvedStage -ne [IO.Path]::GetFullPath((Join-Path $root 'dist\web-fishing-game-win64'))) { throw 'Unsafe staging path' }
if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$files = & git -c core.quotepath=false ls-files
if ($LASTEXITCODE -ne 0) { throw 'Cannot list package sources' }
foreach ($file in $files) {
    if ($file -notmatch '^(frontend/|tools/(update\.ps1|start-go\.ps1|start-go\.js|start-https\.ps1)$|run\.bat$|update\.bat$|Start-Game-HTTPS\.bat$|start-frontend\.bat$|package\.json$|config\.env\.example$|README\.md$|GUIDE\.md$|VERSIONS\.md$|SECURITY\.md$)') { continue }
    $source = Join-Path $root $file
    $target = Join-Path $stage $file
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { throw 'Go toolchain is required to build the release server.' }
foreach ($entry in @(@('game', 'game.exe'), @('migrate', 'migrate.exe'), @('catalog', 'catalog.exe'), @('admin', 'admin.exe'))) {
    $target = Join-Path $stage $entry[1]
    & $go '-C' (Join-Path $root 'server-go') 'build' '-trimpath' '-o' $target ('./cmd/' + $entry[0])
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) { throw ('Go build failed for ' + $entry[0]) }
}
$commit = & git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source commit' }
[IO.File]::WriteAllText((Join-Path $stage 'SOURCE_COMMIT.txt'), "$commit`n", [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "notes-$ver.md") -Destination (Join-Path $stage 'RELEASE_NOTES.md')
$instructions = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('6ZKT6bG85ri45oiPIHtWRVJTSU9OfQ0KDQoxLiDpppbmrKHpg6jnvbLvvJrmioogY29uZmlnLmVudi5leGFtcGxlIOWkjeWItuS4uiBjb25maWcuZW5277yM5oyJ5o+Q56S65aGr5YaZIFBvc3RncmVTUUwg6L+e5o6l5Liy44CCDQoyLiDlu7rooajkuI7liJ3lp4vljJbmlbDmja7vvIjlj6rpnIDkuIDmrKHvvJttaWdyYXRlLmV4ZSAvIGNhdGFsb2cuZXhlIOS9v+eUqOWQjOS4gOi/nuaOpeS4su+8ie+8mg0KICAgbWlncmF0ZS5leGUgdXANCiAgIGNhdGFsb2cuZXhlIGRlZmF1bHRzDQozLiDlj4zlh7sgcnVuLmJhdCDlkK/liqggR28g5pyN5Yqh5ZKM5YmN56uv77yM6K6/6ZeuIGh0dHA6Ly9sb2NhbGhvc3Q6OTAwMOOAgg0KNC4gSFRUUFMg54mI5pys5L2/55SoIFN0YXJ0LUdhbWUtSFRUUFMuYmF077yM5bm25L+d5oyB5pys5py65Luj55CG6L+Q6KGM44CCDQo1LiDmm7TmlrDniYjmnKzlj4zlh7sgdXBkYXRlLmJhdOOAgg0KNi4g566h55CG5ZGY57uR5a6a55SoIGFkbWluLmV4ZSBwcm92aXNpb27vvIzpgJrov4fmoIflh4bovpPlhaXkvKDlhaXotKblj7fkuI4gVE9UUO+8jOatpemqpOingSBzZXJ2ZXItZ28vUkVBRE1FLm1k44CCDQo3LiBnYW1lLmV4ZSDmmK/llK/kuIDmuLjmiI/lkI7nq6/vvJtmcm9udGVuZC8g5Y+q5YyF5ZCr5rWP6KeI5Zmo5a6i5oi356uv77yM5pys5YyF5LiN5YaN5YyF5ZCrIE5vZGUg6L+Q6KGM5pe244CCDQoNCua6kOeggeaPkOS6pO+8mntDT01NSVR9DQo=')).Replace('{VERSION}', $ver).Replace('{COMMIT}', $commit)
$helpName = -join ([char[]](0x4f7f,0x7528,0x8bf4,0x660e))
[IO.File]::WriteAllText((Join-Path $stage ($helpName + '.txt')), $instructions, [Text.UTF8Encoding]::new($true))
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $stage 'SHA256SUMS.txt'), "$hash  web-fishing-game-win64.zip`n", [Text.UTF8Encoding]::new($false))
Write-Host "Built $ver ($commit)"
Write-Host "SHA256 $hash"
