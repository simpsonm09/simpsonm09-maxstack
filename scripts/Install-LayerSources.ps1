# platforms: windows
# Layer sources: the -Source and -LayerSource overrides, how each layer's source is chosen, and the source
# record the lock keeps. A layer installs from a git source (a url, a ref, and the commit the ref resolved to) or
# from a local working tree. layers.json gives each layer's default source. An override changes the source for one
# run, and the lock records it, so a plain apply reuses it until -Source name=default drops it.
#
# Dot-sourced by Install-Workspace.ps1, so it shares that script's variables and functions.

# A test seam, and nothing else. When MAXSTACK_TEST_GITHUB_ROOT is set, the owner/repo shorthand names a bare
# repository under that folder instead of github.com, so the tests fetch from local repositories. Nothing else
# reads the variable, and a real run never sets it.
function Get-GitHubRemoteUrl {
    param([string] $Owner, [string] $Repo)

    $testRoot = $env:MAXSTACK_TEST_GITHUB_ROOT
    if ($testRoot) { return ((Join-Path $testRoot "$Owner\$Repo.git") -replace '\\', '/') }
    return "https://github.com/$Owner/$Repo.git"
}

# Whether the test seam is on. The tests set MAXSTACK_TEST_MODE, and a real run never does.
function Test-TestSeam {
    return ($env:MAXSTACK_TEST_MODE -eq '1')
}

# The options every git command the installer runs starts with. They stop git from running a program that a checkout
# names (core.fsmonitor and hooks), refuse every transport but https, and skip optional index locks. The test seam also
# allows file, since its remotes are local bare repositories. Two variables stop git from waiting on a credential prompt.
function Get-GitGuardArgs {
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
    $guard = @('-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always')
    if (Test-TestSeam) { $guard += @('-c', 'protocol.file.allow=always') }
    return ($guard + '--no-optional-locks')
}

# The reason a git -Source spec is refused, or $null when its characters and parts are acceptable.
function Get-SpecFault {
    param([string] $Spec)

    if ($Spec -match '[\s\x00-\x1f\x7f]') { return 'it holds a space or a control character' }
    if ($Spec.StartsWith('-')) { return 'it starts with a dash' }
    if ($Spec.Contains('..')) { return 'it holds ..' }
    return $null
}

# Whether a ref is a full commit SHA, which is pinned, or a branch or tag name, which moves.
function Test-CommitRef {
    param([string] $Ref)

    return ($Ref -cmatch '^[0-9a-f]{40}$')
}

# Whether a ref is a safe git ref name. git check-ref-format is the authority. A leading dash is refused here too,
# because the ref is passed to git as an argument.
function Test-SafeRefName {
    param([string] $Ref)

    if (Test-CommitRef $Ref) { return $true }
    if ($Ref.StartsWith('-') -or $Ref -match '\s' -or $Ref.Contains('..')) { return $false }
    & git @(Get-GitGuardArgs) check-ref-format "refs/heads/$Ref" 2>$null
    return ($LASTEXITCODE -eq 0)
}

# A local source is a working tree that is never fetched. It must be an absolute folder that is not the workspace
# and not one of the folders the installer writes into.
function Read-LocalSpec {
    param([string] $Name, [string] $Path)

    if ($Path -notmatch '^([A-Za-z]:[\\/]|[\\/]{2}|/)') { throw "-Source $Name=local:$Path needs an absolute path." }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "-Source $Name=local:${Path}: that folder does not exist." }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $normal = Get-NormalPath $full
    if ($normal -eq (Get-NormalPath $Workspace)) { throw "-Source $Name=local:$Path is the workspace itself, which cannot be a layer source." }
    foreach ($output in @('.claude', '.opencode', '.pi', '.maxstack')) {
        $folder = Get-NormalPath (Join-Path $Workspace $output)
        if ($normal -eq $folder -or $normal.StartsWith("$folder\", [StringComparison]::Ordinal)) {
            throw "-Source $Name=local:$Path is inside $output, which the installer writes, so it cannot be a layer source."
        }
    }
    return [pscustomobject]@{ kind = 'local'; path = $full }
}

# A git spec is owner/repo@ref, or https://host/path@ref. The ref is the part after the last @.
function Read-GitSpec {
    param([string] $Name, [string] $Spec)

    $at = $Spec.LastIndexOf('@')
    if ($at -lt 1) { throw "-Source $Name=$Spec needs @ref: the branch, tag, or full commit to install." }
    $location = $Spec.Substring(0, $at)
    $ref = $Spec.Substring($at + 1)
    if (-not (Test-SafeRefName $ref)) { throw "-Source $Name=${Spec}: '$ref' is not a safe git ref name." }
    if ($location -match '^[A-Za-z][A-Za-z0-9+.-]*:') {
        if ($location -cnotmatch '^https://[^/\\?#@]+/[^\\?#@]+$') {
            throw "-Source $Name=${Spec}: only https:// URLs with a host and a path are allowed."
        }
        return [pscustomobject]@{ kind = 'git'; url = $location; ref = $ref }
    }
    if ($location -cmatch '^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$') {
        $repo = $Matches[2] -replace '\.git$', ''
        return [pscustomobject]@{ kind = 'git'; url = (Get-GitHubRemoteUrl -Owner $Matches[1] -Repo $repo); ref = $ref }
    }
    throw "-Source $Name=${Spec}: the location must be owner/repo or an https:// URL."
}

# Reads one -Source spec. Empty or default drops the override. The forms are owner/repo@ref, https://host/path@ref,
# and local:<absolute path>. Anything else is refused with the rule it broke.
function Read-SourceSpec {
    param([string] $Name, [string] $Spec)

    if ($Spec -ceq '' -or $Spec -ceq 'default') { return [pscustomobject]@{ kind = 'default' } }
    if ($Spec.StartsWith('local:', [StringComparison]::Ordinal)) { return (Read-LocalSpec -Name $Name -Path $Spec.Substring(6)) }
    $fault = Get-SpecFault $Spec
    if ($fault) { throw "-Source $Name=$Spec is refused: $fault. Use owner/repo@ref, https://host/path.git@ref, or local:<absolute path>." }
    return (Read-GitSpec -Name $Name -Spec $Spec)
}

# The explicit sources a run names. -Source name=spec and -LayerSource name=path, which is -Source name=local:path.
# Each entry may be comma-separated in one token, since pwsh -File passes separate tokens as separate values.
function Read-SourceSpecs {
    param([string[]] $Specs, [string[]] $LayerSpecs, [string[]] $LayerNames)

    $table = @{}
    foreach ($entry in @($Specs | ForEach-Object { $_ -split ',' } | Where-Object { $_ })) {
        $name, $spec = $entry -split '=', 2
        if ($null -eq $spec) { throw "-Source expects name=spec, got '$entry'." }
        Add-ExplicitSource -Table $table -Name $name -Spec (Read-SourceSpec -Name $name -Spec $spec) -LayerNames $LayerNames
    }
    foreach ($entry in @($LayerSpecs | ForEach-Object { $_ -split ',' } | Where-Object { $_ })) {
        $name, $path = $entry -split '=', 2
        if (-not (Test-NonEmptyString $path)) { throw "LayerSource expects name=path, got '$entry'." }
        $full = if ([IO.Path]::IsPathRooted($path)) { $path } else { Join-Path (Get-Location).ProviderPath $path }
        Add-ExplicitSource -Table $table -Name $name -Spec (Read-LocalSpec -Name $name -Path $full) -LayerNames $LayerNames
    }
    return $table
}

function Add-ExplicitSource {
    param($Table, [string] $Name, $Spec, [string[]] $LayerNames)

    if ($LayerNames -cnotcontains $Name) { throw "-Source names an unknown layer: $Name. Layers in layers.json: $($LayerNames -join ', ')." }
    if ($Table.ContainsKey($Name)) { throw "-Source names layer $Name twice." }
    $Table[$Name] = $Spec
}

# Joins a folder inside a checkout or cache. '.' names the whole repository.
function Join-SourceSub {
    param([string] $Root, [string] $Sub)

    if ([string]::IsNullOrEmpty($Sub) -or $Sub -eq '.') { return $Root }
    return (Join-Path $Root ($Sub -replace '/', '\'))
}

# The state of a local checkout, read without writing: its HEAD commit and whether it holds uncommitted changes.
# A folder that is not a git checkout has neither, so nothing is invented for it.
function Get-LocalCheckoutState {
    param([string] $Root)

    $none = [pscustomobject]@{ commit = $null; dirty = $null }
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $none }
    $head = (& git @(Get-GitGuardArgs) -C $Root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $head) { return $none }
    $changes = @(& git @(Get-GitGuardArgs) -C $Root status --porcelain -- . 2>$null | Where-Object { $_ })
    return [pscustomobject]@{ commit = ([string] $head).Trim(); dirty = ($changes.Count -gt 0) }
}

# The commit a branch, tag, or full commit names on a remote, read with git ls-remote. Nothing is written. A
# branch wins over a tag of the same name, and an annotated tag resolves to the commit it points at.
function Find-GitRefCommit {
    param([string] $Url, [string] $Ref)

    $output = @(& git @(Get-GitGuardArgs) ls-remote -- $Url 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "could not read the refs of ${Url}: $($output -join ' ')" }
    $refs = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($line in $output) {
        $sha, $name = $line -split "`t", 2
        if ($name) { $refs[$name] = $sha }
    }
    foreach ($candidate in @("refs/heads/$Ref", "refs/tags/$Ref^{}", "refs/tags/$Ref")) {
        if ($refs.ContainsKey($candidate)) { return $refs[$candidate] }
    }
    throw "$Url has no branch or tag named $Ref."
}

# The choice a layer takes when no override names it: layers.json's pin, or its local checkout.
function New-DefaultChoice {
    param($Layer)

    if ($Layer.defaultGit) {
        return [pscustomobject]@{ kind = 'git'; url = $Layer.defaultUrl; ref = $Layer.defaultRef; commit = $Layer.defaultCommit; path = $null; checkout = $null; override = $false }
    }
    $checkout = Join-Path $Workspace ($Layer.path -replace '/', '\')
    return [pscustomobject]@{ kind = 'local'; url = $Layer.defaultUrl; ref = $null; commit = $null; path = $Layer.path; checkout = $checkout; override = $false }
}

# A git choice. A commit is taken as given, a branch or tag is resolved on the remote unless the commit is known. A
# choice equal to the layers.json pin is the default, not an override.
function New-GitChoice {
    param($Layer, [string] $Url, [string] $Ref, [string] $Commit)

    $resolved = $Commit
    if (-not $resolved) { $resolved = if (Test-CommitRef $Ref) { $Ref } else { Find-GitRefCommit -Url $Url -Ref $Ref } }
    if ($Layer.defaultGit -and $Url -ceq $Layer.defaultUrl -and $resolved -ceq $Layer.defaultCommit) { return (New-DefaultChoice $Layer) }
    return [pscustomobject]@{ kind = 'git'; url = $Url; ref = $Ref; commit = $resolved; path = $null; checkout = $null; override = $true }
}

# A local choice. The folder that equals the layers.json checkout is the default, not an override.
function New-LocalChoice {
    param($Layer, [string] $Path)

    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $Layer.defaultGit -and (Get-NormalPath $full) -eq (Get-NormalPath (Join-Path $Workspace ($Layer.path -replace '/', '\')))) {
        return (New-DefaultChoice $Layer)
    }
    return [pscustomobject]@{ kind = 'local'; url = $null; ref = $null; commit = $null; path = $full; checkout = $full; override = $true }
}

# The choice for one layer. An explicit -Source wins. Otherwise a recorded override is reused. Otherwise the default.
function Resolve-LayerChoice {
    param($Layer, $Explicit, $Recorded, [bool] $Updating)

    if ($null -ne $Explicit) {
        if ($Explicit.kind -eq 'default') { return (New-DefaultChoice $Layer) }
        if ($Explicit.kind -eq 'local') { return (New-LocalChoice -Layer $Layer -Path $Explicit.path) }
        return (New-GitChoice -Layer $Layer -Url $Explicit.url -Ref $Explicit.ref -Commit $null)
    }
    if ($null -ne $Recorded) {
        if ($Recorded.kind -eq 'local') { return (New-LocalChoice -Layer $Layer -Path $Recorded.path) }
        # -Update moves a branch or tag to its current commit. A commit stays as recorded.
        $commit = if ($Updating -and -not (Test-CommitRef $Recorded.ref)) { $null } else { $Recorded.commit }
        return (New-GitChoice -Layer $Layer -Url $Recorded.url -Ref $Recorded.ref -Commit $commit)
    }
    return (New-DefaultChoice $Layer)
}

# Writes a choice into the layer model the rest of the installer reads. A local layer reads its checkout, and
# records HEAD and the dirty flag of that checkout. A git layer keeps its url, ref, and commit.
function Set-LayerChoice {
    param($Layer, $Choice)

    $Layer.override = [bool] $Choice.override
    $Layer.recordUrl = $Choice.url
    if ($Choice.kind -eq 'git') {
        $Layer.sourceKind = 'git'
        $Layer.url = $Choice.url
        $Layer.ref = $Choice.ref
        $Layer.commit = $Choice.commit
        $Layer.dirty = $null
        $Layer.localPath = $null
        $Layer.folderMissing = $false
        $Layer.repoRoot = $null
        $Layer.root = $null
        return
    }
    $state = Get-LocalCheckoutState $Choice.checkout
    $Layer.sourceKind = 'local'
    $Layer.url = $null
    $Layer.ref = $null
    $Layer.commit = $state.commit
    $Layer.dirty = $state.dirty
    $Layer.localPath = $Choice.path
    $Layer.repoRoot = $Choice.checkout
    # A folder that is gone has no root. Only an apply refuses it; every other run reports it.
    $Layer.folderMissing = -not (Test-Path -LiteralPath $Choice.checkout -PathType Container)
    $Layer.root = if ($Layer.folderMissing) { $null } else { Join-SourceSub $Choice.checkout $Layer.sourcePath }
}

# Resolves every layer's source for this run. Explicit maps names to parsed -Source specs, and Recorded maps names
# to the override the lock recorded. -Update moves only the selected layers: an unselected layer keeps its recorded
# commit, so a remote that only it uses is never read.
function Set-LayerSources {
    param([object[]] $Layers, [hashtable] $Explicit, [hashtable] $Recorded, [bool] $Updating, [string[]] $SelectedLayers)

    foreach ($layer in $Layers) {
        $moves = $Updating -and ($SelectedLayers -ccontains $layer.name)
        $choice = Resolve-LayerChoice -Layer $layer -Explicit $Explicit[$layer.name] -Recorded $Recorded[$layer.name] -Updating $moves
        Set-LayerChoice -Layer $layer -Choice $choice
    }
}

# The source record the lock keeps for one layer. A git source records its url, ref, and commit. A local source records
# its folder, HEAD, and the dirty flag, and never a commit it cannot read.
function New-SourceRecord {
    param($Layer)

    if ($Layer.sourceKind -eq 'git') {
        return [pscustomobject]@{ kind = 'git'; url = $Layer.url; ref = $Layer.ref; commit = $Layer.commit; override = $Layer.override }
    }
    return [pscustomobject]@{ kind = 'local'; url = $Layer.recordUrl; ref = $null; commit = $Layer.commit; dirty = $Layer.dirty; override = $Layer.override; path = $Layer.localPath }
}

# The source block of each layer the lock records as an override. A plain apply reuses these.
function Get-RecordedOverrides {
    param($Stack)

    $overrides = @{}
    foreach ($layer in @($Stack.layers)) {
        $block = Get-Field $layer 'source'
        if (($block -is [pscustomobject]) -and ((Get-Field $block 'override') -eq $true)) { $overrides[$layer.name] = $block }
    }
    return $overrides
}

# The source a lock records for a layer, or the one its layers.json entry implies when the lock predates the source
# block. A legacy layer is a local checkout when it has a path, and a git pin otherwise.
function Get-RecordedSourceOf {
    param($Record)

    $block = Get-Field $Record 'source'
    if ($block -is [pscustomobject]) { return $block }
    $local = $null -ne (Get-Field $Record 'path')
    return [pscustomobject]@{
        kind     = $(if ($local) { 'local' } else { 'git' })
        url      = $(if ($local) { $null } else { Get-Field $Record 'source' })
        ref      = $null
        commit   = Get-Field $Record 'commit'
        dirty    = $null
        override = $false
        path     = Get-Field $Record 'path'
    }
}

# The dirty flag as the block words it. A record from before the flag was kept has none, and says so rather than guessing.
function Format-DirtyLabel {
    param($Dirty)

    if ($null -eq $Dirty) { return 'dirty state not recorded' }
    if ($Dirty) { return 'uncommitted changes' }
    return 'clean'
}

# The lines of the layer-source block: every override, every local source, and every source whose ref moves. A git
# source that is pinned by commit and not overridden is at its committed pin, so it is not listed. Empty when none is.
function Get-SourcePinLines {
    param([object[]] $Entries)

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $Entries) {
        $source = $entry.source
        if ($source.kind -eq 'git') {
            if ($source.override) { $lines.Add("  $($entry.name): override, git $($source.url) ref $($source.ref) at $($source.commit)") }
            continue
        }
        $kind = if ($source.override) { 'override, local' } else { 'local, default' }
        if ($source.path -and -not (Test-Path -LiteralPath $source.path -PathType Container)) {
            $lines.Add("  $($entry.name): $kind $($source.path): folder missing")
            continue
        }
        $where = if ($null -eq $source.commit) { 'not a git checkout' } else { "HEAD $($source.commit), $(Format-DirtyLabel $source.dirty)" }
        $lines.Add("  $($entry.name): $kind $($source.path) ($where)")
    }
    return $lines.ToArray()
}

# Prints the block at the top of -Status and of an audit, so a workspace never runs from a test source unnoticed.
function Write-SourcePinBlock {
    param([object[]] $Entries)

    $lines = @(Get-SourcePinLines -Entries $Entries)
    if ($lines.Count -eq 0) { return }
    Write-Host 'Layer sources not at their committed pin:'
    foreach ($line in $lines) { Write-Host $line }
}

# The entries -Status reads from the lock, and the entries an audit reads from the layers it resolved.
function Get-RecordedSourceEntries {
    param($Stack)

    if ($null -eq $Stack) { return @() }
    return @(@($Stack.layers) | ForEach-Object { [pscustomobject]@{ name = $_.name; source = Get-RecordedSourceOf $_ } })
}

function Get-ResolvedSourceEntries {
    param([object[]] $Layers)

    return @($Layers | ForEach-Object { [pscustomobject]@{ name = $_.name; source = New-SourceRecord $_ } })
}

# ---- -Update: move branch and tag overrides to their current commit, re-read local sources, and report the change ----

function Format-Commit {
    param($Commit)

    if ($null -eq $Commit) { return 'none' }
    return [string] $Commit
}

function Format-DirtyState {
    param($Dirty)

    if ($null -eq $Dirty) { return 'unknown' }
    if ($Dirty) { return 'yes' }
    return 'no'
}

# Whether a commit is in a layer's cache. The check reads the cache and never fetches: --no-lazy-fetch stops git from
# pulling a missing object from origin, so a check leaves the cache byte for byte as it was.
function Test-CachedCommit {
    param([string] $Cache, [string] $Commit)

    if ([string]::IsNullOrEmpty($Commit) -or -not (Test-Path -LiteralPath (Join-Path $Cache '.git'))) { return $false }
    & git @(Get-GitGuardArgs) --no-lazy-fetch -C $Cache cat-file -e "$Commit^{commit}" 2>$null
    return ($LASTEXITCODE -eq 0)
}

# Whether this git accepts --no-lazy-fetch, which needs git 2.44. The probe runs once per run. Without the flag a check
# could fetch from origin, so the changed files are reported unknown instead.
$script:noLazyFetchSupported = $null
function Test-NoLazyFetchSupport {
    if ($null -eq $script:noLazyFetchSupported) {
        & git @(Get-GitGuardArgs) --no-lazy-fetch version 2>$null | Out-Null
        $script:noLazyFetchSupported = ($LASTEXITCODE -eq 0)
    }
    return $script:noLazyFetchSupported
}

# What a git source's move changes under the layer's folder, read from the cache. A commit the cache does not hold
# is named as needing a fetch, since a check writes nothing and cannot read it. Renames are off: rename detection reads
# blobs, and a partial clone may not hold them, so git would fail rather than count.
function Get-MoveFilesNote {
    param($Layer, [string] $OldCommit)

    $cache = Join-Path $claudeCacheTarget $Layer.name
    if (-not (Test-NoLazyFetchSupport)) { return 'changed files unknown: git 2.44 or later is needed to read the cache without fetching' }
    if (-not (Test-CachedCommit $cache $Layer.commit)) {
        return 'needs fetch: the new commit is not in the cache, so the changed files are known after an apply fetches it'
    }
    if (-not (Test-CachedCommit $cache $OldCommit)) { return 'changed files unknown: the old commit is not in the cache' }
    $output = @(& git @(Get-GitGuardArgs) --no-lazy-fetch -C $cache diff --no-renames --name-only $OldCommit $Layer.commit -- $Layer.sourcePath 2>$null)
    if ($LASTEXITCODE -ne 0) { return 'changed files unknown: git could not list the changed files from the cache' }
    $changed = @($output | Where-Object { $_ })
    return "$($changed.Count) files changed under $($Layer.sourcePath)"
}

# One layer's line in the -Update report, and whether the layer's source changes. A branch or tag override moves to its
# current commit. A commit pin never moves, and neither does a layers.json pin. A local source is read again, and its
# HEAD and dirty flag are compared with the record. The owned paths an apply would rewrite are reported separately.
function Get-SourceUpdate {
    param($Layer, $PriorSource)

    $oldCommit = Get-Field $PriorSource 'commit'
    if ($Layer.sourceKind -eq 'local') {
        if ($Layer.folderMissing) { return [pscustomobject]@{ line = "  $($Layer.name): local $($Layer.localPath): folder missing"; changed = $true } }
        $was = Format-DirtyState (Get-Field $PriorSource 'dirty')
        $now = Format-DirtyState $Layer.dirty
        $head = "HEAD $(Format-Commit $oldCommit) -> $(Format-Commit $Layer.commit)"
        return [pscustomobject]@{
            line    = "  $($Layer.name): local $($Layer.localPath): $head, uncommitted changes $was -> $now"
            changed = (($oldCommit -cne $Layer.commit) -or ($was -cne $now))
        }
    }
    if (-not $Layer.override) {
        return [pscustomobject]@{ line = "  $($Layer.name): pinned at $($Layer.commit) in layers.json"; changed = $false }
    }
    if (Test-CommitRef $Layer.ref) {
        return [pscustomobject]@{ line = "  $($Layer.name): override pinned to commit $($Layer.commit), not moved"; changed = $false }
    }
    if ($oldCommit -ceq $Layer.commit) {
        return [pscustomobject]@{ line = "  $($Layer.name): $($Layer.ref) is at $($Layer.commit), unchanged"; changed = $false }
    }
    $note = Get-MoveFilesNote -Layer $Layer -OldCommit $oldCommit
    return [pscustomobject]@{ line = "  $($Layer.name): $($Layer.ref) $oldCommit -> $($Layer.commit); $note"; changed = $true }
}

# The hint for a layers.json pin whose branch has moved on. -Update never moves a pin, so the line names the change to
# make by hand. A branch that cannot be read is named, and the report goes on, since no install depends on the hint.
function Get-PinHint {
    param($Layer)

    if (-not $Layer.defaultGit -or (Test-CommitRef $Layer.defaultRef)) { return $null }
    try {
        $head = Find-GitRefCommit -Url $Layer.defaultUrl -Ref $Layer.defaultRef
    } catch {
        return "  $($Layer.name): cannot read $($Layer.defaultRef) to check the pin: $($_.Exception.Message)"
    }
    if ($head -ceq $Layer.defaultCommit) { return $null }
    return "  $($Layer.name): layers.json pins $($Layer.defaultCommit), and $($Layer.defaultRef) is at $head. -Update never moves a pin. To move it, change source.commit in layers.json (and the matching pin in pstack.lock.json), then run verify-manifests."
}

# The record one layer has in the lock, or $null when the lock names none.
function Get-PriorLayerRecord {
    param($Stack, [string] $Name)

    if ($null -eq $Stack) { return $null }
    return (@($Stack.layers | Where-Object { $_.name -ceq $Name }) | Select-Object -First 1)
}

# The -Update report: each selected layer's source as it stands and as -Update would resolve it, the pin hints, and each
# owned path an apply would rewrite. It writes nothing. Returns the number of changes, which -Strict counts.
function Write-UpdateReport {
    param(
        [object[]] $Layers,
        $PriorStack,
        [string[]] $SelectedLayers,
        [string[]] $SelectedRuntimes,
        [object[]] $Plan,
        $Owned,
        [string[]] $NotSelected
    )

    Write-Host 'Layer sources (-Update):'
    $changes = 0
    foreach ($layer in @($Layers | Where-Object { $SelectedLayers -ccontains $_.name })) {
        $prior = Get-PriorLayerRecord -Stack $PriorStack -Name $layer.name
        $priorSource = $null
        if ($null -ne $prior) { $priorSource = Get-RecordedSourceOf $prior }
        $update = Get-SourceUpdate -Layer $layer -PriorSource $priorSource
        Write-Host $update.line
        if ($update.changed) { $changes++ }
        $hint = Get-PinHint $layer
        if ($hint) { Write-Host $hint }
    }
    if ($null -eq $Owned) {
        Write-Host 'no ownership record; -Update -Apply writes one'
        return $changes
    }
    $results = @(Get-OwnershipReport -Recorded $Owned -Plan $Plan -SelectedRuntimes $SelectedRuntimes -NotSelected $NotSelected)
    $moving = @($results | Where-Object { $_.state -in @('drifted', 'modified', 'missing') })
    foreach ($item in $moving) { Write-Host ('  would change {0,-9} {1}' -f $item.state, $item.label) }
    return ($changes + $moving.Count)
}

function Write-UpdateSummary {
    param([int] $Changes)

    if ($Changes -eq 0) {
        Write-Host 'Nothing would change.'
        return
    }
    Write-Host "Would change: $Changes item(s)."
}
