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
    & git check-ref-format "refs/heads/$Ref" 2>$null
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
    $head = (& git -C $Root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $head) { return $none }
    $changes = @(& git --no-optional-locks -C $Root status --porcelain -- . 2>$null | Where-Object { $_ })
    return [pscustomobject]@{ commit = ([string] $head).Trim(); dirty = ($changes.Count -gt 0) }
}

# The commit a branch, tag, or full commit names on a remote, read with git ls-remote. Nothing is written. A
# branch wins over a tag of the same name, and an annotated tag resolves to the commit it points at.
function Find-GitRefCommit {
    param([string] $Url, [string] $Ref)

    $output = @(& git -C $repoRoot ls-remote -- $Url 2>&1 | ForEach-Object { "$_" })
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
    $Layer.root = Join-SourceSub $Choice.checkout $Layer.sourcePath
}

# Resolves every layer's source for this run. Explicit maps names to parsed -Source specs, and Recorded maps names
# to the override the lock recorded.
function Set-LayerSources {
    param([object[]] $Layers, [hashtable] $Explicit, [hashtable] $Recorded, [bool] $Updating)

    foreach ($layer in $Layers) {
        $choice = Resolve-LayerChoice -Layer $layer -Explicit $Explicit[$layer.name] -Recorded $Recorded[$layer.name] -Updating $Updating
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
