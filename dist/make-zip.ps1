$ver = 'v0.21.0'
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $PSScriptRoot 'web-fishing-game-win64'
$zip = Join-Path $PSScriptRoot 'web-fishing-game-win64.zip'
$runtime = Join-Path $PSScriptRoot 'node-runtime\node.exe'
if (-not (Test-Path -LiteralPath $runtime)) { throw 'Missing dist/node-runtime/node.exe' }
Set-Location -LiteralPath $root
$version = & $runtime -p "require('./frontend/js/data.js').VERSION"
if ($version -ne $ver) { throw 'Package version does not match data.js' }
# Only the single current build directory may be replaced.
$resolvedStage = [IO.Path]::GetFullPath($stage)
if ($resolvedStage -ne [IO.Path]::GetFullPath((Join-Path $root 'dist\web-fishing-game-win64'))) { throw 'Unsafe staging path' }
if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$files = & git -c core.quotepath=false ls-files
if ($LASTEXITCODE -ne 0) { throw 'Cannot list package sources' }
foreach ($file in $files) {
    if ($file -notmatch '^(frontend/|backend/|tools/(update\.js|start-https\.ps1)$|run\.bat$|update\.bat$|Start-Game-HTTPS\.bat$|start-frontend\.bat$|package\.json$|README\.md$|GUIDE\.md$|VERSIONS\.md$|SECURITY\.md$)') { continue }
    $source = Join-Path $root $file
    $target = Join-Path $stage $file
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
New-Item -ItemType Directory -Path (Join-Path $stage 'node') -Force | Out-Null
Copy-Item -LiteralPath $runtime -Destination (Join-Path $stage 'node\node.exe')
$commit = & git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source commit' }
[IO.File]::WriteAllText((Join-Path $stage 'SOURCE_COMMIT.txt'), "$commit`n", [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "notes-$ver.md") -Destination (Join-Path $stage 'RELEASE_NOTES.md')
$instructions = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('6ZKT6bG8572R56uZIHtWRVJTSU9OfQ0KDQoxLiDor7flsIbmlbTkuKrljovnvKnljIXop6PljovliLDlj6/lhpnnm67lvZXvvIzkuI3opoHlnKjljovnvKnljIXlhoXnm7TmjqXov5DooYzjgIINCjIuIOWPjOWHuyBydW4uYmF0IOWQr+WKqO+8m+W3suWGhee9riBOb2RlLmpz77yM5peg6ZyA5Y+m6KGM5a6J6KOF44CCDQozLiDmtY/op4jlmajmiZPlvIAgaHR0cDovL2xvY2FsaG9zdDo5MDAw44CCDQo0LiDmm7TmlrDliY3lnKjml6fmnI3liqHmjqfliLblj7DovpPlhaUgce+8jOS/neWtmOW5tuWFs+mXre+8jOWGjeWQr+WKqOaWsOeJiOOAgg0KNS4g5a2Y5qGj5L2N5LqO55So5oi35paH5qGj55uu5b2VIHdlYi1maXNoaW5nLWdhbWXvvIzor7fkv53nlZnlpIfku73jgIINCjYuIFN0YXJ0LUdhbWUtSFRUUFMuYmF0IOS+m+W3sue7j+WuieijhSBIVFRQUyDku6PnkIbnmoTnlKjmiLfkvb/nlKjjgIINCg0K5rqQ56CB5o+Q5Lqk77yae0NPTU1JVH0NCg==')).Replace('{VERSION}', $ver).Replace('{COMMIT}', $commit)
$helpName = -join ([char[]](0x4f7f,0x7528,0x8bf4,0x660e))
[IO.File]::WriteAllText((Join-Path $stage ($helpName + '.txt')), $instructions, [Text.UTF8Encoding]::new($true))
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $stage 'SHA256SUMS.txt'), "$hash  web-fishing-game-win64.zip`n", [Text.UTF8Encoding]::new($false))
Write-Host "Built $ver ($commit)"
Write-Host "SHA256 $hash"
