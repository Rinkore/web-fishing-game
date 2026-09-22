<##
.SYNOPSIS
  Runs the synthetic snapshot and read-only import preflight.

.DESCRIPTION
  This rehearsal creates two isolated fixtures, scans both with the Go
  import-legacy command, and records the expected clean/blocked exit codes.
  It never accepts a database DSN, never reads a live data directory, and
  never writes a snapshot. The output is intentionally a preflight artifact;
  PostgreSQL import/reconciliation and cutover are separate stages.
#>
[CmdletBinding()]
param(
  [string]$OutputRoot = '',
  [string]$GoExe = 'go',
  [string]$SourceVersion = 'v0.21.4'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (!$OutputRoot) { $OutputRoot = Join-Path $repoRoot 'output\go-rewrite\migration-preflight' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$runId = 'preflight-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$runDir = Join-Path $OutputRoot $runId
[void](New-Item -ItemType Directory -Path $runDir -Force)
$generator = Join-Path $repoRoot 'tools\go-rewrite\migration-fixture.js'
$records = [System.Collections.Generic.List[object]]::new()

function Invoke-Logged([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$ExpectedExit) {
  $log = Join-Path $runDir ($Name + '.log')
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Executable @Arguments 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $log -Encoding UTF8
    $code = [int]$LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  if ($code -ne $ExpectedExit) { throw "$Name returned $code, expected $ExpectedExit; see $log" }
  $relative = $log.Substring($runDir.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  return [pscustomobject]@{ code = $code; log = $relative }
}

try {
  [void](Get-Command node -ErrorAction Stop)
  if ($GoExe -eq 'go' -and -not (Get-Command $GoExe -ErrorAction SilentlyContinue)) {
    $candidate = Join-Path $env:LOCALAPPDATA 'FishingGoToolchains\go1.27.1\go\bin\go.exe'
    if (Test-Path -LiteralPath $candidate) { $GoExe = $candidate }
  }
  [void](Get-Command $GoExe -ErrorAction Stop)
  foreach ($variant in @('valid', 'blocked')) {
    $snapshot = Join-Path $runDir ('snapshot-' + $variant)
    $fixture = Invoke-Logged ('fixture-' + $variant) 'node' @($generator, '--output', $snapshot, '--variant', $variant) 0
    $scanPath = Join-Path $runDir ($variant + '.scan.json')
    $expectedScanExit = if ($variant -eq 'valid') { 0 } else { 1 }
    Push-Location (Join-Path $repoRoot 'server-go')
    try {
      $scan = Invoke-Logged ('scan-' + $variant) $GoExe @('run', './cmd/import-legacy', '--snapshot', $snapshot, '--source-version', $SourceVersion, '--output', $scanPath) $expectedScanExit
    } finally { Pop-Location }
    $report = Get-Content -LiteralPath $scanPath -Raw | ConvertFrom-Json
    if ($variant -eq 'valid' -and $report.issues.Count -ne 0) { throw 'valid fixture unexpectedly has scanner findings' }
    if ($variant -eq 'blocked' -and $report.issues.Count -lt 2) { throw 'blocked fixture lost its expected findings' }
    $records.Add([pscustomobject]@{
      variant = $variant; fixture = $fixture.log; scan = $scan.log; scannerExit = $scan.code
      findings = [int]$report.issues.Count; importReady = [bool]$report.importReady
      importExecuted = $false
    })
  }
  $result = [ordered]@{
    format = 1; tool = 'migration-fixture-preflight'; runId = $runId; sourceVersion = $SourceVersion
    source = 'synthetic only'; database = 'not run'; cutover = 'not run'; records = $records
  }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'result.json') -Encoding UTF8
  # The blocked scan intentionally exits 1; do not leak that child status from
  # the successful preflight process.
  $global:LASTEXITCODE = 0
  Write-Output "Migration preflight passed; evidence: $runDir"
  exit 0
} catch {
  $result = [ordered]@{
    format = 1; tool = 'migration-fixture-preflight'; runId = $runId; sourceVersion = $SourceVersion
    source = 'synthetic only'; result = 'failed'; error = $_.Exception.Message; records = $records
  }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'result.json') -Encoding UTF8
  Write-Error $_.Exception.Message
  exit 1
}
