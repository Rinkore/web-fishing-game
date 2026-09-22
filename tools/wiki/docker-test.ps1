param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 19000,
  [switch]$Reset,
  [switch]$Follow,
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repoRoot
try {
  $composeArgs = @('-f', 'docker-compose.wiki-test.yml')

  if ($Reset) {
    docker compose @composeArgs down -v --remove-orphans
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Wiki Docker 测试环境已重置（数据卷已删除）。'
    return
  }

  $env:WIKI_TEST_PORT = [string]$Port

  $upArgs = @('up')
  if ($Follow) {
    $upArgs += '--build'
  } else {
    $upArgs += '-d'
    if (-not $NoBuild) { $upArgs += '--build' }
  }

  docker compose @composeArgs @upArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if (-not $Follow) {
    Write-Host ''
    Write-Host "Wiki 测试环境: http://127.0.0.1:$Port/wiki/"
    Write-Host "管理后台:     http://127.0.0.1:$Port/admin.html"
    Write-Host '停止但保留数据: npm run wiki:docker:down'
    Write-Host '彻底重置数据:   npm run wiki:docker:reset'
  }
} finally {
  Pop-Location
}
