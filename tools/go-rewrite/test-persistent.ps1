[CmdletBinding()]
param(
  [ValidateRange(1, 5000)]
  [int]$Players = $(if ($env:FISHING_GO_ACCEPTANCE_PLAYERS) { [int]$env:FISHING_GO_ACCEPTANCE_PLAYERS } else { 100 }),
  [ValidateRange(5, 172800)]
  [int]$Seconds = $(if ($env:FISHING_GO_ACCEPTANCE_SECONDS) { [int]$env:FISHING_GO_ACCEPTANCE_SECONDS } else { 7200 }),
  [string]$RunId = '',
  [string]$OutputRoot = '',
  [ValidateSet('none', 'postgres-crash', 'go-crash', 'http-response-drop', 'commit-ack-loss', 'client-retry', 'worker-restart', 'reconnect')]
  [string]$FaultMode = 'postgres-crash',
  [ValidateRange(0, 172800)]
  [int]$FaultAtSeconds = 0,
  [string]$ServerBaseUrl = '',
  [string]$NodeExe = 'node',
  [ValidateRange(1, 60000)]
  [int]$SampleIntervalSeconds = 5,
  [switch]$KeepVolume,
  [switch]$NoCleanup,
  [switch]$Cleanup
)

# Durable, synthetic acceptance harness. Evidence and Docker resources are
# kept by default. -KeepVolume removes containers but keeps the named volume;
# -Cleanup removes only this run's containers, network, and named volume.
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$compose = Join-Path $repoRoot 'deploy\go-test\persistent.yml'
if (!(Test-Path -LiteralPath $compose)) { throw ('Compose file not found: ' + $compose) }
if ($Cleanup -and $NoCleanup) { throw '-Cleanup and -NoCleanup cannot be used together.' }
if ($FaultMode -eq 'none' -and $FaultAtSeconds -gt 0) { throw '-FaultAtSeconds requires a fault mode.' }
if ($FaultAtSeconds -eq 0 -and $FaultMode -ne 'none') { $FaultAtSeconds = [Math]::Max(1, [Math]::Floor($Seconds / 2)) }
if ($FaultAtSeconds -ge $Seconds -and $FaultMode -ne 'none') { throw 'FaultAtSeconds must be earlier than Seconds.' }
$delegatedFaultModes = @('http-response-drop', 'commit-ack-loss', 'client-retry', 'worker-restart', 'reconnect')
# Delegated modes are valid only when the HTTP/worker harness writes a durable
# fault-result.json in /evidence with mode, injectedAt, and commitOutcome.
if ($delegatedFaultModes -contains $FaultMode -and !$ServerBaseUrl) { throw ('Fault mode ' + $FaultMode + ' requires -ServerBaseUrl and a harness that records fault-result.json.') }

$project = 'fishing-acceptance-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
if (!$RunId) { $RunId = 'resilience-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) }
if ($RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') { throw 'RunId must contain only ASCII letters, digits, dot, underscore, or hyphen.' }
if (!$OutputRoot) { $OutputRoot = Join-Path $repoRoot 'output\go-rewrite\resilience' }
if (![IO.Path]::IsPathRooted($OutputRoot)) { $OutputRoot = Join-Path $repoRoot $OutputRoot }
$evidence = [IO.Path]::GetFullPath((Join-Path $OutputRoot $RunId))
[void](New-Item -ItemType Directory -Path $evidence -Force)
$composeOutput = $evidence.Replace('\', '/')
$acceptanceContainer = $project + '-acceptance'
$postgresContainer = $project + '-postgres-1'
$gameContainer = $project + '-game-1'
$metadataPath = Join-Path $evidence 'run.json'
$eventsPath = Join-Path $evidence 'events.jsonl'
$samplesPath = Join-Path $evidence 'resource-samples.jsonl'
$acceptanceLog = Join-Path $evidence 'acceptance.log'
$acceptanceInspect = Join-Path $evidence 'acceptance-inspect.json'
$postgresInspect = Join-Path $evidence 'postgres-inspect.json'
$composeConfig = Join-Path $evidence 'compose-config.json'
$faultLog = Join-Path $evidence 'fault.log'
$faultCommandLog = Join-Path $evidence 'fault-command.log'
$faultResult = Join-Path $evidence 'fault-result.json'
$postgresLog = Join-Path $evidence 'postgres.log'
$volumeInspect = Join-Path $evidence 'volume-inspect.json'
$failurePath = Join-Path $evidence 'failure.txt'
$cleanupLog = Join-Path $evidence 'cleanup.log'
$environmentNames = @(
  'TZ', 'PGTZ', 'FISHING_GO_ACCEPTANCE_PHASE', 'FISHING_GO_ACCEPTANCE_PLAYERS',
  'FISHING_GO_ACCEPTANCE_SECONDS', 'FISHING_GO_ACCEPTANCE_RUN_ID',
  'FISHING_GO_ACCEPTANCE_OUTPUT_DIR', 'FISHING_GO_ACCEPTANCE_OUTPUT_ROOT',
  'FISHING_GO_ACCEPTANCE_REPORT',
  'FISHING_GO_ACCEPTANCE_FAULT_MODE', 'FISHING_GO_ACCEPTANCE_FAULT_AT_SECONDS',
  'FISHING_GO_ACCEPTANCE_BASE_URL', 'FISHING_GO_ACCEPTANCE_SERVER_BASE_URL', 'FISHING_GO_ACCEPTANCE_SAMPLE_INTERVAL_SECONDS',
  'FISHING_GO_ACCEPTANCE_LOAD_COMPLETE_FILE', 'FISHING_GO_ACCEPTANCE_QUIESCE_FILE', 'FISHING_GO_ACCEPTANCE_CANDIDATE_SHA'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

$metadata = [ordered]@{
  format = 2
  runId = $RunId
  project = $project
  repository = $repoRoot
  candidateSha = $null
  dirty = $null
  startedAt = [DateTime]::UtcNow.ToString('o')
  completedAt = $null
  result = 'not-completed'
  players = $Players
  secondsRequested = $Seconds
  faultMode = $FaultMode
  faultAtSeconds = $FaultAtSeconds
  faultResult = $null
  progress = [ordered]@{ phase = 'setup'; elapsedSeconds = 0; containerState = $null; faultInjected = $false; lastSampleAt = $null }
  serverBaseUrl = if ($ServerBaseUrl) { $ServerBaseUrl } else { $null }
  timezone = 'Asia/Shanghai'
  host = [ordered]@{ computer = $env:COMPUTERNAME; os = $null; cpu = $null; memoryBytes = $null; powershell = $PSVersionTable.PSVersion.ToString() }
  toolchain = [ordered]@{ node = $null; go = $null }
  images = $null
  database = [ordered]@{ container = $postgresContainer; endpoint = $null; volume = $null; version = $null; settings = $null }
  evidence = [ordered]@{ directory = $evidence; acceptanceLog = $acceptanceLog; events = $eventsPath; samples = $samplesPath; faultLog = $faultLog; faultCommandLog = $faultCommandLog; faultResult = $faultResult }
  exitCodes = [ordered]@{ startup = $null; workload = $null; verify = $null; cleanup = $null }
  cleanup = [ordered]@{ requested = [bool]$Cleanup; keepVolume = [bool]$KeepVolume; noCleanup = [bool]$NoCleanup; performed = $false }
}

function Save-Metadata {
  $metadata | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}

function Write-Event([string]$Kind, [hashtable]$Data = @{}) {
  $event = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); kind = $Kind; runId = $RunId }
  foreach ($key in $Data.Keys) { $event[$key] = $Data[$key] }
  ($event | ConvertTo-Json -Compress -Depth 8) | Add-Content -LiteralPath $eventsPath -Encoding UTF8
}

function Invoke-LoggedCommand([string]$Executable, [string[]]$Arguments, [string]$LogPath) {
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $Executable @Arguments 2>&1)
    $exit = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    $output | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $LogPath -Encoding UTF8
    return $exit
  } finally { $ErrorActionPreference = $old }
}

function Invoke-Capture([string]$Executable, [string[]]$Arguments) {
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $Executable @Arguments 2>&1)
    $exit = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    return [pscustomobject]@{ ExitCode = $exit; Output = ($output | ForEach-Object { $_.ToString() }) }
  } finally { $ErrorActionPreference = $old }
}

function Write-HostSnapshot {
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $metadata.host.os = $os.Caption
    $metadata.host.cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    $metadata.host.memoryBytes = [int64]$cs.TotalPhysicalMemory
    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [ordered]@{ name = $_.DeviceID; sizeBytes = [int64]$_.Size; freeBytes = [int64]$_.FreeSpace } })
    [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); os = $os.Caption; cpu = $metadata.host.cpu; memoryBytes = $metadata.host.memoryBytes; freeMemoryBytes = [int64]$os.FreePhysicalMemory * 1KB; disks = $disks } | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath $samplesPath -Encoding UTF8
  } catch { Write-Event 'host-sample-error' @{ message = $_.Exception.Message } }
}

function Write-ContainerSnapshot {
  $r = Invoke-Capture 'docker' @('stats', '--no-stream', '--format', '{{json .}}', $postgresContainer, $gameContainer, $acceptanceContainer)
  if ($r.ExitCode -eq 0) {
    foreach ($line in $r.Output) {
      if ($line.Trim()) { [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); kind = 'container'; data = $line | ConvertFrom-Json } | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath $samplesPath -Encoding UTF8 }
    }
  } else { Write-Event 'container-sample-error' @{ message = ($r.Output -join ' ') } }
}

function Write-DatabaseSnapshot {
  $query = "SELECT json_build_object('at', clock_timestamp(), 'databaseBytes', pg_database_size(current_database()), 'walLsn', pg_current_wal_lsn()::text, 'commits', xact_commit, 'rollbacks', xact_rollback, 'activeConnections', (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()), 'lockWaits', (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')) FROM pg_stat_database WHERE datname=current_database();"
  $r = Invoke-Capture 'docker' @('compose', '-p', $project, '-f', $compose, 'exec', '-T', 'postgres', 'psql', '-U', 'fishing_test_admin', '-d', 'fishing_acceptance', '-Atc', $query)
  if ($r.ExitCode -eq 0) { foreach ($line in $r.Output) { if ($line.Trim()) { [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); kind = 'database'; data = ($line | ConvertFrom-Json) } | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath $samplesPath -Encoding UTF8 } } }
  else { Write-Event 'database-sample-error' @{ message = ($r.Output -join ' ') } }
}

function Save-ContainerEvidence {
  $a = Invoke-Capture 'docker' @('inspect', $acceptanceContainer)
  if ($a.Output) { $a.Output | Set-Content -LiteralPath $acceptanceInspect -Encoding UTF8 }
  $p = Invoke-Capture 'docker' @('inspect', $postgresContainer)
  if ($p.Output) { $p.Output | Set-Content -LiteralPath $postgresInspect -Encoding UTF8 }
  $g = Invoke-Capture 'docker' @('inspect', $gameContainer)
  if ($g.Output) { $g.Output | Set-Content -LiteralPath (Join-Path $evidence 'game-inspect.json') -Encoding UTF8 }
  $logs = Invoke-Capture 'docker' @('logs', $acceptanceContainer)
  $logs.Output | Set-Content -LiteralPath $acceptanceLog -Encoding UTF8
  $dbLogs = Invoke-Capture 'docker' @('logs', $postgresContainer)
  $dbLogs.Output | Set-Content -LiteralPath $postgresLog -Encoding UTF8
  $gameLogs = Invoke-Capture 'docker' @('logs', $gameContainer)
  $gameLogs.Output | Set-Content -LiteralPath (Join-Path $evidence 'game.log') -Encoding UTF8
  if ($FaultMode -ne 'none') {
    $faultEvents = Invoke-Capture 'docker' @('events', '--since', $metadata.startedAt, '--until', ([DateTime]::UtcNow.ToString('o')), '--filter', ('label=com.docker.compose.project=' + $project))
    $faultEvents.Output | Set-Content -LiteralPath $faultLog -Encoding UTF8
  }
}

function Get-ContainerState([string]$Name) {
  $r = Invoke-Capture 'docker' @('inspect', '--format', '{{.State.Status}}', $Name)
  if ($r.ExitCode -ne 0) { return 'missing' }
  return ($r.Output -join '').Trim()
}

$runExit = 1
$started = $false
$faultInjected = $false
try {
  [void](Get-Command docker -ErrorAction Stop)
  [void](Get-Command git -ErrorAction Stop)
  [void](Get-Command $NodeExe -ErrorAction Stop)
  $sha = Invoke-Capture 'git' @('-C', $repoRoot, 'rev-parse', 'HEAD')
  if ($sha.ExitCode -ne 0) { throw 'Cannot identify candidate SHA.' }
  $metadata.candidateSha = ($sha.Output -join '').Trim()
  $env:FISHING_GO_ACCEPTANCE_CANDIDATE_SHA = $metadata.candidateSha
  $status = Invoke-Capture 'git' @('-C', $repoRoot, 'status', '--porcelain')
  if ($status.ExitCode -ne 0) { throw 'Cannot identify working tree state.' }
  $metadata.dirty = [bool]($status.Output | Where-Object { $_.Trim() })
  $nodeVersion = Invoke-Capture $NodeExe @('--version')
  if ($nodeVersion.ExitCode -ne 0) { throw 'Cannot identify the Node toolchain.' }
  $metadata.toolchain.node = ($nodeVersion.Output -join ' ').Trim()
  $metadata.toolchain.node | Set-Content -LiteralPath (Join-Path $evidence 'node-version.log') -Encoding ASCII
  $env:TZ = 'Asia/Shanghai'
  $env:PGTZ = 'Asia/Shanghai'
  $env:FISHING_GO_ACCEPTANCE_PLAYERS = [string]$Players
  $env:FISHING_GO_ACCEPTANCE_SECONDS = [string]$Seconds
  $env:FISHING_GO_ACCEPTANCE_PHASE = 'run'
  $env:FISHING_GO_ACCEPTANCE_RUN_ID = $RunId
  $env:FISHING_GO_ACCEPTANCE_OUTPUT_DIR = '/evidence'
  $env:FISHING_GO_ACCEPTANCE_REPORT = '/evidence/acceptance-run.json'
  $env:FISHING_GO_ACCEPTANCE_FAULT_MODE = $FaultMode
  $env:FISHING_GO_ACCEPTANCE_FAULT_AT_SECONDS = [string]$FaultAtSeconds
  $env:FISHING_GO_ACCEPTANCE_BASE_URL = if ($ServerBaseUrl) { $ServerBaseUrl } else { 'http://game:19001' }
  $env:FISHING_GO_ACCEPTANCE_SERVER_BASE_URL = $ServerBaseUrl
  $env:FISHING_GO_ACCEPTANCE_SAMPLE_INTERVAL_SECONDS = [string]$SampleIntervalSeconds
  $env:FISHING_GO_ACCEPTANCE_OUTPUT_ROOT = $composeOutput
  $quiesceBarrier = $FaultMode -in @('postgres-crash', 'go-crash')
  $loadCompletePath = Join-Path $evidence 'load-complete.json'
  $quiescePath = Join-Path $evidence 'game-quiesced'
  $env:FISHING_GO_ACCEPTANCE_LOAD_COMPLETE_FILE = if ($quiesceBarrier) { '/evidence/load-complete.json' } else { '' }
  $env:FISHING_GO_ACCEPTANCE_QUIESCE_FILE = if ($quiesceBarrier) { '/evidence/game-quiesced' } else { '' }
  Save-Metadata
  Write-HostSnapshot
  Write-Event 'run-start' @{ players = $Players; seconds = $Seconds; faultMode = $FaultMode; faultAtSeconds = $FaultAtSeconds }

  $configExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'config', '--format', 'json') $composeConfig
  if ($configExit -ne 0) { throw 'Cannot render isolated compose configuration.' }
  # Mark the project as owned before startup so a partial/failed --wait still
  # captures logs and honors -Cleanup for resources created by this run.
  $started = $true
  $startupExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'game') (Join-Path $evidence 'postgres-startup.log')
  $metadata.exitCodes.startup = $startupExit
  if ($startupExit -ne 0) { throw 'Persistent acceptance PostgreSQL failed to start.' }
  Write-Event 'postgres-ready' @{ container = $postgresContainer }
  $port = Invoke-Capture 'docker' @('compose', '-p', $project, '-f', $compose, 'port', 'postgres', '5432')
  $metadata.database.endpoint = ($port.Output -join '').Trim()
  $version = Invoke-Capture 'docker' @('compose', '-p', $project, '-f', $compose, 'exec', '-T', 'postgres', 'psql', '-U', 'fishing_test_admin', '-d', 'fishing_acceptance', '-Atc', 'SHOW server_version; SHOW timezone; SHOW fsync; SHOW full_page_writes; SHOW synchronous_commit;')
  $metadata.database.version = $version.Output
  if ($version.Output.Count -ge 5) {
    $metadata.database.settings = [ordered]@{ timezone = $version.Output[1]; fsync = $version.Output[2]; fullPageWrites = $version.Output[3]; synchronousCommit = $version.Output[4] }
  }
  $volumeNames = @(Invoke-Capture 'docker' @('volume', 'ls', '--filter', ('label=com.docker.compose.project=' + $project), '--format', '{{.Name}}')).Output | Where-Object { $_.Trim() }
  if ($volumeNames.Count -gt 0) {
    $metadata.database.volume = $volumeNames[0].Trim()
    $vi = Invoke-Capture 'docker' @('volume', 'inspect', $volumeNames[0].Trim())
    if ($vi.Output) { $vi.Output | Set-Content -LiteralPath $volumeInspect -Encoding UTF8 }
  }
  $goVersion = Invoke-Capture 'docker' @('compose', '-p', $project, '-f', $compose, '--profile', 'acceptance', 'run', '--rm', '--no-deps', 'acceptance', 'go', 'version')
  if ($goVersion.ExitCode -ne 0) { throw 'Cannot identify the Go toolchain image.' }
  $metadata.toolchain.go = ($goVersion.Output -join ' ').Trim()
  $metadata.toolchain.go | Set-Content -LiteralPath (Join-Path $evidence 'go-version.log') -Encoding ASCII
  $metadata.images = (Invoke-Capture 'docker' @('compose', '-p', $project, '-f', $compose, 'images', '--format', 'json')).Output
  Save-Metadata

  $workload = Invoke-Capture 'docker' @('compose', '-p', $project, '-f', $compose, '--profile', 'acceptance', 'run', '--no-deps', '-d', '--name', $acceptanceContainer, 'acceptance')
  if ($workload.ExitCode -ne 0) { throw ('Could not start acceptance workload: ' + ($workload.Output -join ' ')) }
  Write-Event 'workload-start' @{ container = $acceptanceContainer; containerId = ($workload.Output -join '').Trim() }
  $startedAt = [DateTime]::UtcNow
  $nextSample = $startedAt
  $quiesceApplied = $false
  while ($true) {
    $now = [DateTime]::UtcNow
    $state = Get-ContainerState $acceptanceContainer
    if ($quiesceBarrier -and !$quiesceApplied -and (Test-Path -LiteralPath $loadCompletePath)) {
      $quiesceApplied = $true
      Write-Event 'load-complete-barrier' @{ marker = $loadCompletePath }
      $stopGame = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'stop', 'game') (Join-Path $evidence 'game-stop-before-checkpoint.log')
      if ($stopGame -ne 0) { throw 'Could not quiesce Go game before checkpoint.' }
      New-Item -ItemType File -Path $quiescePath -Force | Out-Null
      Write-Event 'game-quiesced-before-checkpoint' @{ marker = $quiescePath }
    }
    if ($now -ge $nextSample) {
      Write-HostSnapshot; Write-ContainerSnapshot; Write-DatabaseSnapshot
      $metadata.progress.phase = 'run'
      $metadata.progress.elapsedSeconds = [Math]::Round(($now - $startedAt).TotalSeconds, 3)
      $metadata.progress.containerState = $state
      $metadata.progress.faultInjected = $faultInjected
      $metadata.progress.lastSampleAt = $now.ToString('o')
      Save-Metadata
      $nextSample = $now.AddSeconds($SampleIntervalSeconds)
    }
    if ($FaultMode -ne 'none' -and !$faultInjected -and (($now - $startedAt).TotalSeconds -ge $FaultAtSeconds)) {
      if ($state -notin @('running', 'created')) { throw ('Fault injection window was missed; workload state was ' + $state + '.') }
      $faultInjected = $true
      $metadata.progress.faultInjected = $true
      Write-Event 'fault-inject-begin' @{ mode = $FaultMode; elapsedSeconds = [Math]::Round(($now - $startedAt).TotalSeconds, 3) }
      switch ($FaultMode) {
        'postgres-crash' { $faultExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'kill', '-s', 'SIGKILL', 'postgres') $faultCommandLog }
        'go-crash' { $faultExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'kill', '-s', 'SIGKILL', 'game') $faultCommandLog }
        'worker-restart' { $faultExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'restart', 'game') $faultCommandLog }
        'http-response-drop' { $faultExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'kill', '-s', 'SIGKILL', 'game') $faultCommandLog }
        'commit-ack-loss' { $faultExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'kill', '-s', 'SIGKILL', 'game') $faultCommandLog }
        'client-retry' { $faultExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'kill', '-s', 'SIGKILL', 'game') $faultCommandLog }
        'reconnect' { $faultExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'kill', '-s', 'SIGKILL', 'game') $faultCommandLog }
        default { $faultExit = 1; ('mode=' + $FaultMode + '; unsupported fault mode') | Set-Content -LiteralPath $faultCommandLog -Encoding UTF8 }
      }
      Write-Event 'fault-inject-end' @{ mode = $FaultMode; exitCode = $faultExit }
      if ($faultExit -ne 0) { throw ('Fault injection failed for mode ' + $FaultMode) }
      if ($FaultMode -eq 'postgres-crash') {
        $restartExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'up', '-d', '--wait', '--wait-timeout', '120', 'postgres') (Join-Path $evidence 'postgres-restart.log')
        Write-Event 'postgres-restarted' @{ exitCode = $restartExit }
        if ($restartExit -ne 0) { throw 'PostgreSQL crash recovery failed.' }
      }
      if ($FaultMode -in @('go-crash', 'http-response-drop', 'commit-ack-loss', 'client-retry', 'reconnect')) {
        $restartExit = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'game') (Join-Path $evidence 'game-restart.log')
        Write-Event 'game-restarted' @{ mode = $FaultMode; exitCode = $restartExit }
        if ($restartExit -ne 0) { throw ('Go game restart failed for ' + $FaultMode) }
        $outcome = if ($FaultMode -in @('commit-ack-loss','http-response-drop')) { 'unknown' } else { 'connection-interrupted' }
        [ordered]@{ mode = $FaultMode; injectedAt = [DateTime]::UtcNow.ToString('o'); commitOutcome = $outcome; recovery = 'game-restarted'; note = 'SIGKILL during live HTTP/SSE load; outcome was not inferred from a success response.' } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $faultResult -Encoding UTF8
      }
    }
    if ($state -in @('exited', 'dead', 'missing')) { break }
    Start-Sleep -Milliseconds ([Math]::Min(1000, $SampleIntervalSeconds * 1000))
  }
  $inspectState = Invoke-Capture 'docker' @('inspect', '--format', '{{.State.ExitCode}}', $acceptanceContainer)
  $metadata.exitCodes.workload = if ($inspectState.ExitCode -eq 0) { [int]($inspectState.Output -join '').Trim() } else { 1 }
  Save-ContainerEvidence
  if ($delegatedFaultModes -contains $FaultMode) {
    if (!(Test-Path -LiteralPath $faultResult)) { throw ('Fault harness did not write fault-result.json for ' + $FaultMode + '; no fault pass is recorded.') }
    try { $faultEvidence = Get-Content -LiteralPath $faultResult -Raw | ConvertFrom-Json } catch { throw ('Invalid fault-result.json for ' + $FaultMode + '.') }
    if (!$faultEvidence.mode -or $faultEvidence.mode -ne $FaultMode -or !$faultEvidence.injectedAt -or !$faultEvidence.commitOutcome) { throw ('Incomplete fault-result.json for ' + $FaultMode + '; require mode, injectedAt, and commitOutcome.') }
    $metadata.faultResult = $faultEvidence
    Save-Metadata
  }
  if ($FaultMode -eq 'postgres-crash' -or $FaultMode -eq 'go-crash') {
    $stopGame = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, 'stop', 'game') (Join-Path $evidence 'game-stop-before-verify.log')
    if ($stopGame -ne 0) { throw 'Could not quiesce Go game before durability verification.' }
    $env:FISHING_GO_ACCEPTANCE_PHASE = 'verify'
    $verify = Invoke-LoggedCommand 'docker' @('compose', '-p', $project, '-f', $compose, '--profile', 'acceptance', 'run', '--no-deps', '--rm', 'acceptance') (Join-Path $evidence 'verify.log')
    $metadata.exitCodes.verify = $verify
    if ($verify -ne 0) { throw 'Post-fault durability verification failed.' }
  }
  if ($metadata.exitCodes.workload -ne 0 -and $FaultMode -eq 'none') { throw 'Acceptance workload failed.' }
  $metadata.result = 'passed'
  $runExit = 0
} catch {
  $metadata.result = 'failed'
  $_.Exception.Message | Set-Content -LiteralPath $failurePath -Encoding UTF8
  Write-Warning $_.Exception.Message
  if ($started) { Save-ContainerEvidence }
} finally {
  try {
    if ($started) { Save-ContainerEvidence }
    if ($started -and ($Cleanup -or $KeepVolume) -and !$NoCleanup) {
      $downArgs = @('compose', '-p', $project, '-f', $compose, 'down', '--remove-orphans')
      if ($Cleanup) { $downArgs += '--volumes' }
      $metadata.exitCodes.cleanup = Invoke-LoggedCommand 'docker' $downArgs $cleanupLog
      $metadata.cleanup.performed = $true
      if ($metadata.exitCodes.cleanup -ne 0) { $runExit = 1; $metadata.result = 'cleanup-failed' }
    } else {
      Write-Event 'resources-retained' @{ project = $project; reason = if ($NoCleanup) { 'no-cleanup' } elseif ($KeepVolume) { 'keep-volume' } else { 'default' } }
    }
  } catch {
    $runExit = 1
    $metadata.result = 'cleanup-failed'
    $_.Exception.Message | Add-Content -LiteralPath $cleanupLog -Encoding UTF8
  } finally {
    $metadata.completedAt = [DateTime]::UtcNow.ToString('o')
    Save-Metadata
    $runExit | Set-Content -LiteralPath (Join-Path $evidence 'run-exit.txt') -Encoding ASCII
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
  }
}
Write-Output ('Resilience acceptance ' + $metadata.result + '; project ' + $project + '; evidence: ' + $evidence)
if (!$metadata.cleanup.performed) { Write-Output ('Resources retained; review evidence before cleanup: ' + $evidence) }
exit $runExit
