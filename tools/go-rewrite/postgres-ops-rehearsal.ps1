<##
.SYNOPSIS
  Runs a synthetic PostgreSQL role, backup, WAL archive and PITR rehearsal.

.DESCRIPTION
  This is deliberately self-contained and never accepts a production DSN. It
  starts a fresh PostgreSQL container, applies the Go migrations through the
  migration role, transfers ownership to the schema owner, and grants the
  runtime role an explicit table allow-list. It then proves DDL and operator
  audit denials, takes a logical dump and a physical base backup, injects a
  database-process crash, and restores a point in time before a marker row.

  The output directory contains command logs and a redacted JSON result. Role
  passwords are random process-local values and are never written to files.
  The host/disk failure case is intentionally reported as untested; this run
  cannot prove zero loss for a single-host Docker volume.
##>
[CmdletBinding()]
param(
  [string]$OutputRoot = '',
  [string]$Image = 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650',
  [string]$GoExe = 'go',
  [string]$GoImage = 'golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195',
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (!$OutputRoot) { $OutputRoot = Join-Path $repoRoot 'output\go-rewrite\migration-ops' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$runId = 'ops-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$runDir = Join-Path $OutputRoot $runId
[void](New-Item -ItemType Directory -Path $runDir -Force)
$logIndex = 0
$records = [System.Collections.Generic.List[object]]::new()
$container = 'fishing-go-ops-' + $runId.Substring(4)
$volume = 'fishing-go-ops-data-' + $runId.Substring(4)
$archiveVolume = 'fishing-go-ops-archive-' + $runId.Substring(4)
$restoreContainer = $container + '-pitr'
$started = [DateTime]::UtcNow
$adminPassword = 'local-test-only'
$migrationPassword = [Convert]::ToHexString((1..24 | ForEach-Object { Get-Random -Maximum 256 })).ToLowerInvariant()
$runtimePassword = [Convert]::ToHexString((1..24 | ForEach-Object { Get-Random -Maximum 256 })).ToLowerInvariant()
$backupPassword = [Convert]::ToHexString((1..24 | ForEach-Object { Get-Random -Maximum 256 })).ToLowerInvariant()
$opsPassword = [Convert]::ToHexString((1..24 | ForEach-Object { Get-Random -Maximum 256 })).ToLowerInvariant()
$baseDir = Join-Path $runDir 'basebackup'
$archiveDir = Join-Path $runDir 'wal-archive'
$dumpPath = Join-Path $runDir 'logical.dump'
$resultPath = Join-Path $runDir 'result.json'

function Add-Record([string]$Name, [string]$Status, [hashtable]$Data = @{}) {
  $row = [ordered]@{ name = $Name; status = $Status; at = [DateTime]::UtcNow.ToString('o') }
  foreach ($key in $Data.Keys) { $row[$key] = $Data[$key] }
  $records.Add([pscustomobject]$row)
}

function Invoke-Logged([string]$Name, [string]$Executable, [string[]]$Arguments, [switch]$AllowFailure) {
  $script:logIndex++
  $log = Join-Path $runDir ('{0:D3}-{1}.log' -f $script:logIndex, $Name)
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Executable @Arguments 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $log -Encoding UTF8
    $code = [int]$LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  if (!$AllowFailure -and $code -ne 0) { throw "$Name failed (exit $code); see $log" }
  return [pscustomobject]@{ Code = $code; Log = $log }
}

function Invoke-ContainerSql([string]$Name, [string]$User, [string]$Password, [string]$Sql, [switch]$AllowFailure, [string]$TargetContainer = $container) {
  $script:logIndex++
  $sqlName = 'sql-{0:D3}.sql' -f $script:logIndex
  $sqlPath = Join-Path $runDir $sqlName
  $log = Join-Path $runDir ('{0:D3}-{1}.log' -f $script:logIndex, $Name)
  Set-Content -LiteralPath $sqlPath -Value $Sql -Encoding UTF8
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & docker cp $sqlPath ($TargetContainer + ':/tmp/' + $sqlName) 2>&1 | Set-Content -LiteralPath ($log + '.copy') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw "Cannot copy SQL for $Name" }
    & docker exec -e ('PGPASSWORD=' + $Password) $TargetContainer psql -h 127.0.0.1 -U $User -d fishing_test -At -v ON_ERROR_STOP=1 -f ('/tmp/' + $sqlName) 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $log -Encoding UTF8
    $code = [int]$LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  if (!$AllowFailure -and $code -ne 0) { throw "$Name failed (exit $code); see $log" }
  $text = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  return [pscustomobject]@{ Code = $code; Log = $log; Text = $text }
}

function Invoke-ContainerFile([string]$Name, [string]$User, [string]$Password, [string]$LocalPath) {
  $script:logIndex++
  $remote = '/tmp/' + [IO.Path]::GetFileName($LocalPath)
  $log = Join-Path $runDir ('{0:D3}-{1}.log' -f $script:logIndex, $Name)
  & docker cp $LocalPath ($container + ':' + $remote) 2>&1 | Set-Content -LiteralPath ($log + '.copy') -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw "Cannot copy $Name SQL" }
  & docker exec -e ('PGPASSWORD=' + $Password) $container psql -h 127.0.0.1 -U $User -d fishing_test -At -v ON_ERROR_STOP=1 -f $remote 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $log -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw "$Name failed; see $log" }
}

function Get-ContainerSql([string]$Name, [string]$User, [string]$Password, [string]$Sql, [string]$TargetContainer = $container) {
  $result = Invoke-ContainerSql $Name $User $Password $Sql -TargetContainer $TargetContainer
  $lines = $result.Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^NOTICE:' }
  $numeric = $lines | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1
  if ($numeric) { return $numeric.Trim() }
  return ($lines | Select-Object -Last 1).Trim()
}

function Wait-Ready([string]$Name, [int]$Seconds = 60) {
  $until = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    # The 18.x entrypoint briefly exposes the Unix socket while it is still
    # completing initdb. Probe TCP so the first psql step cannot race startup.
    & docker exec $Name pg_isready -h 127.0.0.1 -U fishing_test_admin -d fishing_test *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $until)
  throw "PostgreSQL container $Name did not become ready"
}

function Get-HostPort([string]$Name) {
  $port = (& docker port $Name 5432/tcp).Trim()
  if ($LASTEXITCODE -ne 0 -or $port -notmatch '127\.0\.0\.1:(\d+)$') { throw "Cannot resolve port for $Name" }
  return [int]$Matches[1]
}

function Invoke-Migration([string]$Dsn, [string]$LogPath) {
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    if (Get-Command $GoExe -ErrorAction SilentlyContinue) {
      Push-Location (Join-Path $repoRoot 'server-go')
      try {
        $env:FISHING_GO_MIGRATION_DATABASE_URL = $Dsn
        & $GoExe run ./cmd/migrate up 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $LogPath -Encoding UTF8
        return [int]$LASTEXITCODE
      } finally { Pop-Location }
    }
    # A host Go installation is optional. The pinned toolchain image runs on
    # the database container's network namespace, so 127.0.0.1 still refers
    # to the synthetic PostgreSQL and never a host or production endpoint.
    $containerDsn = $Dsn -replace '127\.0\.0\.1:\d+/fishing_test', '127.0.0.1:5432/fishing_test'
    & docker run --rm --network ('container:' + $container) -e ('FISHING_GO_MIGRATION_DATABASE_URL=' + $containerDsn) -v ($repoRoot + ':/src') -w /src/server-go $GoImage go run ./cmd/migrate up 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $LogPath -Encoding UTF8
    return [int]$LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
}

$cleanup = $true
try {
  [void](Get-Command docker -ErrorAction Stop)
  $sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
  $dirty = [bool](& git -C $repoRoot status --porcelain)
  Add-Record 'inputs' 'passed' @{ image = $Image; sourceCommit = $sourceCommit; dirty = $dirty; database = 'fishing_test'; hostFailure = 'untested' }

  Invoke-Logged 'volume-data' 'docker' @('volume', 'create', $volume) | Out-Null
  Invoke-Logged 'volume-archive' 'docker' @('volume', 'create', $archiveVolume) | Out-Null
  Invoke-Logged 'archive-permission' 'docker' @('run', '--rm', '--user', '0', '-v', ($archiveVolume + ':/archive'), '--entrypoint', '/bin/chmod', $Image, '0777', '/archive') | Out-Null
  Invoke-Logged 'postgres-start' 'docker' @('run', '-d', '--name', $container, '-e', 'POSTGRES_DB=fishing_test', '-e', 'POSTGRES_USER=fishing_test_admin', ('-e=POSTGRES_PASSWORD=' + $adminPassword), '-e', 'TZ=Asia/Shanghai', '-e', 'PGTZ=Asia/Shanghai', '-v', ($volume + ':/var/lib/postgresql'), '-v', ($archiveVolume + ':/archive'), '-p', '127.0.0.1::5432', $Image, 'postgres', '-c', 'fsync=on', '-c', 'synchronous_commit=on', '-c', 'full_page_writes=on', '-c', 'wal_level=replica', '-c', 'archive_mode=on', '-c', "archive_command=test ! -f /archive/%f && cp %p /archive/%f", '-c', 'max_wal_senders=2') | Out-Null
  Wait-Ready $container
  $port = Get-HostPort $container
  Add-Record 'postgres-start' 'passed' @{ port = $port }

  $bootstrap = Join-Path $repoRoot 'tools\go-rewrite\postgres-roles-bootstrap.sql'
  $runtime = Join-Path $repoRoot 'tools\go-rewrite\postgres-runtime-grants.sql'
  $bootstrapText = Get-Content -LiteralPath $bootstrap -Raw
  $bootstrapText = "\set migration_password '$migrationPassword'`n\set runtime_password '$runtimePassword'`n\set backup_password '$backupPassword'`n\set ops_password '$opsPassword'`n" + $bootstrapText
  $bootstrapTemp = Join-Path $runDir 'roles-bootstrap.sql'
  Set-Content -LiteralPath $bootstrapTemp -Value $bootstrapText -Encoding UTF8
  try { Invoke-ContainerFile 'roles-bootstrap' 'fishing_test_admin' $adminPassword $bootstrapTemp }
  finally { Remove-Item -LiteralPath $bootstrapTemp -Force -ErrorAction SilentlyContinue }
  Add-Record 'roles-bootstrap' 'passed' @{ migration = 'ddl'; runtime = 'dml allow-list'; backup = 'read-only + replication'; ops = 'monitoring' }

  $migrationDsn = "postgres://fishing_migrator:$migrationPassword@127.0.0.1:$port/fishing_test?sslmode=disable"
  $migrationLog = Join-Path $runDir 'go-migrate.log'
  $migrationExit = Invoke-Migration $migrationDsn $migrationLog
  if ($migrationExit -ne 0) { throw "migration failed (exit $migrationExit); see $migrationLog" }
  Invoke-ContainerSql 'ownership' 'fishing_test_admin' $adminPassword @'
REASSIGN OWNED BY fishing_migrator TO fishing_schema_owner;
ALTER SCHEMA fishing OWNER TO fishing_schema_owner;
REVOKE CREATE ON DATABASE fishing_test FROM fishing_migrator;
REVOKE CREATE ON SCHEMA public FROM fishing_migrator;
'@ | Out-Null
  Invoke-ContainerFile 'runtime-grants' 'fishing_test_admin' $adminPassword $runtime
  Add-Record 'migrations' 'passed' @{ path = 'empty database'; ownership = 'schema_owner'; runtimeDdl = 'revoked' }
  $opsProbe = Get-ContainerSql 'ops-monitor' 'fishing_ops' $opsPassword 'SELECT count(*) FROM pg_stat_activity;'
  if ($opsProbe -notmatch '^\d+$') { throw 'operations monitoring role could not read pg_stat_activity' }
  Add-Record 'ops-monitor' 'passed' @{ pgStatActivity = 'readable'; ddl = 'not granted' }

  $seed = @'
INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id;
'@
  $accountText = Get-ContainerSql 'seed-account' 'fishing_runtime' $runtimePassword $seed
  if ($accountText -notmatch '^\d+$') { throw 'runtime account insert did not return an id' }
  $accountId = [int64]$accountText
  Invoke-ContainerSql 'seed-state' 'fishing_runtime' $runtimePassword ("INSERT INTO fishing.player_state(account_id) VALUES ($accountId); INSERT INTO fishing.wallets(account_id,coins) VALUES ($accountId,100);") | Out-Null
  $baseline = Get-ContainerSql 'baseline-count' 'fishing_runtime' $runtimePassword "SELECT count(*) FROM fishing.wallets WHERE account_id=$accountId AND coins=100;"
  if ($baseline -ne '1') { throw 'runtime seed/accounting check failed' }
  Add-Record 'runtime-seed' 'passed' @{ accountRows = 1; walletCoins = 100 }

  $ddl = Invoke-ContainerSql 'runtime-ddl-denied' 'fishing_runtime' $runtimePassword 'CREATE TABLE fishing.runtime_must_not_create(id integer);' -AllowFailure
  $audit = Invoke-ContainerSql 'runtime-audit-denied' 'fishing_runtime' $runtimePassword 'DELETE FROM fishing.operator_audit;' -AllowFailure
  $role = Invoke-ContainerSql 'runtime-role-denied' 'fishing_runtime' $runtimePassword 'CREATE ROLE runtime_must_not_create;' -AllowFailure
  $backupWrite = Invoke-ContainerSql 'backup-write-denied' 'fishing_backup' $backupPassword "INSERT INTO fishing.operator_settings(key,value) VALUES ('backup_must_not_write','{}'::jsonb);" -AllowFailure
  if ($ddl.Code -eq 0 -or $audit.Code -eq 0 -or $role.Code -eq 0 -or $backupWrite.Code -eq 0) { throw 'runtime/backup privilege denial check failed' }
  Add-Record 'least-privilege' 'passed' @{ ddl = 'denied'; operatorAudit = 'denied'; createRole = 'denied'; backupWrite = 'denied' }

  $dumpStarted = [Diagnostics.Stopwatch]::StartNew()
  $dump = Invoke-Logged 'logical-dump' 'docker' @('exec', '-e', ('PGPASSWORD=' + $backupPassword), $container, 'pg_dump', '-h', '127.0.0.1', '-U', 'fishing_backup', '-d', 'fishing_test', '--format=custom', '--no-owner', '--no-acl', '--file=/tmp/fishing.dump')
  $dumpStarted.Stop()
  Invoke-Logged 'logical-verify' 'docker' @('exec', $container, 'pg_restore', '--list', '/tmp/fishing.dump') | Out-Null
  & docker cp ($container + ':/tmp/fishing.dump') $dumpPath 2>&1 | Set-Content -LiteralPath (Join-Path $runDir 'logical-dump-copy.log') -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw 'logical dump copy failed' }
  $dumpBytes = (Get-Item -LiteralPath $dumpPath).Length
  Add-Record 'logical-backup' 'passed' @{ bytes = $dumpBytes; elapsedMs = $dumpStarted.ElapsedMilliseconds; format = 'custom; no-owner; no-acl' }
  $dumpDb = 'fishing_dump_' + $runId.Substring(4)
  Invoke-Logged 'logical-restore-create' 'docker' @('exec', '-e', ('PGPASSWORD=' + $adminPassword), $container, 'createdb', '-h', '127.0.0.1', '-U', 'fishing_test_admin', $dumpDb) | Out-Null
  Invoke-Logged 'logical-restore' 'docker' @('exec', '-e', ('PGPASSWORD=' + $adminPassword), $container, 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '-h', '127.0.0.1', '-U', 'fishing_test_admin', '-d', $dumpDb, '/tmp/fishing.dump') | Out-Null
  $logicalRestoreRows = (& docker exec -e ('PGPASSWORD=' + $adminPassword) $container psql -h 127.0.0.1 -U fishing_test_admin -d $dumpDb -Atc "SELECT count(*) FROM fishing.wallets WHERE account_id=$accountId AND coins=100;" 2>$null).Trim()
  Invoke-Logged 'logical-restore-drop' 'docker' @('exec', '-e', ('PGPASSWORD=' + $adminPassword), $container, 'dropdb', '-h', '127.0.0.1', '-U', 'fishing_test_admin', $dumpDb) | Out-Null
  if ($logicalRestoreRows -ne '1') { throw 'logical restore did not preserve baseline row' }
  Add-Record 'logical-restore' 'passed' @{ baselineRows = 1 }

  New-Item -ItemType Directory -Path $baseDir, $archiveDir -Force | Out-Null
  $baseStarted = [Diagnostics.Stopwatch]::StartNew()
  Invoke-Logged 'basebackup' 'docker' @('exec', '-e', ('PGPASSWORD=' + $backupPassword), $container, 'pg_basebackup', '-h', '127.0.0.1', '-U', 'fishing_backup', '-D', '/tmp/fishing-basebackup', '-Fp', '-X', 'none', '-c', 'fast') | Out-Null
  $baseStarted.Stop()
  & docker cp ($container + ':/tmp/fishing-basebackup/.') $baseDir 2>&1 | Set-Content -LiteralPath (Join-Path $runDir 'basebackup-copy.log') -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw 'base backup copy failed' }
  Get-ChildItem -LiteralPath $baseDir -Recurse -File | Measure-Object -Property Length -Sum | ForEach-Object { $baseBytes = $_.Sum }
  Invoke-ContainerSql 'close-wal-before-marker' 'fishing_test_admin' $adminPassword 'SELECT pg_switch_wal();' | Out-Null
  Start-Sleep -Seconds 2
  & docker cp ($container + ':/archive/.') $archiveDir 2>&1 | Set-Content -LiteralPath (Join-Path $runDir 'wal-copy-before-marker.log') -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw 'WAL archive copy failed' }
  Add-Record 'physical-backup' 'passed' @{ bytes = $baseBytes; elapsedMs = $baseStarted.ElapsedMilliseconds; walFiles = @(Get-ChildItem -LiteralPath $archiveDir -File).Count }

  $target = Get-ContainerSql 'pitr-target-time' 'fishing_test_admin' $adminPassword "SET TIME ZONE 'UTC'; SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.USOF');"
  $markerSql = @'
INSERT INTO fishing.operator_settings(key,value)
VALUES ('rehearsal_marker', '{"phase":"after-base-backup"}'::jsonb)
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
'@
  Invoke-ContainerSql 'post-backup-marker' 'fishing_runtime' $runtimePassword $markerSql | Out-Null
  Invoke-ContainerSql 'close-wal-after-marker' 'fishing_test_admin' $adminPassword 'SELECT pg_switch_wal();' | Out-Null
  Start-Sleep -Seconds 2
  & docker cp ($container + ':/archive/.') $archiveDir 2>&1 | Set-Content -LiteralPath (Join-Path $runDir 'wal-copy-after-marker.log') -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw 'post-marker WAL archive copy failed' }

  $crashStarted = [Diagnostics.Stopwatch]::StartNew()
  Invoke-Logged 'process-crash' 'docker' @('kill', '-s', 'SIGKILL', $container) | Out-Null
  Invoke-Logged 'process-restart' 'docker' @('start', $container) | Out-Null
  Wait-Ready $container
  $crashStarted.Stop()
  $afterCrash = Get-ContainerSql 'post-crash-check' 'fishing_runtime' $runtimePassword "SELECT count(*) FROM fishing.wallets WHERE account_id=$accountId AND coins=100;"
  if ($afterCrash -ne '1') { throw 'process crash recovery lost committed baseline' }
  Add-Record 'process-failure-recovery' 'passed' @{ committedBaselineRows = 1; elapsedMs = $crashStarted.ElapsedMilliseconds }

  $auto = Join-Path $baseDir 'postgresql.auto.conf'
  Add-Content -LiteralPath $auto -Value "`nrestore_command = 'cp /archive/%f %p'`nrecovery_target_time = '$target'`nrecovery_target_action = 'pause'`n" -Encoding ASCII
  New-Item -ItemType File -Path (Join-Path $baseDir 'recovery.signal') -Force | Out-Null
  $pitrStarted = [Diagnostics.Stopwatch]::StartNew()
  Invoke-Logged 'pitr-start' 'docker' @('run', '-d', '--name', $restoreContainer, '-e', 'POSTGRES_PASSWORD=unused', '-v', ($baseDir + ':/var/lib/postgresql/18/docker'), '-v', ($archiveDir + ':/archive:ro'), '-p', '127.0.0.1::5432', $Image, 'postgres') | Out-Null
  Wait-Ready $restoreContainer
  $pitrStarted.Stop()
  $restorePort = Get-HostPort $restoreContainer
  $pitrCount = Get-ContainerSql 'pitr-check' 'fishing_test_admin' $adminPassword "SELECT count(*) FROM fishing.wallets WHERE account_id=$accountId AND coins=100;" $restoreContainer
  if ($pitrCount -ne '1') { throw 'PITR restore did not contain baseline row' }
  $pitrMarker = (& docker exec -e ('PGPASSWORD=' + $adminPassword) $restoreContainer psql -h 127.0.0.1 -U fishing_test_admin -d fishing_test -Atc "SELECT count(*) FROM fishing.operator_settings WHERE key='rehearsal_marker';" 2>$null).Trim()
  if ($pitrMarker -ne '0') { throw 'PITR target included post-target marker' }
  Add-Record 'pitr-recovery' 'passed' @{ targetUtc = $target; baselineRows = 1; postTargetMarkerRows = 0; elapsedMs = $pitrStarted.ElapsedMilliseconds; restorePort = $restorePort }

  $failureModes = [ordered]@{
    process = 'SIGKILL and restart exercised; committed baseline preserved'
    database = 'base backup plus archived WAL restored to target timestamp'
    hostOrDisk = 'not exercised; single-host Docker volume cannot prove zero-loss host failure'
  }
  Add-Record 'failure-boundary' 'passed' $failureModes
  $result = [ordered]@{ format = 1; tool = 'postgres-ops-rehearsal'; runId = $runId; startedAt = $started.ToString('o'); completedAt = [DateTime]::UtcNow.ToString('o'); result = 'passed'; records = $records; credentials = 'redacted'; source = 'synthetic only'; hostFailure = 'untested' }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8
  Write-Output "PostgreSQL rehearsal passed; evidence: $runDir"
} catch {
  Add-Record 'run' 'failed' @{ error = $_.Exception.Message }
  $result = [ordered]@{ format = 1; tool = 'postgres-ops-rehearsal'; runId = $runId; startedAt = $started.ToString('o'); completedAt = [DateTime]::UtcNow.ToString('o'); result = 'failed'; records = $records; credentials = 'redacted'; source = 'synthetic only'; hostFailure = 'untested' }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($cleanup -and !$Keep) {
    & docker rm -f $restoreContainer *> $null
    & docker rm -f $container *> $null
    & docker volume rm $volume $archiveVolume *> $null
  } else {
    Write-Output "Kept containers/volumes for inspection: $container, $restoreContainer, $volume, $archiveVolume"
  }
}
