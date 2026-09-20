param([string]$GoExe = 'go', [switch]$Linux)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$compose = Join-Path $repoRoot 'deploy\go-test\compose.yml'
$project = 'fishing-go-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$previousDsn = $env:FISHING_GO_TEST_DATABASE_URL
try {
  & docker compose -p $project -f $compose up -d --wait --wait-timeout 60 postgres
  if ($LASTEXITCODE -ne 0) { throw 'Isolated PostgreSQL startup failed' }
  if ($Linux) {
    & docker compose -p $project -f $compose --profile linux run --rm go-tests
    if ($LASTEXITCODE -ne 0) { throw 'Linux PostgreSQL integration/race tests failed' }
    return
  }
  $endpoint = (& docker compose -p $project -f $compose port postgres 5432).Trim()
  if ($LASTEXITCODE -ne 0 -or $endpoint -notmatch '^127\.0\.0\.1:\d+$') { throw 'Cannot resolve test database port' }
  $env:FISHING_GO_TEST_DATABASE_URL = 'postgres://fishing_test_admin:local-test-only@' + $endpoint + '/fishing_test?sslmode=disable'
  Push-Location (Join-Path $repoRoot 'server-go')
  try {
    & $GoExe test -count=1 -timeout=3m ./... 2>&1 | Select-Object -Last 40
    if ($LASTEXITCODE -ne 0) { throw 'Go PostgreSQL integration tests failed' }
  } finally { Pop-Location }
} finally {
  $env:FISHING_GO_TEST_DATABASE_URL = $previousDsn
  & docker compose -p $project -f $compose down --volumes --remove-orphans
  if ($LASTEXITCODE -ne 0) { Write-Warning ('Test container cleanup failed for ' + $project) }
}
