param([int]$Players=100,[int]$Seconds=60)
$ErrorActionPreference='Stop'
if($Players -lt 1 -or $Players -gt 5000 -or $Seconds -lt 5 -or $Seconds -gt 3600){throw 'Players must be 1..5000; Seconds must be 5..3600'}
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$compose=Join-Path $repoRoot 'deploy\go-test\persistent.yml'
$project='fishing-acceptance-'+[Guid]::NewGuid().ToString('N').Substring(0,10)
$previousPhase=$env:FISHING_GO_ACCEPTANCE_PHASE
$previousPlayers=$env:FISHING_GO_ACCEPTANCE_PLAYERS
$previousSeconds=$env:FISHING_GO_ACCEPTANCE_SECONDS
try{
 $env:FISHING_GO_ACCEPTANCE_PLAYERS=[string]$Players
 $env:FISHING_GO_ACCEPTANCE_SECONDS=[string]$Seconds
 & docker compose -p $project -f $compose up -d --wait --wait-timeout 60 postgres
 if($LASTEXITCODE -ne 0){throw 'Persistent acceptance PostgreSQL failed to start'}
 $env:FISHING_GO_ACCEPTANCE_PHASE='run'
 & docker compose -p $project -f $compose --profile acceptance run --rm acceptance 2>&1 | Select-Object -Last 40
 if($LASTEXITCODE -ne 0){throw 'Persistent workload failed'}
 & docker compose -p $project -f $compose kill -s SIGKILL postgres
 if($LASTEXITCODE -ne 0){throw 'Isolated crash injection failed'}
 & docker compose -p $project -f $compose up -d --wait --wait-timeout 60 postgres
 if($LASTEXITCODE -ne 0){throw 'Database crash recovery failed'}
 $env:FISHING_GO_ACCEPTANCE_PHASE='verify'
 & docker compose -p $project -f $compose --profile acceptance run --rm acceptance 2>&1 | Select-Object -Last 40
 if($LASTEXITCODE -ne 0){throw 'Post-crash durability verification failed'}
}finally{
 $env:FISHING_GO_ACCEPTANCE_PHASE=$previousPhase
 $env:FISHING_GO_ACCEPTANCE_PLAYERS=$previousPlayers
 $env:FISHING_GO_ACCEPTANCE_SECONDS=$previousSeconds
 & docker compose -p $project -f $compose --profile acceptance down --volumes --remove-orphans
 if($LASTEXITCODE -ne 0){Write-Warning ('Acceptance cleanup failed for '+$project)}
}
