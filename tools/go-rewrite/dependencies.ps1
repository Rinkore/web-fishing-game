param([string]$GoExe = 'go')
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$goRoot = Join-Path $repoRoot 'server-go'
Push-Location $goRoot
try {
  $lines = & $GoExe list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}|{{.Sum}}{{end}}{{end}}' ./cmd/game
  if ($LASTEXITCODE -ne 0) { throw 'Module inventory failed' }
  $records = @()
  $notices = [Text.StringBuilder]::new()
  [void]$notices.AppendLine('# Third-party notices')
  [void]$notices.AppendLine('')
  [void]$notices.AppendLine('Generated from the pinned cmd/game dependency graph. Application source is not licensed by this notice. The Go toolchain license is distributed separately with release artifacts.')
  foreach ($line in ($lines | Sort-Object -Unique)) {
    if (!$line.Trim()) { continue }
    $parts = $line.Split('|')
    if ($parts.Count -ne 4 -or !$parts[2]) { throw 'Download all modules before generating notices' }
    $license = @('LICENSE', 'LICENSE.txt', 'LICENSE.md') | ForEach-Object { Join-Path $parts[2] $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$license) { throw ('Missing license for ' + $parts[0]) }
    $records += [ordered]@{module=$parts[0]; version=$parts[1]; goSum=$parts[3]}
    [void]$notices.AppendLine('')
    [void]$notices.AppendLine('## ' + $parts[0] + ' ' + $parts[1])
    [void]$notices.AppendLine('')
    [void]$notices.AppendLine([IO.File]::ReadAllText($license).TrimEnd())
  }
  $utf8 = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText((Join-Path $goRoot 'THIRD_PARTY_NOTICES.md'), $notices.ToString().Replace("`r`n", "`n"), $utf8)
  $json = ConvertTo-Json -InputObject @($records) -Depth 4
  [IO.File]::WriteAllText((Join-Path $goRoot 'dependencies.json'), $json.Replace("`r`n", "`n") + "`n", $utf8)
  Write-Output ('Recorded licenses and versions for ' + $records.Count + ' modules.')
} finally { Pop-Location }
