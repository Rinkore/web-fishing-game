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

  $commit = (git rev-parse HEAD).Trim()
  if ($commit -notmatch '^[0-9a-f]{40}$') { throw "无法取得 40 位 Git commit：$commit" }
  $env:WIKI_TEST_SOURCE_COMMIT = $commit
  $env:WIKI_TEST_PORT = [string]$Port

  # 默认使用官方 node:22-alpine；本机已有替代 Node 镜像时允许自动复用，便于镜像源受限环境。
  if (-not $env:WIKI_TEST_NODE_IMAGE) {
    $localImages = @(docker image ls --format '{{.Repository}}:{{.Tag}}')
    if ($localImages -contains 'node:22-alpine') {
      $env:WIKI_TEST_NODE_IMAGE = 'node:22-alpine'
    } elseif ($localImages -contains 'web-fishing-node-runtime:local') {
      $env:WIKI_TEST_NODE_IMAGE = 'web-fishing-node-runtime:local'
      Write-Host '提示：未找到 node:22-alpine，已复用本机 web-fishing-node-runtime:local。'
    } else {
      $env:WIKI_TEST_NODE_IMAGE = 'node:22-alpine'
    }
  }

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
