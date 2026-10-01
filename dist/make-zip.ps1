param([switch]$LocalBuild)
$ver = 'v0.21.5'
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $PSScriptRoot 'web-fishing-game-win64'
$zip = Join-Path $PSScriptRoot 'web-fishing-game-win64.zip'
$checksum = Join-Path $PSScriptRoot 'web-fishing-game-win64.zip.sha256'
Set-Location -LiteralPath $root
$versionMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $root 'frontend/js/data.js')), "const VERSION = '([^']+)'")
if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne $ver) { throw 'Package version does not match data.js' }
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { throw 'Go toolchain is required to build the release server.' }
$commit = & git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source commit' }
$branch = & git branch --show-current
$dirty = @(& git status --porcelain).Count -gt 0
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect source state' }
if ($dirty -and -not $LocalBuild) { throw 'Uncommitted sources require -LocalBuild; no output was replaced.' }
# Include new, non-ignored files for a local build; never depend on git add.
$files = @(& git -c core.quotepath=false ls-files --cached --others --exclude-standard) | Sort-Object -Unique
if ($LASTEXITCODE -ne 0) { throw 'Cannot list package sources' }
$packageFiles = @($files | Where-Object {
    ($_ -match '^frontend/.+\.(html|js|css|json|png|svg|jpe?g|webp|ico|woff2?|ttf|ogg|mp3|webmanifest|txt)$' -or
     $_ -match '^(tools/(update\.ps1|start-go\.ps1|start-https\.ps1)|run\.bat|update\.bat|Start-Game-HTTPS\.bat|config\.env\.example|README\.md|GUIDE\.md|VERSIONS\.md|server-go/README\.md)$') -and
    (Test-Path -LiteralPath (Join-Path $root $_) -PathType Leaf)
})
# Keep just the latest staging tree and zip. Replacement is recoverable.
Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($target in @($stage,$zip,$checksum)) {
    $full = [IO.Path]::GetFullPath($target)
    if ((Split-Path $full -Parent) -ne [IO.Path]::GetFullPath($PSScriptRoot)) { throw 'Unsafe package replacement path' }
    if (Test-Path -LiteralPath $full) {
        $item=Get-Item -LiteralPath $full
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked package output' }
        if ($item.PSIsContainer) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($full,'OnlyErrorDialogs','SendToRecycleBin','ThrowException')
        } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($full,'OnlyErrorDialogs','SendToRecycleBin','ThrowException')
        }
    }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($file in $packageFiles) {
    $source = Join-Path $root $file
    $target = Join-Path $stage $file
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
# This reusable recipe always produces Windows x64, regardless of the caller's environment.
$oldGOOS=$env:GOOS; $oldGOARCH=$env:GOARCH; $oldCGO=$env:CGO_ENABLED
try {
    $env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
    foreach ($entry in @(@('game','game.exe'),@('migrate','migrate.exe'),@('catalog','catalog.exe'),@('admin','admin.exe'))) {
        $target=Join-Path $stage $entry[1]
        & $go '-C' (Join-Path $root 'server-go') 'build' '-trimpath' '-o' $target ('./cmd/'+$entry[0])
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) { throw ('Go build failed for '+$entry[0]) }
    }
} finally { $env:GOOS=$oldGOOS; $env:GOARCH=$oldGOARCH; $env:CGO_ENABLED=$oldCGO }
New-Item -ItemType Directory -Path (Join-Path $stage 'licenses') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'server-go/THIRD_PARTY_NOTICES.md') -Destination (Join-Path $stage 'licenses/THIRD_PARTY_NOTICES.md')
$goRoot = & $go env GOROOT
if ($LASTEXITCODE -ne 0) { throw 'Cannot determine Go license path' }
Copy-Item -LiteralPath (Join-Path $goRoot 'LICENSE') -Destination (Join-Path $stage 'licenses/GO_LICENSE.txt')
$utf8=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $stage 'SOURCE_COMMIT.txt'), "$commit`n",$utf8)
$sourceLines=@($files | Where-Object {$_ -match '^(frontend/|server-go/)' -and (Test-Path -LiteralPath (Join-Path $root $_) -PathType Leaf)} | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $root $_) -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$_ })
$hasher=[Security.Cryptography.SHA256]::Create()
try { $sourceDigest=([BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes(($sourceLines -join "`n"))))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
$info=[ordered]@{version=$ver;localBuild=[bool]$LocalBuild;published=$false;baseCommit=$commit;branch=$branch;worktreeDirty=$dirty;sourceSha256=$sourceDigest;builtAtUtc=[DateTime]::UtcNow.ToString('o');platform='windows/amd64';goVersion=(& $go version);sourceFileCount=$sourceLines.Count}
[IO.File]::WriteAllText((Join-Path $stage 'BUILD_INFO.json'),($info | ConvertTo-Json -Depth 4),$utf8)
if ($LocalBuild) {
    $implementation=Join-Path $root 'docs/远航本地实现说明.md'
    if (-not (Test-Path -LiteralPath $implementation)) { throw 'Local implementation notes are required' }
    New-Item -ItemType Directory -Path (Join-Path $stage 'docs') -Force | Out-Null
    Copy-Item -LiteralPath $implementation -Destination (Join-Path $stage 'docs/远航本地实现说明.md')
    $notes=@"
# $ver · 远航与装备重做 / 本地测试构建

本包包含当前工作区的未提交功能，不是已发布的 GitHub Release。版本号保持 $ver。

- 五条远航航线、2 / 8 / 12 小时派遣、船成长、首通自选与印记兑换。
- 九种专属催化剂、七个装备位置、24 个普通底材、七套可用套装。
- 第八套商路观测保留预告；本次海王航线为单人版。
- 游戏后端为 Go，包含 game.exe、migrate.exe、catalog.exe、admin.exe，不附带 Node 或 Go 开发工具链。
- 运行需另行安装并配置 PostgreSQL；仅用于独立本地测试数据库，不是旧玩家存档的直接升级包。

完整规则、测试结果和兼容边界见 docs/远航本地实现说明.md。
SOURCE_COMMIT.txt 只记录基线提交；本地工作区状态及源码摘要见 BUILD_INFO.json。
"@
    [IO.File]::WriteAllText((Join-Path $stage 'RELEASE_NOTES.md'),$notes,$utf8)
} else {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "notes-$ver.md") -Destination (Join-Path $stage 'RELEASE_NOTES.md')
}
$instructions=@"
钓鱼游戏 $ver — Windows x64

$(if($LocalBuild){'这是未发布的本地测试构建，含工作区新增功能。请使用独立测试数据库。'})

1. 本包包含 Go 游戏程序和浏览器前端；需要另行准备 PostgreSQL。
2. 新数据库先在 PowerShell 中设置迁移连接串，然后运行：
   `$env:FISHING_GO_MIGRATION_DATABASE_URL = 'postgres://schema_owner:REPLACE_ME@127.0.0.1:5432/fishing_dev?sslmode=disable'
   .\migrate.exe up
   .\catalog.exe defaults
   这两个程序直接读取环境变量，不会自动读取 config.env。
3. 为应用账号配置业务表访问权限；把 config.env.example 复制为 config.env，填写 FISHING_GO_DATABASE_URL。
   启动程序 run.bat 会读取 config.env；双击后访问 http://127.0.0.1:9000。
4. 管理员配置使用 admin.exe provision，详细前置条件见 server-go/README.md。
5. 已发布过规则快照的数据库不会因运行 catalog.exe defaults 自动切换新规则。
   本地测试包不执行旧玩家数据迁移、不推送、不发布、不自动连接现有服务器。
6. 文件完整性校验见 PACKAGE_FILES.json，ZIP 校验文件在压缩包旁边。

基线提交：$commit
本地工作区有未提交变更：$dirty
"@
[IO.File]::WriteAllText((Join-Path $stage '使用说明.txt'),$instructions,[Text.UTF8Encoding]::new($true))
$manifest=@(Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{path=$_.FullName.Substring($stage.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
[IO.File]::WriteAllText((Join-Path $stage 'PACKAGE_FILES.json'),(ConvertTo-Json -InputObject $manifest -Depth 4),$utf8)
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($checksum,"$hash  web-fishing-game-win64.zip`n",$utf8)
Write-Host "Built $ver for Windows x64; local=$LocalBuild; dirty=$dirty; base=$commit"
Write-Host "Files: $($manifest.Count); ZIP: $zip"
Write-Host "SHA256 $hash"
