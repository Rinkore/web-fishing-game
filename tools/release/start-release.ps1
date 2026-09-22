#requires -Version 7.0
<#
.SYNOPSIS
Validate a release, or atomically push main and its annotated tag with -Publish.
.DESCRIPTION
This starts the GitHub Actions release pipeline. It does not publish a GitHub
Release directly, modify application versions, commit files, or manage services.
dist/release.ps1 remains the only GitHub Release publishing implementation.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Publish,
    [switch]$SameVersionRevision
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

function Invoke-Git {
    param([string[]]$Arguments, [string]$InputText)
    if ($PSBoundParameters.ContainsKey('InputText')) {
        $output = @($InputText | & git -C $script:RepoRoot @Arguments 2>&1)
    } else {
        $output = @(& git -C $script:RepoRoot @Arguments 2>&1)
    }
    if ($LASTEXITCODE -ne 0) {
        # Git may echo a remote containing credentials. Never print those values.
        $details = (($output | ForEach-Object { "$_" }) -join "`n") -replace '(https?://)[^/\s@]+@', '$1[redacted]@'
        throw "git $($Arguments[0]) failed (exit $LASTEXITCODE). $details"
    }
    return @($output | ForEach-Object { "$_" })
}

function Assert-Worktree {
    if ((Invoke-Git -Arguments @('branch', '--show-current')) -cne 'main') {
        throw 'Release must start from the main branch.'
    }
    if (@(Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all')).Count -gt 0) {
        throw 'Working tree is dirty. Review and commit the intended release changes first.'
    }
}

function Get-ReleaseState {
    # Do not import or overwrite local tags when fetching a revised remote tag.
    $null = Invoke-Git -Arguments @('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main')
    $remoteMain = [string](Invoke-Git -Arguments @('rev-parse', 'refs/remotes/origin/main'))
    try {
        $null = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $remoteMain, $script:ReleaseHead)
    } catch {
        throw 'HEAD does not contain origin/main. Integrate the current remote main and validate again.'
    }
    $releases = @{}
    $peeled = @{}
    foreach ($line in (Invoke-Git -Arguments @('ls-remote', '--tags', 'origin'))) {
        if ($line -match '^([0-9a-f]{40,64})\s+refs/tags/(v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(\^\{\})?$') {
            $name = $Matches[2]
            if ($Matches[3]) {
                $peeled[$name] = $Matches[1]
            } else {
                $releases[$name] = [PSCustomObject]@{
                    Name = $name; Number = [version]$name.Substring(1)
                    Object = $Matches[1]; Commit = $Matches[1]
                }
            }
        }
    }
    foreach ($name in $peeled.Keys) {
        if ($releases.ContainsKey($name)) { $releases[$name].Commit = $peeled[$name] }
    }
    $latest = @($releases.Values | Sort-Object -Property Number -Descending | Select-Object -First 1)
    if ($latest.Count -eq 0) {
        throw 'No existing stable release tag found on origin. Establish the first release explicitly.'
    }
    $latest = $latest[0]
    $existing = $releases[$Version]
    if ($existing) {
        if ($existing.Name -cne $latest.Name) {
            throw "Only the latest release ($($latest.Name)) may be revised or retried."
        }
        if ($existing.Commit -ceq $script:ReleaseHead) {
            return [PSCustomObject]@{ Existing = $existing; NoChange = $true; Latest = $latest }
        }
        if (-not $SameVersionRevision) {
            throw "Tag $Version already exists at another commit. Use -SameVersionRevision only for an intentional revision of the latest release."
        }
    } else {
        if ($SameVersionRevision) { throw '-SameVersionRevision requires an existing latest release tag.' }
        $number = $latest.Number
        $allowed = @(
            "v$($number.Major).$($number.Minor).$($number.Build + 1)",
            "v$($number.Major).$($number.Minor + 1).0",
            "v$($number.Major + 1).0.0"
        )
        if ($Version -cnotin $allowed) {
            throw "Version must follow $($latest.Name) without skipping: $($allowed -join ', ')."
        }
    }
    return [PSCustomObject]@{ Existing = $existing; NoChange = $false; Latest = $latest }
}

try {
    Assert-Worktree
    $fetchUrls = @(Invoke-Git -Arguments @('remote', 'get-url', '--all', 'origin'))
    $pushUrls = @(Invoke-Git -Arguments @('remote', 'get-url', '--push', '--all', 'origin'))
    if ($fetchUrls.Count -ne 1 -or $pushUrls.Count -ne 1 -or $fetchUrls[0] -cne $pushUrls[0]) {
        throw 'origin must have one matching fetch/push URL so validation and publication target the same repository.'
    }
    $script:ReleaseHead = [string](Invoke-Git -Arguments @('rev-parse', 'HEAD'))
    $dataPath = Join-Path $script:RepoRoot 'frontend/js/data.js'
    $source = Get-Content -LiteralPath $dataPath -Raw
    $versionMatches = [regex]::Matches($source, '(?m)^\s*const\s+VERSION\s*=\s*[''"](v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))[''"]\s*;')
    if ($versionMatches.Count -ne 1) { throw 'Expected exactly one stable const VERSION in frontend/js/data.js.' }
    $sourceVersion = $versionMatches[0].Groups[1].Value
    if (-not $Version) { $Version = $sourceVersion }
    if ($Version -cnotmatch '^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$') {
        throw 'Version must be a stable vX.Y.Z value without leading zeroes.'
    }
    if ($Version -cne $sourceVersion) { throw "Version $Version does not match frontend/js/data.js ($sourceVersion)." }
    $notesPath = Join-Path $script:RepoRoot "dist/notes-$Version.md"
    $null = Invoke-Git -Arguments @('ls-files', '--error-unmatch', '--', 'frontend/js/data.js', "dist/notes-$Version.md")
    $notesFirstLine = Get-Content -LiteralPath $notesPath -TotalCount 1
    $notesVersion = [regex]::Match("$notesFirstLine", '\bv[0-9]+\.[0-9]+\.[0-9]+(?=\s|$)')
    if (-not $notesVersion.Success -or $notesVersion.Value -cne $Version) {
        throw "The first line of dist/notes-$Version.md must name $Version."
    }
    $localTag = @(Invoke-Git -Arguments @('for-each-ref', '--format=%(objectname)', "refs/tags/$Version"))
    $state = Get-ReleaseState
    if ($state.NoChange) {
        Write-Host "$Version already points to HEAD ($($script:ReleaseHead)). No refs pushed and no new tag event created."
        Write-Host "To rerun CI, use Actions > Linux release and deploy > Run workflow (workflow_dispatch), version=$Version."
        exit 0
    }
    if ($localTag.Count -gt 0) {
        $localCommit = [string](Invoke-Git -Arguments @('rev-parse', "refs/tags/$Version^{commit}"))
        if ($localCommit -cne $script:ReleaseHead -and (-not $state.Existing -or $localTag[0] -cne $state.Existing.Object)) {
            throw "Local tag $Version disagrees with both HEAD and origin. Reconcile it explicitly before publishing."
        }
    }
    Write-Host "Validated $Version at $($script:ReleaseHead); latest origin release is $($state.Latest.Name)."
    if (-not $Publish) {
        Write-Host 'Check only: no refs pushed. Add -Publish to atomically push main and the annotated release tag.'
        exit 0
    }

    # Fetch again immediately before publication. A same-version update also uses
    # an exact remote tag object lease so another publisher cannot be overwritten.
    Assert-Worktree
    if ([string](Invoke-Git -Arguments @('rev-parse', 'HEAD')) -cne $script:ReleaseHead) { throw 'HEAD changed during release validation; retry.' }
    $state = Get-ReleaseState
    if ($state.NoChange) {
        Write-Host "$Version now points to HEAD. No refs pushed; use workflow_dispatch to rerun CI."
        exit 0
    }
    $identity = [string](Invoke-Git -Arguments @('var', 'GIT_COMMITTER_IDENT'))
    $tagText = "object $($script:ReleaseHead)`ntype commit`ntag $Version`ntagger $identity`n`nRelease $Version`n"
    # mktag creates an annotated object without changing a local ref. Failed
    # atomic pushes therefore leave local release tags untouched as well.
    $tagObject = [string](Invoke-Git -Arguments @('mktag') -InputText $tagText)
    $pushArguments = @('push', '--atomic', '--no-follow-tags')
    if ($state.Existing) {
        $pushArguments += "--force-with-lease=refs/tags/${Version}:$($state.Existing.Object)"
    }
    $pushArguments += @('origin', "$($script:ReleaseHead):refs/heads/main", "${tagObject}:refs/tags/$Version")
    $null = Invoke-Git -Arguments $pushArguments
    $oldLocalTag = if ($localTag.Count -gt 0) { $localTag[0] } else { '0' * $tagObject.Length }
    try {
        $null = Invoke-Git -Arguments @('update-ref', "refs/tags/$Version", $tagObject, $oldLocalTag)
    } catch {
        Write-Warning 'Remote push succeeded, but the local tag changed concurrently and was left untouched. Fetch the published tag explicitly if needed.'
    }
    Write-Host "Published main and annotated tag $Version atomically. The GitHub Actions release pipeline can now run."
    Write-Host 'This confirms a Git push only. Check Actions and the production health check for release/deployment completion.'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
