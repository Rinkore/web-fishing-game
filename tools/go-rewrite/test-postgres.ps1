param(
  [string]$GoExe = 'go',
  [switch]$Linux,
  [string]$Timeout = $(if ($env:FISHING_GO_TEST_TIMEOUT) { $env:FISHING_GO_TEST_TIMEOUT } else { '15m' }),
  [string]$LogRoot = '',
  [string]$NodeExe = 'node'
)
$ErrorActionPreference = 'Stop'
if ($Timeout -notmatch '^(?:\d+(?:\.\d+)?(?:ns|us|ms|s|m|h))+$' -or $Timeout -notmatch '[1-9]') { throw 'Timeout must be a positive Go duration, for example 15m.' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$compose = Join-Path $repoRoot 'deploy\go-test\compose.yml'
$project = 'fishing-go-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
if (!$LogRoot) { $LogRoot = Join-Path $repoRoot 'output\go-postgres' }
if (![IO.Path]::IsPathRooted($LogRoot)) { $LogRoot = Join-Path $repoRoot $LogRoot }
$logDirectory = [IO.Path]::GetFullPath((Join-Path $LogRoot $project))
[void](New-Item -ItemType Directory -Path $logDirectory)
$mode = if ($Linux) { 'linux' } else { 'windows' }
$testLog = Join-Path $logDirectory ($mode + '-tests.jsonl')
$testExitFile = Join-Path $logDirectory ($mode + '-test-exit.txt')
$summaryLog = Join-Path $logDirectory ($mode + '-summary.json')
$metadataFile = Join-Path $logDirectory 'run.json'
$previousEnvironment = @{}
foreach ($name in @('FISHING_GO_TEST_DATABASE_URL', 'FISHING_GO_TEST_TIMEOUT', 'FISHING_GO_TEST_LOG_DIR', 'TZ', 'FISHING_GO_TIMEZONE')) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$metadata = [ordered]@{
  format = 1; project = $project; mode = $mode; startedAt = [DateTime]::UtcNow.ToString('o')
  completedAt = $null; repository = $repoRoot; sourceCommit = $null; dirty = $null
  timeout = $Timeout; timezone = 'Asia/Shanghai'; endpoint = $null; database = 'fishing_test'
  toolchain = $null; node = $null; databaseVersion = $null; logDirectory = $logDirectory
  testsLog = $testLog; testExitFile = $testExitFile; summaryLog = $summaryLog
  testExit = $null; summaryExit = $null; cleanupExit = $null; result = 'not-completed'
}
function Save-RunMetadata { $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataFile -Encoding UTF8 }
function Invoke-LoggedCommand([string]$Executable, [string[]]$Arguments, [string]$Log) {
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = $null
    & $Executable @Arguments 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $Log -Encoding UTF8
    if ($null -eq $LASTEXITCODE) { return 1 }
    return [int]$LASTEXITCODE
  } finally { $ErrorActionPreference = $previousErrorAction }
}
$runExit = 1
$cleanupNeeded = $false
Save-RunMetadata
Write-Output ('Isolated PostgreSQL run: ' + $project + '; full logs: ' + $logDirectory)
try {
  [void](Get-Command docker -ErrorAction Stop)
  [void](Get-Command $NodeExe -ErrorAction Stop)
  $metadata.sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the source commit.' }
  $metadata.dirty = [bool](& git -C $repoRoot status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the working tree state.' }
  $nodeLog = Join-Path $logDirectory 'node-toolchain.log'
  if ((Invoke-LoggedCommand $NodeExe @('--version') $nodeLog) -ne 0) { throw 'Cannot identify the Node toolchain.' }
  $metadata.node = (Get-Content -LiteralPath $nodeLog -Raw).Trim()
  $env:TZ = 'Asia/Shanghai'
  $env:FISHING_GO_TIMEZONE = 'Asia/Shanghai'
  $env:FISHING_GO_TEST_TIMEOUT = $Timeout
  $env:FISHING_GO_TEST_LOG_DIR = $logDirectory.Replace('\', '/')
  $cleanupNeeded = $true
  $startupExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres') (Join-Path $logDirectory 'postgres-startup.log')
  if ($startupExit -ne 0) { throw 'Isolated PostgreSQL startup failed; see postgres-startup.log.' }
  $endpoint = (& docker compose -p $project -f $compose port postgres 5432).Trim()
  if ($LASTEXITCODE -ne 0 -or $endpoint -notmatch '^127\.0\.0\.1:\d+$') { throw 'Cannot resolve test database port.' }
  $metadata.endpoint = $endpoint
  $databaseLog = Join-Path $logDirectory 'postgres-version.log'
  if ((Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'exec', '-T', 'postgres', 'psql', '-U', 'fishing_test_admin', '-d', 'fishing_test', '-Atc', 'SHOW server_version; SHOW timezone;') $databaseLog) -ne 0) { throw 'Cannot identify the isolated PostgreSQL version and timezone.' }
  $metadata.databaseVersion = @(Get-Content -LiteralPath $databaseLog)
  Save-RunMetadata
  if ($Linux) {
    $composeExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, '--profile', 'linux', 'run', '--rm', 'go-tests') (Join-Path $logDirectory 'linux-compose.log')
    $composeExit | Set-Content -LiteralPath (Join-Path $logDirectory 'linux-compose-exit.txt') -Encoding ASCII
    if (Test-Path -LiteralPath (Join-Path $logDirectory 'linux-toolchain.log')) { $metadata.toolchain = (Get-Content -LiteralPath (Join-Path $logDirectory 'linux-toolchain.log') -Raw).Trim() }
    if (!(Test-Path -LiteralPath $testExitFile)) { throw 'Linux verification ended before go test completed; inspect linux-compose.log, linux-mod-verify.log and linux-vet.log.' }
    $metadata.testExit = [int](Get-Content -LiteralPath $testExitFile -Raw).Trim()
  } else {
    [void](Get-Command $GoExe -ErrorAction Stop)
    $toolchainLog = Join-Path $logDirectory 'windows-toolchain.log'
    if ((Invoke-LoggedCommand $GoExe @('version') $toolchainLog) -ne 0) { throw 'Cannot identify the Go toolchain.' }
    $metadata.toolchain = (Get-Content -LiteralPath $toolchainLog -Raw).Trim()
    $env:FISHING_GO_TEST_DATABASE_URL = 'postgres://fishing_test_admin:local-test-only@' + $endpoint + '/fishing_test?sslmode=disable'
    Push-Location (Join-Path $repoRoot 'server-go')
    try { $metadata.testExit = Invoke-LoggedCommand $GoExe @('test', '-json', '-count=1', ('-timeout=' + $Timeout), './...') $testLog }
    finally { Pop-Location }
    $metadata.testExit | Set-Content -LiteralPath $testExitFile -Encoding ASCII
  }
  if (!(Test-Path -LiteralPath $testLog)) { throw 'The complete Go JSON test log is missing.' }
  $metadata.summaryExit = Invoke-LoggedCommand $NodeExe @((Join-Path $PSScriptRoot 'summarize-go-tests.js'), $testLog) $summaryLog
  $metadata.summaryExit | Set-Content -LiteralPath (Join-Path $logDirectory ($mode + '-summary-exit.txt')) -Encoding ASCII
  Get-Content -LiteralPath $summaryLog
  if ($metadata.testExit -ne 0 -or $metadata.summaryExit -ne 0 -or ($Linux -and $composeExit -ne 0)) { throw 'Go PostgreSQL verification failed or was incomplete; see the complete logs and summary.' }
  $metadata.result = 'passed'
  $runExit = 0
} catch {
  $metadata.result = 'failed'
  $_.Exception.Message | Set-Content -LiteralPath (Join-Path $logDirectory 'failure.txt') -Encoding UTF8
  Write-Warning $_.Exception.Message
  foreach ($failureLog in @($testLog, (Join-Path $logDirectory 'linux-vet.log'), (Join-Path $logDirectory 'linux-mod-verify.log'), (Join-Path $logDirectory 'linux-compose.log'), (Join-Path $logDirectory 'postgres-startup.log'))) {
    if ((Test-Path -LiteralPath $failureLog) -and (Get-Item -LiteralPath $failureLog).Length -gt 0) {
      Write-Output ('Failure evidence: ' + $failureLog)
      Get-Content -LiteralPath $failureLog -Tail 40
      break
    }
  }
} finally {
  try {
    if ($cleanupNeeded) {
      $metadata.cleanupExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'down', '--volumes', '--remove-orphans') (Join-Path $logDirectory 'cleanup.log')
      if ($metadata.cleanupExit -ne 0) { $runExit = 1; $metadata.result = 'cleanup-failed'; Write-Warning ('Test container cleanup failed for ' + $project) }
    }
  } catch {
    $runExit = 1
    $metadata.result = 'cleanup-failed'
    Write-Warning ('Cleanup could not complete for ' + $project + '; see ' + $logDirectory)
  } finally {
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    $metadata.completedAt = [DateTime]::UtcNow.ToString('o')
    Save-RunMetadata
    $runExit | Set-Content -LiteralPath (Join-Path $logDirectory 'run-exit.txt') -Encoding ASCII
  }
}
Write-Output ('Verification ' + $metadata.result + '; exit ' + $runExit + '; evidence: ' + $logDirectory)
exit $runExit
