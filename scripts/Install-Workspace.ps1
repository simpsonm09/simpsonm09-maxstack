# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $LayersFile = '',
    [string[]] $LayerSource = @(),
    # Per-run layer sources: name=owner/repo@ref, name=https://host/path.git@ref, name=local:<absolute path>, or
    # name=default to drop an override. Repeatable, and comma-separable like -LayerSource.
    [Alias('Source')]
    [string[]] $SourceOverrides = @(),
    # The Copilot CLI to wrap: a command name on PATH, or a path. A match inside .maxstack\bin is never used.
    [string] $CopilotCommand = 'copilot',
    # The Pi CLI to wrap, by the same rule as CopilotCommand.
    [string] $PiCommand = 'pi',
    # Runtimes to add to the recorded selection: claude, opencode, copilot, pi, or all. Comma-separated
    # values are split, because separate tokens do not bind to an array under pwsh -File.
    [Alias('Runtimes')]
    [string[]] $RequestedRuntimes = @(),
    # Layers to add to the recorded selection, by their names in layers.json, or all.
    [Alias('Layers')]
    [string[]] $RequestedLayers = @(),
    [switch] $Apply,
    # Reports each owned path against the ownership record in stack.lock.json. Writes nothing.
    [switch] $Status,
    # Removes the runtimes and layers named by -Runtimes or -Layers, and nothing else. A dry run unless -Apply.
    [switch] $Remove,
    # Removes everything the ownership record names, then the lock files. A dry run unless -Apply.
    [switch] $Uninstall,
    # Re-resolves the recorded layer sources: a branch or tag override moves to its current commit, a local source is
    # read again, and a commit pin and a layers.json pin stay. Shows the change; -Apply applies it.
    [switch] $Update,
    # With -Update, writes nothing and exits 0 whatever it finds. With -Strict it exits 1 when anything would change.
    [switch] $Check,
    # With -Status, exits 1 when a path is not matching, or when the workspace has no record. With -Remove or
    # -Uninstall, exits 1 when anything was skipped. With -Update, exits 1 when anything would change.
    [switch] $Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Apply -and $Status) { throw '-Apply writes the workspace and -Status only reports it. Choose one.' }
if ($Remove -and $Uninstall) { throw '-Remove names what to remove and -Uninstall removes everything. Choose one.' }
if (($Remove -or $Uninstall) -and $Status) { throw '-Status only reports. Choose -Status, -Remove, or -Uninstall.' }
if ($Strict -and -not ($Status -or $Remove -or $Uninstall -or $Update)) { throw '-Strict applies to -Status, -Remove, -Uninstall, and -Update.' }
$namesRequested = $PSBoundParameters.ContainsKey('RequestedRuntimes') -or $PSBoundParameters.ContainsKey('RequestedLayers')
if ($Status -and $namesRequested) { throw '-Status reports the recorded selection and takes no -Runtimes or -Layers. Select with an apply.' }
if ($Uninstall -and $namesRequested) { throw '-Uninstall removes everything the lock records, so it takes no -Runtimes or -Layers. Use -Remove to name what to remove.' }
if ($Remove -and -not $namesRequested) { throw '-Remove names what to remove: give -Runtimes or -Layers. Use -Uninstall to remove everything.' }
$sourceNamed = $PSBoundParameters.ContainsKey('SourceOverrides') -or $PSBoundParameters.ContainsKey('LayerSource')
if (($Status -or $Remove -or $Uninstall) -and $sourceNamed) { throw '-Source sets a layer source for an apply or an audit. -Status, -Remove, and -Uninstall read the recorded sources.' }
if ($Update -and ($Remove -or $Uninstall -or $Status)) { throw '-Update re-resolves the recorded sources. It is not -Remove, -Uninstall, or -Status.' }
if ($Update -and $sourceNamed) { throw '-Update re-resolves the recorded sources. Set a source with -Source and an apply, then -Update.' }
if ($Update -and $namesRequested) { throw '-Update applies the recorded selection. Change the selection with an apply.' }
if ($Check -and -not $Update) { throw '-Check applies to -Update.' }
if ($Check -and $Apply) { throw '-Check writes nothing. Drop -Apply, or drop -Check to apply the update.' }
if ($Strict -and $Update -and $Apply) { throw '-Strict with -Update reports and writes nothing. Drop -Apply or -Strict.' }
$removing = [bool] $Remove
$uninstalling = [bool] $Uninstall
$updating = [bool] $Update

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Install-LayerSources.ps1')
$layersPath = if ($LayersFile) { $LayersFile } else { Join-Path $repoRoot 'layers.json' }
$baseConfigFile = Join-Path $repoRoot 'workspace\opencode.jsonc'
$configTarget = Join-Path $Workspace 'opencode.jsonc'
$stackTarget = Join-Path $Workspace 'stack.lock.json'
$agentsTarget = Join-Path $Workspace '.opencode\agents'
$opencodePluginsTarget = Join-Path $Workspace '.opencode\plugins'
$claudePluginsTarget = Join-Path $Workspace '.claude\plugins'
$claudeCacheTarget = Join-Path $Workspace '.claude\cache'
$copilotBinTarget = Join-Path $Workspace '.maxstack\bin'
$copilotCmdTarget = Join-Path $copilotBinTarget 'copilot.cmd'
$copilotShTarget = Join-Path $copilotBinTarget 'copilot.sh'
# The Pi wrappers share .maxstack\bin. They name the agent folder, where Pi reads its settings.
$piCmdTarget = Join-Path $copilotBinTarget 'pi.cmd'
$piShTarget = Join-Path $copilotBinTarget 'pi.sh'
$piAgentDir = Join-Path $Workspace '.pi\agent'
$piSettingsTarget = Join-Path $piAgentDir 'settings.json'
$runtimeNames = @('claude', 'opencode', 'copilot', 'pi')
# The OpenCode port this repository used to pin. Its folder is removed on every apply,
# so a workspace that still has it ends with the same tree as one that never did.
$retiredOpenCodeFolders = @('pstack-opencode')
# The version of the owned list in stack.lock.json. A reader checks it before it reads owned. Version 2 names
# each record's runtime and layers, which -Remove and -Uninstall need to pick the records to delete.
$ownedSchemaVersion = 2
# The files an apply replaces with its own text. Each may get a backup, and an apply records whether it created one.
$replacedFileNames = @('opencode.jsonc', '.pi/agent/settings.json')

# The text an installed profile holds once its model line is removed, or $null when the profile
# has no frontmatter, which leaves the copy as it is.
function Get-AgentProfileText {
    param([string] $Path)

    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    $frontmatter = [regex]::Match($text, '(?s)\A---\n.*?\n---\n')
    if (-not $frontmatter.Success) { return $null }
    $stripped = [regex]::Replace($frontmatter.Value, '(?m)^model:.*\n', '')
    return $stripped + $text.Substring($frontmatter.Length)
}

# maxstack sets no model. An installed profile keeps no model line, so the session's
# model applies; the copy from the plugin source is stripped if it carries one.
function Remove-AgentModel {
    param([string] $Path)

    $text = Get-AgentProfileText $Path
    if ($null -eq $text) { return }
    [IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Field {
    param($Object, [string] $Name)

    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Test-NonEmptyString {
    param($Value)

    return (($Value -is [string]) -and $Value.Trim().Length -gt 0)
}

function Test-RelativePath {
    param($Value)

    return ((Test-NonEmptyString $Value) -and -not [IO.Path]::IsPathRooted($Value) -and $Value -notmatch '(^|[\\/])\.\.([\\/]|$)')
}

function Get-TextSha256 {
    param([string] $Text)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $stream = New-Object IO.MemoryStream(, $bytes)
    return (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
}

# Reports whether the config file is missing, differs from the text the installer
# would write, or matches it. Audit mode uses it and writes nothing.
function Get-DriftState {
    param([string] $Path, [string] $Text)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'missing' }
    if (([IO.File]::ReadAllText($Path)).Trim() -eq $Text.Trim()) { return 'matches' }
    return 'differs'
}

function Read-LayerJson {
    param([string] $Root)

    $layerJson = Join-Path $Root 'layer.json'
    if (-not (Test-Path -LiteralPath $layerJson -PathType Leaf)) { return $null }
    return (Get-Content -LiteralPath $layerJson -Raw | ConvertFrom-Json)
}

# Turns one layers.json entry into the record the rest of the installer reads. A
# string source is a local checkout at path; an object source is a git pin.
function New-LayerModel {
    param($Raw)

    $name = Get-Field $Raw 'name'
    if (-not (Test-NonEmptyString $name) -or $name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "Layer name '$name' must be a non-empty folder-safe name."
    }
    $kind = Get-Field $Raw 'kind'
    if ($kind -notin @('plugin', 'config')) { throw "Layer '$name' kind must be plugin or config." }

    $runtimes = @{}
    $runtimeBlock = Get-Field $Raw 'runtimes'
    if ($null -ne $runtimeBlock) {
        foreach ($property in $runtimeBlock.PSObject.Properties) {
            if ($property.Name -notin $runtimeNames) { throw "Layer '$name' names an unknown runtime '$($property.Name)'." }
            $runtimes[$property.Name] = $property.Value
        }
    }

    $source = Get-Field $Raw 'source'
    $path = $null
    $defaultUrl = $null
    $defaultRef = $null
    $sourcePath = '.'
    $commit = $null
    if ($source -is [string]) {
        $path = Get-Field $Raw 'path'
        if (-not (Test-RelativePath $path)) { throw "Layer '$name' needs a relative checkout path." }
        $defaultUrl = $source
    } elseif ($null -ne $source) {
        if ($kind -ne 'plugin') { throw "Layer '$name' is pinned to a git source, so its kind must be plugin." }
        $defaultUrl = Get-Field $source 'url'
        $sourcePath = Get-Field $source 'path'
        $commit = Get-Field $source 'commit'
        $defaultRef = Get-Field $source 'ref'
        if (-not (Test-NonEmptyString $defaultUrl)) { throw "Layer '$name' source needs a url." }
        if (-not (Test-RelativePath $sourcePath)) { throw "Layer '$name' source.path must be a relative path inside the repository." }
        if (-not (Test-NonEmptyString $commit) -or $commit -cnotmatch '^[0-9a-f]{40}$') {
            throw "Layer '$name' source.commit must be a 40-character lowercase commit SHA."
        }
    } else {
        throw "Layer '$name' needs a source."
    }

    if ($runtimes.ContainsKey('copilot') -and -not $runtimes.ContainsKey('claude')) {
        throw "Layer '$name' declares copilot, which loads the Claude plugin folder, so it also needs claude."
    }
    if ($runtimes.ContainsKey('pi') -and -not $runtimes.ContainsKey('claude')) {
        throw "Layer '$name' declares pi, which lists the Claude plugin folder's skills, so it also needs claude."
    }
    if ($runtimes.ContainsKey('claude') -and $null -ne $path -and -not $runtimes.ContainsKey('opencode')) {
        throw "Layer '$name' declares claude from a local checkout, which links to its OpenCode copy, so it also needs opencode."
    }

    return [pscustomobject]@{
        name          = $name
        kind          = $kind
        # The default source, from layers.json. defaultGit is true for a git pin, and false for a local checkout at path.
        defaultGit    = ($source -isnot [string]) -and ($null -ne $source)
        defaultUrl    = $defaultUrl
        defaultRef    = $defaultRef
        defaultCommit = $commit
        path          = $path
        # The folder inside the repository the plugin lives in. '.' names the whole repository.
        sourcePath    = $sourcePath
        # The runtimes the manifest declares. runtimes narrows to the selection, and declared keeps the
        # item lists a copy needs even when opencode is not selected.
        declared      = $runtimes
        runtimes      = $runtimes
        # The effective source for this run, set by Set-LayerChoice. url is set only for a git source.
        sourceKind    = $null
        url           = $null
        recordUrl     = $null
        ref           = $null
        commit        = $null
        dirty         = $null
        override      = $false
        localPath     = $null
        folderMissing = $false
        repoRoot      = $null
        root          = $null
    }
}

# Where OpenCode finds the entry. A plugin folder's index.ts loads from the folder itself.
# Any other entry is named in opencode.jsonc, which takes a folder that holds the entry.
function Get-OpenCodeSpec {
    param($Layer)

    $runtime = $Layer.runtimes['opencode']
    $entry = Get-Field $runtime 'entry'
    if ($null -eq $entry) { $entry = 'index.ts' }
    if (-not (Test-RelativePath $entry) -or $entry -notmatch '\.(ts|js)$') {
        throw "Layer '$($Layer.name)' opencode.entry must be a relative .ts or .js file."
    }
    $entry = $entry.Replace('\', '/')
    $slash = $entry.LastIndexOf('/')
    $dir = if ($slash -lt 0) { '' } else { $entry.Substring(0, $slash) }
    if ($dir -eq '' -and $entry -ne 'index.ts') {
        throw "Layer '$($Layer.name)' has the root entry $entry. Only index.ts loads from the plugin folder itself; put other entries in a subfolder."
    }
    $agents = Get-Field $runtime 'agents'
    if ($null -ne $agents -and -not (Test-RelativePath $agents)) {
        throw "Layer '$($Layer.name)' opencode.agents must be a relative folder."
    }
    return [pscustomobject]@{
        entry  = $entry
        dir    = $dir
        loader = $(if ($dir -eq '') { 'discovery' } else { 'config' })
        agents = $agents
    }
}

# The items copied into the installed plugin folder. A layer names them under
# runtimes.opencode.files, or in its layer.json files list.
function Get-OpenCodeItems {
    param($Layer, [string] $Root)

    $files = Get-Field $Layer.declared['opencode'] 'files'
    if ($null -eq $files) { $files = Get-Field (Read-LayerJson $Root) 'files' }
    if ($null -eq $files -or @($files).Count -eq 0) {
        throw "Layer '$($Layer.name)' names no OpenCode files: set runtimes.opencode.files, or add a layer.json with files."
    }
    return @($files)
}

# The entry path opencode.jsonc names for a nested entry, relative to the config file.
# A root index.ts loads from its folder without a config entry, so it has none.
function Get-OpenCodePluginPath {
    param($Layer, $Spec)

    if ($Spec.loader -ne 'config') { return $null }
    return "./.opencode/plugins/$($Layer.name)/$($Spec.dir)"
}

# Whether an installed OpenCode folder is missing, or matches what the last apply
# recorded. Audit uses it, so it never writes.
function Get-OpenCodeState {
    param([string] $EntryPath, $Prior, [string] $Entry, $Plugin)

    if (-not (Test-Path -LiteralPath $EntryPath -PathType Leaf)) { return 'missing' }
    if ($null -eq $Prior -or (Get-Field $Prior 'entry') -ne $Entry -or (Get-Field $Prior 'plugin') -ne $Plugin) { return 'differs' }
    return 'matches'
}

# Turns one layer's claude runtime into a record. A local layer is a junction under
# .claude\plugins to its installed copy in .opencode\plugins, so both harnesses share
# one copy. Without the opencode runtime there is no such copy, so a local layer is copied
# from its items. A git layer is a copy of its pinned folder.
function Get-ClaudeRecord {
    param($Layer)

    if (-not $Layer.runtimes.ContainsKey('claude')) { return $null }
    if ($null -ne $Layer.url) {
        return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'git'; url = $Layer.url; path = $Layer.sourcePath; commit = $Layer.commit }
    }

    # A local folder that is missing has no manifest or items to read. A junction needs neither, and a copy is unknown.
    if ($null -eq $Layer.root) {
        if ($Layer.runtimes.ContainsKey('opencode')) {
            return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'junction'; target = ".opencode/plugins/$($Layer.name)" }
        }
        return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'copy'; items = $null }
    }
    $manifestPath = Join-Path $Layer.root '.claude-plugin\plugin.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Layer '$($Layer.name)' has a claude runtime but no .claude-plugin\plugin.json at $($Layer.root). Add the manifest to that repository or remove its claude runtime."
    }
    $declared = Get-Field (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json) 'name'
    if ($declared -ne $Layer.name) {
        throw "Layer '$($Layer.name)' is the Claude plugin '$($Layer.name)' but its .claude-plugin\plugin.json names '$declared'."
    }
    $items = @(Get-OpenCodeItems -Layer $Layer -Root $Layer.root)
    if ($items -notcontains '.claude-plugin') {
        # A layer pinned in layers.json is a whole folder for Claude, whatever its OpenCode items name, so a local
        # checkout of it (-Source pstack=local:...) is copied whole too. Any other layer must name the manifest.
        if ($Layer.defaultGit) {
            return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'copy'; items = $null }
        }
        throw "Layer '$($Layer.name)' has a claude runtime but its file list omits .claude-plugin, so the installed copy would not carry the manifest."
    }
    if (-not $Layer.runtimes.ContainsKey('opencode')) {
        return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'copy'; items = $items }
    }
    return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'junction'; target = ".opencode/plugins/$($Layer.name)" }
}

# The folders directly under .opencode\plugins that no current layer names.
function Get-StalePluginFolders {
    param([string[]] $Wanted)

    if (-not (Test-Path -LiteralPath $opencodePluginsTarget -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $opencodePluginsTarget -Directory -Force | Where-Object { $Wanted -notcontains $_.Name })
}

function Test-ClaudeJunction {
    param([string] $Child, [string] $Target)

    $item = Get-Item -LiteralPath $Child -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.LinkType -ne 'Junction') { return $false }
    $linked = @($item.Target)[0]
    return ([bool]$linked -and (Get-NormalPath $linked) -eq (Get-NormalPath $Target))
}

# Removes a junction by deleting the link itself, which never touches its target.
# Anything else at the path is ours, a materialised copy, and is removed in full.
function Remove-ClaudeChild {
    param([string] $Path)

    Remove-OwnedTree $Path
}

# Whether a path is a junction or a symbolic link. The walk lists such a path and never reads
# what it points to.
function Test-ReparsePoint {
    param([string] $Path)

    return [bool]([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint)
}

# The target a link names, without the \?\ or \??\ prefix that the Windows API adds, so
# PowerShell and Python write the same text for one junction.
function Get-LinkTargetText {
    param([string] $Path)

    $text = [string] (@((Get-Item -LiteralPath $Path -Force).Target)[0])
    foreach ($prefix in @('\?\', '\??\')) {
        if ($text.StartsWith($prefix, [StringComparison]::Ordinal)) { $text = $text.Substring($prefix.Length) }
    }
    return $text.TrimEnd('\')
}

# The folders a tree hash leaves out, by the path relative to the tree root. The legacy rule is
# the one the claude tree hashes have always used: the top-level node_modules, matched without
# regard to case, because PowerShell's -ne did that. The owned rule leaves out node_modules and
# .git at any depth, exactly, because npm and git write those beside what the installer copies. The lock
# npm writes is not left out: Resolve-NpmLocks settles it, so the folder holds only what the layer ships.
function Test-TreeFolderExcluded {
    param([string] $Relative, [string] $Rule)

    if ($Rule -eq 'legacy') { return ($Relative -imatch '^node_modules$') }
    return ($Relative -cmatch '(^|/)(node_modules|\.git)$')
}

# The entries of a tree, each with its path relative to the root in forward slashes. A link is
# listed with its target and never followed, so a junction cannot pull outside content in, and a
# junction that loops back cannot make the walk run forever. The root itself is read even when it
# is a link: a claude child is a junction to its installed copy.
function Get-TreeEntries {
    param([string] $Root, [string] $Rule)

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($rootFull)
    $entries = [System.Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($child in [IO.Directory]::GetDirectories($directory)) {
            $relative = $child.Substring($rootFull.Length + 1).Replace('\', '/')
            if (Test-ReparsePoint $child) {
                $entries.Add([pscustomobject]@{ relative = $relative; full = $child; link = (Get-LinkTargetText $child) })
            } elseif (-not (Test-TreeFolderExcluded -Relative $relative -Rule $Rule)) {
                $pending.Push($child)
            }
        }
        foreach ($file in [IO.Directory]::GetFiles($directory)) {
            $relative = $file.Substring($rootFull.Length + 1).Replace('\', '/')
            if (Test-ReparsePoint $file) {
                $entries.Add([pscustomobject]@{ relative = $relative; full = $file; link = (Get-LinkTargetText $file) })
            } else {
                $entries.Add([pscustomobject]@{ relative = $relative; full = $file; link = $null })
            }
        }
    }
    return $entries.ToArray()
}

# One line per entry: the relative path, a tab, and the file's SHA-256, or the word link and the
# target for a link. Prefix puts the lines under a folder name, for an item copied into a folder.
function Get-EntryLines {
    param($Entries, [string] $Prefix = '')

    return @($Entries | ForEach-Object {
        $name = if ($Prefix) { "$Prefix/$($_.relative)" } else { $_.relative }
        if ($null -ne $_.link) { "$name`tlink:$($_.link)" } else { "$name`t$((Get-FileHash -LiteralPath $_.full -Algorithm SHA256).Hash)" }
    })
}

# Compares two strings by their UTF-8 bytes. That order is the code point order, so PowerShell and
# Python sort a name with any character the same way. A UTF-16 comparison would not.
function Compare-Utf8Bytes {
    param([string] $Left, [string] $Right)

    $a = [Text.Encoding]::UTF8.GetBytes($Left)
    $b = [Text.Encoding]::UTF8.GetBytes($Right)
    $count = [Math]::Min($a.Length, $b.Length)
    for ($i = 0; $i -lt $count; $i++) {
        if ($a[$i] -ne $b[$i]) { return ([int] $a[$i]) - ([int] $b[$i]) }
    }
    return $a.Length - $b.Length
}

# The one sort every list the installer writes or hashes uses.
function Sort-Utf8 {
    param([string[]] $Values)

    $list = [System.Collections.Generic.List[string]]::new()
    foreach ($value in @($Values)) { $list.Add($value) }
    $list.Sort([Comparison[string]] { param($left, $right) Compare-Utf8Bytes $left $right })
    return $list.ToArray()
}

# The top-level paths each runtime writes. A runtime that is not selected leaves whatever of these
# is on disk alone, and status names it as not selected.
$runtimeArtifacts = @{
    claude   = @('.claude/plugins')
    opencode = @('opencode.jsonc', '.opencode/plugins', '.opencode/agents')
    copilot  = @('.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh')
    pi       = @('.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh', '.pi/agent/settings.json')
}

# The names a -Runtimes or -Layers value picks. A value splits on commas, and all picks every name.
# A name outside Valid is an error that lists the valid names.
function Get-NamedValues {
    param([string[]] $Values, [string[]] $Valid, [string] $Parameter)

    $names = @($Values | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $choices = "$($Valid -join ', '), or all"
    if ($names.Count -eq 0) { throw "-$Parameter names no value. Valid names: $choices." }
    $picked = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $names) {
        if ($name -ieq 'all') { $picked.AddRange([string[]] $Valid); continue }
        $match = @($Valid | Where-Object { $_ -ieq $name })
        if ($match.Count -eq 0) { throw "-$Parameter names an unknown name '$name'. Valid names: $choices." }
        $picked.Add($match[0])
    }
    return (Sort-Utf8 @($picked | Select-Object -Unique))
}

# The selection an apply records. Named values add to the recorded set and never remove from it. An
# unnamed dimension keeps its recorded value. With no lock (Recorded is $null), an unnamed dimension is
# all of them, and a named one is exactly what is named.
function Merge-Selected {
    param([string[]] $Recorded, [string[]] $All, [string[]] $Named, [bool] $HasNames, [string] $Label)

    if (-not $HasNames) {
        if ($null -eq $Recorded) { return (Sort-Utf8 $All) }
        return (Sort-Utf8 $Recorded)
    }
    # A list, because an if-expression unrolls a single name into a string, and a string plus a string concatenates.
    $merged = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $Recorded) { $merged.AddRange([string[]] $Recorded) }
    $added = @($Named | Where-Object { $merged -cnotcontains $_ })
    if ($null -ne $Recorded -and $added.Count -eq 0) {
        Write-Host "Already selected $($Label): $($Named -join ', '). Flags never narrow the selection; the rest stay selected."
    }
    $merged.AddRange([string[]] $Named)
    return (Sort-Utf8 @($merged | Select-Object -Unique))
}

# Fails when copilot or pi is selected without claude. Their wrapper or settings name the Claude
# plugin folders, and only the claude runtime writes them.
function Assert-SelectionRuntimes {
    param([string[]] $Runtimes)

    foreach ($dependent in @('copilot', 'pi')) {
        if (($Runtimes -contains $dependent) -and ($Runtimes -notcontains 'claude')) {
            throw "Runtime '$dependent' needs claude: its wrapper or settings name the Claude plugin folders, so select claude with it."
        }
    }
}

# The recorded names that are still valid. A malformed or repeated name is refused. A name that
# layers.json or the runtimes no longer name, such as a layer removed from layers.json, is dropped with
# a warning, so the normal stale cleanup removes what it installed. If nothing recorded is still valid,
# the list is all of them, as for a new lock.
function Get-RecordedNames {
    param($Names, [string[]] $Valid, [string] $Kind)

    $list = @($Names)
    if ($list.Count -eq 0 -or @($list | Where-Object { -not (Test-NonEmptyString $_) }).Count -gt 0) {
        throw "stack.lock.json selection needs a list of $Kind names."
    }
    if (@($list | Select-Object -Unique).Count -ne $list.Count) { throw "stack.lock.json selection names a $Kind twice." }
    foreach ($name in @($list | Where-Object { $Valid -cnotcontains $_ })) {
        Write-Warning "The recorded selection names the $Kind '$name', which is no longer in layers.json. It is dropped from the selection, and the next apply removes what it installed."
    }
    $known = @($list | Where-Object { $Valid -ccontains $_ })
    if ($known.Count -eq 0) { return @(Sort-Utf8 $Valid) }
    return @(Sort-Utf8 $known)
}

# The selection a lock records. A lock with no selection predates it, and means every runtime and
# layer. $null means there is no lock, so the first apply starts a selection.
function Read-RecordedSelection {
    param($Stack, [string[]] $LayerNames)

    if ($null -eq $Stack) { return $null }
    $recorded = Get-Field $Stack 'selection'
    if ($null -eq $recorded) { return @{ runtimes = (Sort-Utf8 $runtimeNames); layers = (Sort-Utf8 $LayerNames) } }
    return @{
        runtimes = (Get-RecordedNames -Names (Get-Field $recorded 'runtimes') -Valid $runtimeNames -Kind 'runtime')
        layers   = (Get-RecordedNames -Names (Get-Field $recorded 'layers') -Valid $LayerNames -Kind 'layer')
    }
}

function Format-Selection {
    param([string[]] $Runtimes, [string[]] $Layers)

    return "Selection: runtimes $($Runtimes -join ', '); layers $($Layers -join ', ')"
}

# The lock an earlier apply wrote. A lock that is empty, null, or truncated is refused with what to do
# and what deleting it would cost, so apply, audit, and status all say the same thing.
function Read-PriorLock {
    $text = Get-Content -LiteralPath $stackTarget -Raw
    $parsed = $null
    if (-not [string]::IsNullOrWhiteSpace($text)) {
        try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null }
    }
    if ($parsed -is [pscustomobject]) { return $parsed }
    throw ("$stackTarget is empty, null, or truncated, so its selection and created-paths record cannot be read. " +
        "Restore it from $stackTarget.bak if that file exists and reads, or repair it by hand. " +
        "Deleting $stackTarget instead resets the selection to all runtimes and layers and loses the createdDirs and createdFiles record. " +
        "Keep $stackTarget.bak either way: it holds the lock the last apply replaced.")
}

# The lock is replaced whole. Its text goes to a temporary file beside it, which then replaces the lock, so
# an interrupted write leaves the previous lock as it was. The replaced lock is kept as stack.lock.json.bak.
function Write-LockAtomically {
    param([string] $Text)

    $temp = "$stackTarget.new"
    [IO.File]::WriteAllText($temp, $Text, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $stackTarget -PathType Leaf) {
        [IO.File]::Replace($temp, $stackTarget, "$stackTarget.bak")
    } else {
        [IO.File]::Move($temp, $stackTarget)
    }
}

# The layers and runtimes layers.json names that the selection leaves out. Each note names the flag that adds
# it, so an apply, an audit, and a status all say that a new layer or runtime is not installed yet.
function Get-UnselectedNotes {
    param([object[]] $AllLayers, [string[]] $SelectedLayers, [string[]] $SelectedRuntimes)

    $notes = [System.Collections.Generic.List[pscustomobject]]::new()
    foreach ($layer in $AllLayers) {
        if ($SelectedLayers -notcontains $layer.name) {
            $notes.Add([pscustomobject]@{ kind = 'layer'; name = $layer.name; flag = '-Layers' })
        }
    }
    $declared = @($AllLayers | ForEach-Object { $_.declared.Keys } | Select-Object -Unique)
    foreach ($runtime in $runtimeNames) {
        if (($declared -contains $runtime) -and ($SelectedRuntimes -notcontains $runtime)) {
            $notes.Add([pscustomobject]@{ kind = 'runtime'; name = $runtime; flag = '-Runtimes' })
        }
    }
    return $notes.ToArray()
}

# The runtime an owned path belongs to. The claude cache is the source every runtime copies from, so
# it belongs to none and is never judged by the selection.
function Get-OwnedRuntime {
    param([string] $Path)

    if ($Path.StartsWith('opencode.jsonc', [StringComparison]::Ordinal) -or $Path.StartsWith('.opencode/', [StringComparison]::Ordinal)) { return 'opencode' }
    if ($Path.StartsWith('.claude/plugins/', [StringComparison]::Ordinal)) { return 'claude' }
    if ($Path -in @('.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh')) { return 'copilot' }
    if ($Path.StartsWith('.maxstack/bin/pi.', [StringComparison]::Ordinal) -or $Path.StartsWith('.pi/', [StringComparison]::Ordinal)) { return 'pi' }
    return $null
}

# The artifacts of the runtimes that are not selected and that exist on disk. Status names them.
function Get-NotSelectedPaths {
    param([string[]] $SelectedRuntimes)

    $found = [System.Collections.Generic.List[string]]::new()
    foreach ($runtime in $runtimeNames) {
        if ($SelectedRuntimes -contains $runtime) { continue }
        foreach ($path in $runtimeArtifacts[$runtime]) {
            if (Test-Path -LiteralPath (Join-Path $Workspace ($path -replace '/', '\'))) { $found.Add($path) }
        }
    }
    return (Sort-Utf8 $found.ToArray())
}

# The lock files npm writes beside a layer's package.json. npm writes into a shrinkwrap the layer ships, and otherwise
# into package-lock.json, or it generates npm-shrinkwrap.json. Both are the installer's output, so the folder must
# hold only what the layer ships.
$npmLockNames = @('package-lock.json', 'npm-shrinkwrap.json')

# The lock files of a folder before npm runs: the bytes of each one the layer ships, and $null for each one it does not.
# A file here before npm runs came from the layer's items, so it is the layer's and not npm's.
function Get-ShippedLocks {
    param([string] $Folder)

    $shipped = @{}
    foreach ($name in $npmLockNames) {
        $shipped[$name] = $null
        $path = Join-Path $Folder $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { $shipped[$name] = [IO.File]::ReadAllBytes($path) }
    }
    return $shipped
}

# Puts back the bytes a layer ships. A file that already holds them is not written, so a read-only shipped file stays
# as it is. Otherwise the read-only attribute is cleared for the write, and set again after it.
function Set-ShippedFile {
    param([string] $Path, [byte[]] $Bytes)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        [IO.File]::WriteAllBytes($Path, $Bytes)
        return
    }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Path)) -eq [Convert]::ToBase64String($Bytes)) { return }
    $attributes = [IO.File]::GetAttributes($Path)
    [IO.File]::SetAttributes($Path, [IO.FileAttributes]::Normal)
    [IO.File]::WriteAllBytes($Path, $Bytes)
    [IO.File]::SetAttributes($Path, $attributes)
}

# Each npm lock file ends as the layer ships it: a shipped one is put back as shipped, and one npm wrote is removed.
function Resolve-NpmLocks {
    param([string] $Folder, [hashtable] $Shipped)

    foreach ($name in $npmLockNames) {
        $path = Join-Path $Folder $name
        if ($null -ne $Shipped[$name]) {
            Set-ShippedFile -Path $path -Bytes $Shipped[$name]
            continue
        }
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-OwnedTree $path
            Write-Host "Removed ${path}: npm wrote it, and the layer does not ship $name"
        }
    }
}

# npm runs with --ignore-scripts, so a layer's own install scripts and a native build (a binding.gyp) do not run. Each
# layer that declares one is named when npm runs, so the change in what gets installed shows in that run's output.
function Write-IgnoredScriptWarning {
    param([string] $Name, [string] $Folder)

    $declared = @()
    $package = Join-Path $Folder 'package.json'
    if (Test-Path -LiteralPath $package -PathType Leaf) {
        $scripts = Get-Field (Get-Content -LiteralPath $package -Raw | ConvertFrom-Json) 'scripts'
        $declared = @(@('preinstall', 'install', 'postinstall') | Where-Object { $null -ne (Get-Field $scripts $_) } | ForEach-Object { "scripts.$_" })
    }
    if (Test-Path -LiteralPath (Join-Path $Folder 'binding.gyp') -PathType Leaf) { $declared += 'binding.gyp' }
    if ($declared.Count -eq 0) { return }
    Write-Warning "npm ran with --ignore-scripts for layer '$Name': its $($declared -join ', ') did not run, so what it would build or install is missing."
}

# Copies the named items of a layer root into a folder. A claude copy of a local layer holds the same
# items as its OpenCode copy, and never the rest of the checkout.
function Copy-LayerItems {
    param([string] $Root, [string[]] $Items, [string] $Destination)

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in $Items) {
        $source = Join-Path $Root ($item -replace '/', '\')
        if (-not (Test-Path -LiteralPath $source)) { throw "Layer item missing: $source" }
        $target = Join-Path $Destination ($item -replace '/', '\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    }
}

# Copies a whole layer folder for Claude. A repository root holds the cache's .git, which is not part of the plugin.
function Copy-WholeFolder {
    param([string] $Root, [string] $Destination)

    Copy-Item -LiteralPath $Root -Destination $Destination -Recurse -Force
    $git = Join-Path $Destination '.git'
    if (Test-Path -LiteralPath $git) { Remove-OwnedTree $git }
}

# The hash of a tree from its lines: sorted, one line per entry, then the SHA-256 of that text.
function Get-TreeLinesSha256 {
    param([string[]] $Lines)

    return (Get-TextSha256 ((@(Sort-Utf8 $Lines) -join "`n") + "`n"))
}

# The owned hash of a folder: every entry under it, under the owned rule. A folder the installer
# owns is wholly its own, so each file a user adds to it changes this hash.
function Get-TreeSha256 {
    param([string] $Root)

    return (Get-TreeLinesSha256 (Get-EntryLines (Get-TreeEntries -Root $Root -Rule 'owned')))
}

# The legacy hash of a claude child, under the legacy rule. Lock values written before the owned
# record use it, so it stays the rule for treeSha256 in stack.lock.json.
function Get-LegacyTreeSha256 {
    param([string] $Root)

    return (Get-TreeLinesSha256 (Get-EntryLines (Get-TreeEntries -Root $Root -Rule 'legacy')))
}

# The owned hash a folder holds once the named items are copied from a layer root, so the status
# report can compare it without copying. $null when an item is missing from the root.
function Get-ItemsTreeSha256 {
    param([string] $Root, [string[]] $Items)

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($item in $Items) {
        $name = $item.Replace('\', '/')
        if (Test-TreeFolderExcluded -Relative $name -Rule 'owned') { continue }
        $source = Join-Path $Root ($item -replace '/', '\')
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $lines.AddRange([string[]] (Get-EntryLines @([pscustomobject]@{ relative = $name; full = $source; link = $null })))
        } elseif (Test-Path -LiteralPath $source -PathType Container) {
            $lines.AddRange([string[]] (Get-EntryLines (Get-TreeEntries -Root $source -Rule 'owned') $name))
        } else {
            return $null
        }
    }
    return (Get-TreeLinesSha256 $lines.ToArray())
}

# Brings the layer's cache to the pinned commit and returns the cache path. The cache
# is named for the layer, and its origin is set to the layer's url on every sync, so a
# cache cloned from another remote is never fetched from. A partial, sparse clone keeps
# only the plugin folder. Once the commit is in the cache, no network is used.
function Sync-GitPlugin {
    param($Layer)

    $cache = Join-Path $claudeCacheTarget $Layer.name
    if (-not (Test-Path -LiteralPath (Join-Path $cache '.git'))) {
        New-Item -ItemType Directory -Path $claudeCacheTarget -Force | Out-Null
        Write-Host "Cloning $($Layer.url) (partial, sparse) into $cache"
        & git @(Get-GitGuardArgs) clone --quiet --filter=blob:none --no-checkout --sparse -- $Layer.url $cache
        if ($LASTEXITCODE -ne 0) { throw "git clone of $($Layer.url) failed for '$($Layer.name)'." }
        & git @(Get-GitGuardArgs) -C $cache config core.autocrlf false
        & git @(Get-GitGuardArgs) -C $cache config core.eol lf
    }
    & git @(Get-GitGuardArgs) -C $cache remote set-url origin $Layer.url
    if ($Layer.sourcePath -eq '.') {
        & git @(Get-GitGuardArgs) -C $cache sparse-checkout disable
    } else {
        & git @(Get-GitGuardArgs) -C $cache sparse-checkout set $Layer.sourcePath
    }
    if ($LASTEXITCODE -ne 0) { throw "git sparse-checkout of $($Layer.sourcePath) failed in $cache." }

    & git @(Get-GitGuardArgs) -C $cache cat-file -e "$($Layer.commit)^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & git @(Get-GitGuardArgs) -C $cache fetch --quiet --filter=blob:none origin -- $Layer.commit
        if ($LASTEXITCODE -ne 0) {
            $what = if ($Layer.override) { 'commit' } else { 'pinned commit' }
            $hint = if ($Layer.override) { 'Check the -Source spec.' } else { 'Check source.commit in layers.json.' }
            throw "Could not fetch the $what $($Layer.commit) from $($Layer.url) for '$($Layer.name)'. $hint"
        }
    }
    # --end-of-options, not --: a -- before the commit would make it a pathspec.
    & git @(Get-GitGuardArgs) -C $cache -c advice.detachedHead=false checkout --quiet --detach --end-of-options $Layer.commit
    if ($LASTEXITCODE -ne 0) { throw "git checkout of $($Layer.commit) failed in $cache." }
    $head = (& git @(Get-GitGuardArgs) -C $cache rev-parse HEAD).Trim()
    if ($head -ne $Layer.commit) { throw "The cache is at $head, not the pinned $($Layer.commit) for '$($Layer.name)'." }
    # The cache holds exactly the pinned commit: a file the checkout does not track is removed, and printed.
    foreach ($line in @(& git @(Get-GitGuardArgs) -C $cache clean -ffdx)) { Write-Host "Cache $($Layer.name): $line" }
    return $cache
}

# Whether a pinned layer's cache is a checkout of the pinned commit. It reads only the local
# repository, so audit and status can tell whether the desired state is known without a fetch.
function Test-CacheAtPin {
    param($Layer)

    $cache = Join-Path $claudeCacheTarget $Layer.name
    if (-not (Test-Path -LiteralPath (Join-Path $cache '.git'))) { return $false }
    $head = & git @(Get-GitGuardArgs) -C $cache rev-parse HEAD 2>$null
    return ($LASTEXITCODE -eq 0 -and ([string] $head).Trim() -eq $Layer.commit)
}

# The folder a layer installs from: its checkout, or the pinned folder of its cache. $null when
# the cache is not at its pin yet, so the desired state cannot be known until an apply syncs it.
function Get-LayerRoot {
    param($Layer)

    if ($null -eq $Layer.url) { return $Layer.root }
    if (-not (Test-CacheAtPin $Layer)) { return $null }
    return (Join-SourceSub (Join-Path $claudeCacheTarget $Layer.name) $Layer.sourcePath)
}

# Whether a claude child is missing, differs from what the last apply recorded, or
# matches it. Audit uses it, so it never writes and never touches the network.
function Get-ClaudeChildState {
    param($Record, $Prior, [string] $Child, [string] $Target)

    $item = Get-Item -LiteralPath $Child -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return 'missing' }
    if ($Record.kind -eq 'junction') {
        if (-not (Test-ClaudeJunction -Child $Child -Target $Target)) { return 'differs' }
        if (-not (Test-Path -LiteralPath $Target -PathType Container)) { return 'differs' }
    } elseif ($item.LinkType) {
        return 'differs'
    }
    if ($null -eq $Prior -or (Get-Field $Prior 'kind') -ne $Record.kind) { return 'differs' }
    if ($Record.kind -eq 'git' -and (Get-Field $Prior 'commit') -ne $Record.commit) { return 'differs' }
    if ((Get-Field $Prior 'treeSha256') -ne (Get-LegacyTreeSha256 $Child)) { return 'differs' }
    return 'matches'
}

# Whether a wrapper can run a path. On Windows that is an .exe, .cmd, or .bat. Elsewhere a
# file has no extension to show it, so anything but a PowerShell or cmd script is a candidate.
# Get-Command finds only executable files off Windows, so a plain file with no mode bit is
# already left out. The platform is a parameter so both rules can be tested on any host.
function Test-WrapperTarget {
    param([string] $Path, [bool] $Windows)

    $extension = [IO.Path]::GetExtension($Path)
    if ($Windows) { return $extension -in @('.exe', '.cmd', '.bat') }
    return $extension -notin @('.ps1', '.cmd', '.bat')
}

# The first application named $Name that a wrapper can run, outside .maxstack\bin, so a
# generated wrapper can never wrap itself.
function Find-WrappedExecutable {
    param([string] $Name)

    $binPrefix = (Get-NormalPath $copilotBinTarget) + '\'
    $candidates = @(Get-Command -Name $Name -All -CommandType Application -ErrorAction SilentlyContinue)
    foreach ($candidate in $candidates) {
        if (-not $candidate.Source) { continue }
        if (-not (Test-WrapperTarget -Path $candidate.Source -Windows $IsWindows)) { continue }
        if ((Get-NormalPath $candidate.Source).StartsWith($binPrefix)) { continue }
        return $candidate.Source
    }
    return $null
}

# T3 spawns binaryPath directly, so a .sh wrapper must carry the executable bit off Windows.
# Windows has no mode bits to set, and the call is skipped there.
function Set-ShellExecutable {
    param([string] $Path)

    if ($IsWindows) { return }
    $mode = [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute `
        -bor [IO.UnixFileMode]::GroupRead -bor [IO.UnixFileMode]::GroupExecute `
        -bor [IO.UnixFileMode]::OtherRead -bor [IO.UnixFileMode]::OtherExecute
    [IO.File]::SetUnixFileMode($Path, $mode)
}

function Assert-QuotablePath {
    param([string[]] $Paths)

    foreach ($path in $Paths) {
        if ($path -match '["%\r\n]') { throw "Path '$path' holds a quote, a percent sign, or a line break, which the Copilot wrapper cannot quote." }
    }
}

# The Windows wrapper. A .cmd or .bat executable must run through call, or cmd.exe
# would end this script after it returns.
function New-CopilotCmdText {
    param([string] $Executable, [string[]] $PluginDirs)

    Assert-QuotablePath (@($Executable) + @($PluginDirs))
    $plugins = @($PluginDirs | ForEach-Object { " --plugin-dir ""$_""" }) -join ''
    $invoke = if ([IO.Path]::GetExtension($Executable) -in @('.cmd', '.bat')) { 'call ' } else { '' }
    $lines = @(
        '@echo off',
        'rem Generated by scripts\Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        'rem Starts the GitHub Copilot CLI with the workspace plugin folders, in layer order.',
        'rem T3 has no one to answer a hook confirmation, so the org gate ask is allowed here.',
        'rem Denials and the repo access level still apply. A plain copilot keeps the prompt.',
        'set "AGENT_ACCESS_COPILOT_ASK=allow"',
        "$invoke""$Executable""$plugins %*"
    )
    return (($lines -join "`r`n") + "`r`n")
}

# The POSIX wrapper. It runs the copilot that PATH finds, with the same plugin folders,
# using forward slashes so Git Bash passes them to the Windows executable as written.
function New-CopilotShText {
    param([string[]] $PluginDirs)

    Assert-QuotablePath $PluginDirs
    $plugins = @($PluginDirs | ForEach-Object { ' --plugin-dir "' + ($_ -replace '\\', '/') + '"' }) -join ''
    $lines = @(
        '#!/bin/sh',
        '# Generated by scripts/Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        '# Starts the GitHub Copilot CLI with the workspace plugin folders, in layer order. See copilot.cmd.',
        'export AGENT_ACCESS_COPILOT_ASK=allow',
        'command -v copilot >/dev/null 2>&1 || { echo "copilot is not on PATH" >&2; exit 127; }',
        ('exec copilot' + $plugins + ' "$@"')
    )
    return (($lines -join "`n") + "`n")
}

# The Windows Pi wrapper. It sets the workspace agent folder, so Pi's settings there load the
# layers, and runs the Pi CLI found at install time. MAXSTACK_PI_BIN names another at run time.
function New-PiCmdText {
    param([string] $Executable, [string] $AgentDir)

    Assert-QuotablePath @($Executable, $AgentDir)
    $lines = @(
        '@echo off',
        'rem Generated by scripts\Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        'rem Starts Pi with the workspace agent folder, so its settings load the pstack, org, and personal layers.',
        'rem T3 has no one to answer a hook confirmation, so the org gate ask is allowed here.',
        'rem Denials and the repo access level still apply. A plain pi keeps the prompt.',
        ('set "PI_CODING_AGENT_DIR={0}"' -f $AgentDir),
        'set "AGENT_ACCESS_PI_ASK=allow"',
        ('set "PI_BIN={0}"' -f $Executable),
        'if defined MAXSTACK_PI_BIN set "PI_BIN=%MAXSTACK_PI_BIN%"',
        'for %%F in ("%PI_BIN%") do set "PI_EXT=%%~xF"',
        'if /i "%PI_EXT%"==".cmd" goto call_pi',
        'if /i "%PI_EXT%"==".bat" goto call_pi',
        '"%PI_BIN%" %*',
        'exit /b %ERRORLEVEL%',
        ':call_pi',
        'call "%PI_BIN%" %*'
    )
    return (($lines -join "`r`n") + "`r`n")
}

# A path inside the double quotes of a POSIX script. A quote, a dollar sign, a backtick, or a
# line break (a backslash before a line break is one) would change what the shell runs. A
# percent sign is plain text to sh, so it is allowed.
function Assert-ShellPath {
    param([string[]] $Paths)

    foreach ($path in $Paths) {
        if ($path -match '["$`\r\n]') {
            throw "Path '$path' holds a double quote, a dollar sign, a backtick, or a line break, so the Pi shell wrapper cannot quote it."
        }
    }
}

# The POSIX Pi wrapper. It runs the pi that PATH finds, unless MAXSTACK_PI_BIN names another.
function New-PiShText {
    param([string] $AgentDir)

    Assert-ShellPath @($AgentDir)
    $lines = @(
        '#!/bin/sh',
        '# Generated by scripts/Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        '# Starts Pi with the workspace agent folder, so its settings load the pstack, org, and personal layers. See pi.cmd.',
        ('export PI_CODING_AGENT_DIR="' + ($AgentDir -replace '\\', '/') + '"'),
        'export AGENT_ACCESS_PI_ASK=allow',
        'pi_bin="${MAXSTACK_PI_BIN:-$(command -v pi 2>/dev/null)}"',
        '[ -n "$pi_bin" ] || { echo "pi is not on PATH" >&2; exit 127; }',
        'exec "$pi_bin" "$@"'
    )
    return (($lines -join "`n") + "`n")
}

# A layer's Pi record. A pinned layer's package is the root of its cache, because a pi key
# names paths from the repository root, and that root also holds the package.json. A local
# layer's package is its installed Claude folder. The skills folder is the installed one.
# pending is set when a pinned layer's cache is not synced yet, which only audit sees.
function Get-PiLayerRecord {
    param($Layer)

    if (-not $Layer.runtimes.ContainsKey('pi')) { return $null }
    $pinned = $null -ne $Layer.url
    $repo = if ($pinned) { Join-Path $claudeCacheTarget $Layer.name } else { $Layer.repoRoot }
    $pluginSource = Join-SourceSub $repo $Layer.sourcePath
    $manifest = [IO.Path]::Combine($repo, 'package.json')
    $piKey = $null
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $piKey = Get-Field (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json) 'pi'
    }
    $installed = ".claude/plugins/$($Layer.name)"
    # The pi key names paths from the repository root, and the installed copy of a folder inside a repository has
    # no package.json at its root. Only a package at the repository root can be the Pi package, so a local source
    # with a subfolder keeps the skills folder and loses the rest of the key.
    if (($null -ne $piKey) -and -not $pinned -and ($Layer.sourcePath -ne '.')) {
        Write-Warning "Layer '$($Layer.name)' is a local source with the folder $($Layer.sourcePath). Its package.json pi key names the repository root, so Pi gets its skills folder only, not the pi key's other entries."
        $piKey = $null
    }
    return [pscustomobject]@{
        layer   = $Layer.name
        pi      = $piKey
        package = $(if ($null -ne $piKey) { if ($pinned) { ".claude/cache/$($Layer.name)" } else { $installed } } else { $null })
        skills  = $(if (Test-Path -LiteralPath ([IO.Path]::Combine($pluginSource, 'skills')) -PathType Container) { "$installed/skills" } else { $null })
        # The package and skills are unknown while the layer has no root: a git cache not at its pin, or a missing folder.
        pending = ($null -eq $Layer.root)
        unknownPackage = $(if ($pinned) { ".claude/cache/$($Layer.name)" } else { $installed })
        unknownSkills  = "$installed/skills"
    }
}

# Every path a pi key names must exist in the installed copy, or Pi would load less than the
# layer declares. A local layer that names pi files it does not list in its files fails here.
function Assert-PiKeyInstalled {
    param($Record)

    $installed = Join-Path $Workspace ($Record.package -replace '/', '\')
    if (-not (Test-Path -LiteralPath (Join-Path $installed 'package.json') -PathType Leaf)) {
        throw "Layer '$($Record.layer)' has a pi key in its package.json, but its installed copy at $installed has no package.json. Add package.json to the layer's files list."
    }
    foreach ($kind in @('extensions', 'skills', 'prompts', 'themes')) {
        foreach ($entry in @(Get-Field $Record.pi $kind)) {
            if (-not (Test-NonEmptyString $entry)) { continue }
            if (-not (Test-Path -LiteralPath (Join-Path $installed ($entry -replace '/', '\')))) {
                throw "Layer '$($Record.layer)' names the $kind entry $entry in its package.json pi key, but $installed does not carry it. Add the folder to the layer's files list."
            }
        }
    }
}

# The canonical text of one Pi entry, so a string or an object compares by what it says.
function Get-PiEntryKey {
    param($Entry)

    return (ConvertTo-Json -InputObject $Entry -Compress -Depth 20)
}

# The Pi settings are edited with System.Text.Json, which keeps every string, null, number, and key order exactly.
# ConvertFrom-Json and ConvertTo-Json convert dates, drop nulls, and cap the depth, so they are not used to write.
# A file with comments or trailing commas is not strict JSON, and the installer does not rewrite it.
function New-StrictJsonDocumentOptions {
    $options = [System.Text.Json.JsonDocumentOptions]::new()
    $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
    $options.AllowTrailingCommas = $false
    $options.MaxDepth = 1024
    return $options
}

function New-JsonWriteOptions {
    $options = [System.Text.Json.JsonSerializerOptions]::new()
    $options.WriteIndented = $true
    $options.MaxDepth = 1024
    $options.Encoder = [System.Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping
    return $options
}

# The object a settings text holds. Text that is not strict JSON, or is not an object, throws 'not strict JSON'.
function Read-StrictJsonObject {
    param([string] $Text)

    if ($Text.Trim().Length -eq 0) { return , [System.Text.Json.Nodes.JsonObject]::new() }
    try {
        $node = [System.Text.Json.Nodes.JsonNode]::Parse($Text, [System.Text.Json.Nodes.JsonNodeOptions]::new(), (New-StrictJsonDocumentOptions))
    } catch {
        throw 'not strict JSON'
    }
    if ($node -isnot [System.Text.Json.Nodes.JsonObject]) { throw 'not a JSON object' }
    return , $node
}

# The text an entry is compared by: a string by its value, anything else by its canonical JSON.
function Get-JsonEntryKey {
    param($Node)

    if ($null -eq $Node) { return 'null' }
    if ($Node -is [System.Text.Json.Nodes.JsonValue] -and $Node.GetValueKind() -eq [System.Text.Json.JsonValueKind]::String) {
        return 's:' + $Node.GetValue[string]()
    }
    return 'j:' + $Node.ToJsonString((New-JsonWriteOptions))
}

# The same key for an entry read from stack.lock.json, which PowerShell holds as an object.
function Get-JsonEntryKeyFromPs {
    param($Entry)

    if ($null -eq $Entry) { return 'null' }
    if ($Entry -is [string]) { return 's:' + $Entry }
    return Get-JsonEntryKey ([System.Text.Json.Nodes.JsonNode]::Parse((ConvertTo-Json -InputObject $Entry -Compress -Depth 50)))
}

# The value of one property of a JSON object, or $null when the object has none.
function Get-JsonProperty {
    param($Root, [string] $Key)

    $node = $null
    if ($Root.TryGetPropertyValue($Key, [ref] $node)) { return , $node }
    return $null
}

# Adds a property to a JSON object. Only a key the object lacks is added, so an existing key keeps its place.
function Set-JsonProperty {
    param($Root, [string] $Key, $Value)

    $Root.Add($Key, $Value)
}

# One Pi list in place. Each recorded entry accounts for one copy of itself: the installer removes that copy and
# writes the entry again as its own. A copy the user wrote beside it stays, and a wanted entry the user already
# lists, with no record of its own, stays the user's. The list is created when the key is absent.
function Merge-JsonEntries {
    param($Root, [string] $Key, [string[]] $Wanted, [object[]] $Owned)

    $list = (Get-JsonProperty -Root $Root -Key $Key) -as [System.Text.Json.Nodes.JsonArray]
    if ($null -eq $list) {
        $list = [System.Text.Json.Nodes.JsonArray]::new()
        Set-JsonProperty -Root $Root -Key $Key -Value $list
    }
    $ownedKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Owned | Where-Object { $null -ne $_ })) {
        $entryKey = Get-JsonEntryKeyFromPs $entry
        $ownedKeys.Add($entryKey) | Out-Null
        for ($index = 0; $index -lt $list.Count; $index++) {
            if ((Get-JsonEntryKey $list[$index]) -ceq $entryKey) { $list.RemoveAt($index); break }
        }
    }
    $present = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($node in $list) { $present.Add((Get-JsonEntryKey $node)) | Out-Null }
    $added = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $Wanted) {
        $entryKey = 's:' + $entry
        if ($ownedKeys.Contains($entryKey) -or -not $present.Contains($entryKey)) {
            $list.Add([System.Text.Json.Nodes.JsonValue]::Create([string] $entry))
            $added.Add($entry)
        }
    }
    return $added.ToArray()
}

# Writes text to a path through a temporary file, so an interrupted write leaves the old file whole.
function Write-FileAtomically {
    param([string] $Path, [string] $Text)

    $temp = "$Path.maxstack-tmp"
    $old = "$Path.maxstack-old"
    try {
        [IO.File]::WriteAllText($temp, $Text, (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            if (Test-Path -LiteralPath $old) { [IO.File]::Delete($old) }
            [IO.File]::Replace($temp, $Path, $old)
            if (Test-Path -LiteralPath $old) { [IO.File]::Delete($old) }
        } else {
            [IO.File]::Move($temp, $Path)
        }
    } finally {
        if (Test-Path -LiteralPath $temp -PathType Leaf) { [IO.File]::Delete($temp) }
    }
}

# The SHA-256 of a file, or $null when it is absent. Compared before a write, so a file changed after planning is not overwritten.
function Get-FileSha256OrNull {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-UnchangedSince {
    param([string] $Path, $PlannedSha)

    if ((Get-FileSha256OrNull $Path) -ne $PlannedSha) {
        throw "$Path changed after the install planned its text, so nothing was written to it. Rerun -Apply."
    }
}

# The Pi entries a previous apply recorded as its own under one key. A lock written before the
# ownership record has no record, so the entries its pi section listed under that key stand in.
function Get-OwnedPiEntries {
    param($Owned, $LegacyPi, [string] $Key)

    if ($null -eq $Owned) { return @(Get-Field $LegacyPi $Key) }
    $record = @($Owned | Where-Object { $_.kind -eq 'json-entries' -and $_.path -eq '.pi/agent/settings.json' -and $_.key -eq $Key })
    if ($record.Count -eq 0) { return @() }
    return @($record[0].entries)
}

# The workspace Pi settings the installer would write, and the entries it adds to each list. packages and skills are
# the only keys the installer owns; every other key is written back exactly as it was. A file that is not strict
# JSON is refused, with nothing written.
function Get-PiSettings {
    param([string[]] $Packages, [string[]] $Skills, [object[]] $OwnedPackages, [object[]] $OwnedSkills)

    $sourceSha = Get-FileSha256OrNull $piSettingsTarget
    $root = [System.Text.Json.Nodes.JsonObject]::new()
    if ($null -ne $sourceSha) {
        try {
            $root = Read-StrictJsonObject ([IO.File]::ReadAllText($piSettingsTarget))
        } catch {
            throw "$piSettingsTarget is not strict JSON ($($_.Exception.Message)): it has comments, trailing commas, or is not an object. The installer will not rewrite it. Remove those, then rerun -Apply."
        }
    }
    $added = [ordered]@{}
    $added['packages'] = @(Merge-JsonEntries -Root $root -Key 'packages' -Wanted $Packages -Owned $OwnedPackages)
    $added['skills'] = @(Merge-JsonEntries -Root $root -Key 'skills' -Wanted $Skills -Owned $OwnedSkills)
    return [pscustomobject]@{
        text      = $root.ToJsonString((New-JsonWriteOptions)) + "`n"
        added     = $added
        sourceSha = $sourceSha
    }
}

# The backup an apply takes before it replaces a file with its text. X.bak is the original: the file the install
# first replaced, and the only copy a removal restores. X.bak.N holds a copy of a live file the installer no longer
# owns: a hand edit, or a file that was there before an install with no lock. An installer's own last write is
# replaced without a copy, and a file the installer created gets no original. An X.bak the installer did not write
# is the user's: it stays where it is, and the live file gets a numbered copy as the original.
# A copy whose bytes an earlier backup already holds is not written again: the action is duplicate.
function Get-BackupTarget {
    param([string] $Path, $LastSha, [string] $NewText, [bool] $Created, $RecordedOriginalSha = $null)

    $none = [pscustomobject]@{ action = 'none'; path = $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $none }
    if (([IO.File]::ReadAllText($Path)).Trim() -eq $NewText.Trim()) { return $none }
    $current = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($LastSha -and $current -eq $LastSha) { return $none }
    $original = "$Path.bak"
    $hasOriginal = Test-Path -LiteralPath $original -PathType Leaf
    # An interrupted removal restored the original and stopped before its lock write: the lock still records the original,
    # and the live file holds its bytes. The live file is the original again, so it is written back as the original.
    if (-not $hasOriginal -and $null -ne $RecordedOriginalSha -and $current -eq $RecordedOriginalSha) {
        return [pscustomobject]@{ action = 'original'; path = $original }
    }
    if ($null -eq $LastSha) {
        if ($Created) { return $none }
        if (-not $hasOriginal) { return [pscustomobject]@{ action = 'original'; path = $original } }
        return [pscustomobject]@{ action = 'original'; path = (Get-NextBackupPath $Path) }
    }
    $earlier = Get-BackupWithSha -Path $Path -Sha256 $current
    if ($null -ne $earlier) { return [pscustomobject]@{ action = 'duplicate'; path = $earlier } }
    return [pscustomobject]@{ action = 'edited'; path = (Get-NextBackupPath $Path) }
}

# An existing backup of a file (X.bak or X.bak.N) whose bytes have the given SHA-256, or $null.
function Get-BackupWithSha {
    param([string] $Path, [string] $Sha256)

    $folder = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { return $null }
    foreach ($file in @(Get-ChildItem -LiteralPath $folder -File -Force -Filter "$leaf.bak*")) {
        if ($file.Name -cnotmatch ('^' + [regex]::Escape($leaf) + '\.bak(\.\d+)?$')) { continue }
        if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -eq $Sha256) { return $file.FullName }
    }
    return $null
}

function Get-NextBackupPath {
    param([string] $Path)

    for ($number = 1; ; $number++) {
        $candidate = "$Path.bak.$number"
        if (-not (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
}

# The file records of one file's backups: the original, every numbered copy on disk, and the copy this apply will
# write. A backup keeps the role it was written with; a copy from a lock before roles names none.
function Get-BackupRecordsFor {
    param([string] $Relative, $Target, [string] $Runtime)

    $full = Join-Path $Workspace ($Relative -replace '/', '\')
    $folder = Split-Path -Parent $full
    $leaf = Split-Path -Leaf $full
    $paths = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $folder -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $folder -File -Force -Filter "$leaf.bak*")) {
            if ($file.Name -cmatch ('^' + [regex]::Escape($leaf) + '\.bak(\.\d+)?$')) { $paths.Add($file.FullName) }
        }
    }
    $targetPath = $null
    if ($Target.action -in @('original', 'edited')) { $targetPath = $Target.path }
    if ($null -ne $targetPath -and -not $paths.Contains($targetPath)) { $paths.Add($targetPath) }
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($backupPath in $paths) {
        $relativeBackup = $backupPath.Substring($Workspace.Length + 1).Replace('\', '/')
        if ($backupPath -eq $targetPath) {
            $role = if ($Target.action -eq 'original') { 'original' } else { 'edited' }
            $sha = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
        } else {
            $role = Get-PriorBackupRole $relativeBackup
            $sha = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
        }
        $record = New-OwnedRecord -Path $relativeBackup -Kind 'file' -Sha256 $sha -Runtime $Runtime -Role $role
        $record | Add-Member -NotePropertyName backup -NotePropertyValue $true
        $records.Add($record)
    }
    return $records.ToArray()
}

# The SHA-256 the previous lock records for the original backup of a file, or $null when it records none.
function Get-PriorOriginalSha {
    param([string] $Relative)

    if ($null -eq $priorOwned) { return $null }
    $prior = @($priorOwned | Where-Object { $_.path -ceq "$Relative.bak" -and $_.kind -eq 'file' -and (Get-BackupRole $_) -eq 'original' }) | Select-Object -First 1
    if ($null -eq $prior) { return $null }
    return $prior.sha256
}

# The role a backup had in the previous lock. A copy the previous lock never named was not written by the installer,
# so it is the user's: its role is user, and no removal restores or deletes it.
function Get-PriorBackupRole {
    param([string] $Relative)

    if ($null -eq $priorOwned) { return 'user' }
    $prior = @($priorOwned | Where-Object { $_.path -ceq $Relative -and $_.kind -eq 'file' }) | Select-Object -First 1
    if ($null -eq $prior) { return 'user' }
    return (Get-BackupRole $prior)
}

# One record of the ownership list. A file or folder holds its SHA-256, a folder a tree hash; a link
# holds its target; a json-entries record holds its key and entries, and createdKey when the installer
# created that key in a settings file that already existed. Every record names the runtime it belongs
# to, or none for the claude cache, and the layers it was installed for, so remove can pick it.
function New-OwnedRecord {
    param(
        [string] $Path,
        [string] $Kind,
        [string] $Sha256 = $null,
        [string] $Target = $null,
        [string] $Key = $null,
        [object[]] $Entries = $null,
        [bool] $CreatedKey = $false,
        # Untyped, so that no runtime stays $null in the record rather than an empty string.
        $Runtime = $null,
        [string[]] $Layers = @(),
        # The role of a backup: original, or edited. Null for every other record.
        $Role = $null
    )

    switch ($Kind) {
        'link' { $record = [pscustomobject]@{ path = $Path; kind = $Kind; target = $Target } }
        'json-entries' {
            $record = [pscustomobject]@{ path = $Path; kind = $Kind; key = $Key; entries = $Entries }
            if ($CreatedKey) { $record | Add-Member -NotePropertyName createdKey -NotePropertyValue $true }
        }
        default { $record = [pscustomobject]@{ path = $Path; kind = $Kind; sha256 = $Sha256 } }
    }
    $record | Add-Member -NotePropertyName runtime -NotePropertyValue $Runtime
    $record | Add-Member -NotePropertyName layers -NotePropertyValue @(Sort-Utf8 @($Layers | Where-Object { $_ }))
    if ($null -ne $Role) { $record | Add-Member -NotePropertyName role -NotePropertyValue $Role }
    return $record
}

# The identity of a record: its path, its kind, and for a Pi list its key.
function Get-OwnedKey {
    param($Record)

    return "$($Record.path)`t$($Record.kind)`t$(Get-Field $Record 'key')"
}

# The records in one order, so the lock diffs cleanly: by path, then kind, then key, by UTF-8 bytes.
function Sort-OwnedRecords {
    param([object[]] $Records)

    $byKey = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($record in @($Records)) { $byKey[(Get-OwnedKey $record)] = $record }
    $keys = Sort-Utf8 @($byKey.Keys)
    return @($keys | ForEach-Object { $byKey[$_] })
}

# Fails when the disk does not hold what the plan says the install wrote. A record is never written
# from a disk that disagrees with the plan, because the record would then hide the difference.
function Assert-Written {
    param([string] $Path, [string] $Disk, [string] $Planned)

    if ($Disk -ne $Planned) {
        throw "$Path holds different content from what the install wrote, so no ownership record was written. Remove the file or folder and apply again."
    }
}

# A stale wrapper goes only when it is the installer's recorded copy. A hand-edited wrapper, or one the lock
# never recorded, is kept and printed.
function Remove-WrapperIfRecorded {
    param([string] $Path)

    $relative = '.maxstack/bin/' + (Split-Path -Leaf $Path)
    $record = @($priorOwned | Where-Object { $null -ne $_ -and $_.path -ceq $relative -and $_.kind -eq 'file' }) | Select-Object -First 1
    if ($null -eq $record -or -not (Test-RecordedFile -Full $Path -Sha256 $record.sha256)) {
        Write-Host "Kept ${Path}: it is not the installer's recorded copy (changed by hand, or never recorded)"
        return
    }
    Remove-OwnedTree $Path
    Write-Host "Removed the stale wrapper $Path"
}

# What the installer would own after an apply, from the same layers and texts the apply writes.
# -Apply writes its record from this plan once the disk matches it, and -Status compares the plan
# with the disk and with the record. A null hash or entries means the value is not known yet.
function Get-OwnedPlan {
    param(
        # Untyped: a null config must stay null, because a [string] parameter turns it into an empty string.
        $Document,
        [object[]] $Layers,
        [object[]] $ClaudeRecords,
        [object[]] $OpenCodeLayers,
        [hashtable] $OpenCodeSpecs,
        [string] $CopilotCmdText,
        [string] $CopilotShText,
        [string] $PiCmdText,
        [string] $PiShText,
        $PiSettings,
        [bool] $PiPending,
        [hashtable] $PiUnknown
    )

    $records = [System.Collections.Generic.List[object]]::new()
    $layerByName = @{}
    foreach ($layer in $Layers) { $layerByName[$layer.name] = $layer }

    # The config is an OpenCode output, so it has records only when opencode is selected.
    if ($null -ne $Document) {
        # An apply that finds the config matching by trimmed text leaves the file as it is.
        $configExists = Test-Path -LiteralPath $configTarget -PathType Leaf
        $configText = $null
        if ($configExists) { $configText = Get-Content -LiteralPath $configTarget -Raw }
        $configUnchanged = ($null -ne $configText) -and ($configText.Trim() -eq $Document.Trim())
        $configSha = Get-TextSha256 $Document
        if ($configUnchanged) { $configSha = (Get-FileHash -LiteralPath $configTarget -Algorithm SHA256).Hash }
        $records.Add((New-OwnedRecord -Path 'opencode.jsonc' -Kind 'file' -Sha256 $configSha -Runtime 'opencode'))

        foreach ($backup in @(Get-BackupRecordsFor -Relative 'opencode.jsonc' -Target $configBackupTarget -Runtime 'opencode')) { $records.Add($backup) }
    }

    foreach ($record in $ClaudeRecords) {
        $path = ".claude/plugins/$($record.plugin)"
        if ($record.kind -eq 'junction') {
            $records.Add((New-OwnedRecord -Path $path -Kind 'link' -Target $record.target -Runtime 'claude' -Layers @($record.layer)))
            continue
        }
        $root = Get-LayerRoot $layerByName[$record.layer]
        $sha = $null
        if ($null -ne $root -and $record.kind -eq 'copy' -and $null -ne $record.items) { $sha = Get-ItemsTreeSha256 -Root $root -Items $record.items }
        elseif ($null -ne $root) { $sha = Get-TreeSha256 $root }
        $records.Add((New-OwnedRecord -Path $path -Kind 'dir' -Sha256 $sha -Runtime 'claude' -Layers @($record.layer)))
    }

    foreach ($layer in @($Layers | Where-Object { $null -ne $_.url })) {
        $sha = $null
        if (Test-CacheAtPin $layer) { $sha = Get-TreeSha256 (Join-Path $claudeCacheTarget $layer.name) }
        $records.Add((New-OwnedRecord -Path ".claude/cache/$($layer.name)" -Kind 'dir' -Sha256 $sha -Layers @($layer.name)))
    }

    # A profile that two layers install is recorded once, with the later layer's copy, as the apply writes it.
    $agents = [ordered]@{}
    foreach ($layer in $OpenCodeLayers) {
        $root = Get-LayerRoot $layer
        $sha = $null
        if ($null -ne $root) {
            $claudeDeclared = $layer.runtimes.ContainsKey('claude')
            $items = @(Get-OpenCodeItems -Layer $layer -Root $root | Where-Object { $_ -ne '.claude-plugin' -or $claudeDeclared })
            $sha = Get-ItemsTreeSha256 -Root $root -Items $items
            $spec = $OpenCodeSpecs[$layer.name]
            $agentsSource = $null
            if ($spec.agents) { $agentsSource = Join-Path $root ($spec.agents -replace '/', '\') }
            if ($agentsSource -and (Test-Path -LiteralPath $agentsSource -PathType Container)) {
                foreach ($agent in @(Get-ChildItem -LiteralPath $agentsSource -Filter '*.md')) {
                    $text = Get-AgentProfileText $agent.FullName
                    $agentSha = (Get-FileHash -LiteralPath $agent.FullName -Algorithm SHA256).Hash
                    if ($null -ne $text) { $agentSha = Get-TextSha256 $text }
                    $path = ".opencode/agents/$($agent.Name)"
                    $agents[$path] = New-OwnedRecord -Path $path -Kind 'file' -Sha256 $agentSha -Runtime 'opencode' -Layers @($layer.name)
                }
            }
        }
        $records.Add((New-OwnedRecord -Path ".opencode/plugins/$($layer.name)" -Kind 'dir' -Sha256 $sha -Runtime 'opencode' -Layers @($layer.name)))
    }
    foreach ($agent in $agents.Values) { $records.Add($agent) }

    if ($CopilotCmdText) {
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/copilot.cmd' -Kind 'file' -Sha256 (Get-TextSha256 $CopilotCmdText) -Runtime 'copilot'))
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/copilot.sh' -Kind 'file' -Sha256 (Get-TextSha256 $CopilotShText) -Runtime 'copilot'))
    }
    if ($PiCmdText) {
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/pi.cmd' -Kind 'file' -Sha256 (Get-TextSha256 $PiCmdText) -Runtime 'pi'))
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/pi.sh' -Kind 'file' -Sha256 (Get-TextSha256 $PiShText) -Runtime 'pi'))
    }

    if ($null -ne $PiSettings) {
        $settingsPath = Join-Path $Workspace '.pi\agent\settings.json'
        foreach ($backup in @(Get-BackupRecordsFor -Relative '.pi/agent/settings.json' -Target $settingsBackupTarget -Runtime 'pi')) { $records.Add($backup) }

        # The layers a Pi settings list may hold an entry of: every selected layer that declares pi.
        $piLayerNames = @($Layers | Where-Object { $_.runtimes.ContainsKey('pi') } | ForEach-Object { $_.name })
        foreach ($key in @('packages', 'skills')) {
            $known = @($PiSettings.added[$key])
            $unknown = @(@($PiUnknown[$key]) | Where-Object { $known -cnotcontains $_ })
            if ($known.Count -eq 0 -and $unknown.Count -eq 0) { continue }
            $record = New-OwnedRecord -Path '.pi/agent/settings.json' -Kind 'json-entries' -Key $key -Entries $known -Runtime 'pi' -Layers $piLayerNames
            $record | Add-Member -NotePropertyName unknown -NotePropertyValue $unknown
            $records.Add($record)
        }
    }
    return $records.ToArray()
}

function Get-OwnedRecords {
    param([object[]] $Plan, [hashtable] $CreatedKeys)

    $records = foreach ($record in $Plan) {
        $full = Join-Path $Workspace ($record.path -replace '/', '\')
        # A planned backup is recorded once the apply has written it, and not before.
        if ((Get-Field $record 'backup') -and -not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $attribution = @{ Runtime = $record.runtime; Layers = @($record.layers); Role = (Get-Field $record 'role') }
        switch ($record.kind) {
            'file' {
                $disk = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
                Assert-Written -Path $record.path -Disk $disk -Planned $record.sha256
                New-OwnedRecord -Path $record.path -Kind 'file' -Sha256 $disk @attribution
            }
            'dir' {
                $disk = Get-TreeSha256 $full
                Assert-Written -Path $record.path -Disk $disk -Planned $record.sha256
                New-OwnedRecord -Path $record.path -Kind 'dir' -Sha256 $disk @attribution
            }
            'link' { New-OwnedRecord -Path $record.path -Kind 'link' -Target $record.target @attribution }
            'json-entries' {
                $entries = @($record.entries | Where-Object { $null -ne $_ })
                if ($entries.Count -gt 0) {
                    New-OwnedRecord -Path $record.path -Kind 'json-entries' -Key $record.key -Entries $entries -CreatedKey ([bool] $CreatedKeys[$record.key]) @attribution
                }
            }
        }
    }
    return (Sort-OwnedRecords @($records))
}

# The state of one recorded file, folder, or link. missing and modified compare the disk with the
# record; drifted means the disk matches the record but an apply would write something else; matching
# means neither holds.
function Get-OwnedState {
    param($Record, $Planned)

    $full = Join-Path $Workspace ($Record.path -replace '/', '\')
    $plannedSame = ($null -ne $Planned) -and ($Planned.kind -eq $Record.kind)
    switch ($Record.kind) {
        'link' {
            $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
            if ($null -eq $item) { return 'missing' }
            if (-not (Test-ClaudeJunction -Child $full -Target (Join-Path $Workspace ($Record.target -replace '/', '\')))) { return 'modified' }
            $plannedSame = $plannedSame -and ($Planned.target -eq $Record.target)
        }
        'file' {
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return 'missing' }
            if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ne $Record.sha256) { return 'modified' }
            $plannedSame = $plannedSame -and ($Planned.sha256 -eq $Record.sha256)
        }
        'dir' {
            if (-not (Test-Path -LiteralPath $full -PathType Container)) { return 'missing' }
            if ((Get-TreeSha256 $full) -ne $Record.sha256) { return 'modified' }
            $plannedSame = $plannedSame -and ($Planned.sha256 -eq $Record.sha256)
        }
    }
    if ($plannedSame) { return 'matching' }
    return 'drifted'
}

# Compares the recorded ownership with the disk and with the plan, and writes nothing. A Pi list is
# reported per entry, so one removed entry shows alone. An entry whose state cannot be known until an
# apply syncs a pinned source is drifted, and it is reported once, like every other path.
function Get-OwnershipReport {
    param([object[]] $Recorded, [object[]] $Plan, [string[]] $SelectedRuntimes, [string[]] $NotSelected)

    $results = [System.Collections.Generic.List[object]]::new()
    $plannedByKey = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($planned in @($Plan)) { $plannedByKey[(Get-OwnedKey $planned)] = $planned }
    $recordedKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $recordedPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $recordedEntries = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $notSelectedLabels = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($record in @($Recorded)) {
        $recordedKeys.Add((Get-OwnedKey $record)) | Out-Null
        $recordedPaths.Add($record.path) | Out-Null
    }
    # An artifact of a runtime that is not selected is named, and never judged.
    foreach ($path in @($NotSelected)) {
        if ($notSelectedLabels.Add($path)) { $results.Add([pscustomobject]@{ state = 'not selected'; label = $path }) }
    }

    foreach ($record in @($Recorded)) {
        $runtime = Get-OwnedRuntime $record.path
        if (($null -ne $runtime) -and ($SelectedRuntimes -notcontains $runtime)) {
            if ($notSelectedLabels.Add($record.path)) { $results.Add([pscustomobject]@{ state = 'not selected'; label = $record.path }) }
            continue
        }
        if ($record.kind -ne 'json-entries') {
            $state = Get-OwnedState -Record $record -Planned $plannedByKey[(Get-OwnedKey $record)]
            $results.Add([pscustomobject]@{ state = $state; label = $record.path })
            continue
        }
        $settingsPath = Join-Path $Workspace ($record.path -replace '/', '\')
        $settings = $null
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            try { $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json } catch { $settings = $null }
        }
        $present = [hashtable]::new([StringComparer]::Ordinal)
        foreach ($entry in @(Get-Field $settings $record.key)) {
            if ($null -ne $entry) { $present[(Get-PiEntryKey $entry)] = $true }
        }
        $planned = $plannedByKey[(Get-OwnedKey $record)]
        $known = [hashtable]::new([StringComparer]::Ordinal)
        if ($null -ne $planned) {
            foreach ($entry in @($planned.entries)) {
                if ($null -ne $entry) { $known[(Get-PiEntryKey $entry)] = $true }
            }
        }
        foreach ($entry in @($record.entries)) {
            $entryKey = Get-PiEntryKey $entry
            $recordedEntries.Add("$($record.path)`t$($record.key)`t$entryKey") | Out-Null
            if (-not $present.ContainsKey($entryKey)) { $state = 'missing' }
            elseif ($known.ContainsKey($entryKey)) { $state = 'matching' }
            else { $state = 'drifted' }
            $results.Add([pscustomobject]@{ state = $state; label = "$($record.path) [$($record.key)] $entryKey" })
        }
    }

    foreach ($planned in @($Plan)) {
        if ($planned.kind -ne 'json-entries') {
            # A backup that the next apply would write is not reported until it exists.
            if ((Get-Field $planned 'backup') -and -not (Test-Path -LiteralPath (Join-Path $Workspace ($planned.path -replace '/', '\')) -PathType Leaf)) { continue }
            if (-not $recordedKeys.Contains((Get-OwnedKey $planned))) {
                $results.Add([pscustomobject]@{ state = 'drifted'; label = $planned.path })
            }
            continue
        }
        $candidates = @($planned.entries) + @(Get-Field $planned 'unknown')
        foreach ($entry in $candidates) {
            if ($null -eq $entry) { continue }
            $entryKey = Get-PiEntryKey $entry
            if ($recordedEntries.Contains("$($planned.path)`t$($planned.key)`t$entryKey")) { continue }
            $results.Add([pscustomobject]@{ state = 'drifted'; label = "$($planned.path) [$($planned.key)] $entryKey" })
        }
    }

    # A file in .maxstack\bin that no record names is one the installer did not write.
    $bin = Join-Path $Workspace '.maxstack\bin'
    if (Test-Path -LiteralPath $bin -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $bin -File -Force)) {
            $path = ".maxstack/bin/$($file.Name)"
            if (-not $recordedPaths.Contains($path) -and -not $notSelectedLabels.Contains($path)) { $results.Add([pscustomobject]@{ state = 'untracked'; label = $path }) }
        }
    }
    return $results.ToArray()
}

# Deletes a file, or a folder and everything in it. A junction or a symbolic link is removed as a
# link, so the folder it names and its contents are never touched.
function Remove-OwnedTree {
    param([string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if (Test-ReparsePoint $item.FullName) {
        if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName, $false) } else { [IO.File]::Delete($item.FullName) }
        return
    }
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { Remove-OwnedTree $child.FullName }
        [IO.Directory]::Delete($item.FullName, $false)
    } else {
        # A read-only file, such as a git pack in a cache, is cleared first, or the delete would fail.
        [IO.File]::SetAttributes($item.FullName, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($item.FullName)
    }
}

# Removes from a layer folder what the layer does not install now. Items are relative paths under the
# folder, forward-slashed. Each removal is printed, so a file that went away shows in the apply output.
function Remove-FolderExtras {
    param([string] $Folder, [string[]] $Items, [switch] $Top)

    foreach ($child in @(Get-ChildItem -LiteralPath $Folder -Force)) {
        $name = $child.Name
        # The layer folder's node_modules is npm's output from the last install, so it stays.
        if ($Top -and $child.PSIsContainer -and $name -ceq 'node_modules') { continue }
        if (@($Items | Where-Object { $_ -ceq $name }).Count -gt 0) { continue }
        $within = @($Items | Where-Object { $_.StartsWith("$name/", [StringComparison]::Ordinal) } | ForEach-Object { $_.Substring($name.Length + 1) })
        if ($within.Count -gt 0 -and $child.PSIsContainer -and -not (Test-ReparsePoint $child.FullName)) {
            Remove-FolderExtras -Folder $child.FullName -Items $within
            continue
        }
        Remove-OwnedTree $child.FullName
        Write-Host "Removed $($child.FullName): the layer does not install it"
    }
}

# The directories an install may create, named relative to the workspace. An apply reads this list
# before and after its writes, to tell what it created from what was there first.
function Get-InstallerDirectories {
    param([object[]] $Layers)

    $dirs = [System.Collections.Generic.List[string]]::new()
    foreach ($dir in @('.claude', '.claude/plugins', '.claude/cache', '.opencode', '.opencode/plugins', '.opencode/agents', '.maxstack', '.maxstack/bin', '.pi', '.pi/agent')) {
        $dirs.Add($dir)
    }
    foreach ($layer in $Layers) {
        $dirs.Add(".claude/plugins/$($layer.name)")
        $dirs.Add(".claude/cache/$($layer.name)")
        $dirs.Add(".opencode/plugins/$($layer.name)")
    }
    return $dirs.ToArray()
}

# The candidates that exist now and either were not there before this apply, or were recorded as
# created by an earlier one. A prior entry that is gone from the disk is dropped.
function Get-CreatedPaths {
    param([string[]] $Candidates, [string[]] $Prior, [string[]] $ExistedBefore, [string] $Kind)

    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $created = [System.Collections.Generic.List[string]]::new()
    foreach ($path in @($Candidates) + @($Prior)) {
        if (-not $seen.Add($path)) { continue }
        $full = Join-Path $Workspace ($path -replace '/', '\')
        if ($Kind -eq 'dir') { $exists = Test-Path -LiteralPath $full -PathType Container }
        else { $exists = Test-Path -LiteralPath $full -PathType Leaf }
        if (-not $exists) { continue }
        if (($Prior -ccontains $path) -or -not ($ExistedBefore -ccontains $path)) { $created.Add($path) }
    }
    return (Sort-Utf8 $created.ToArray())
}

# ---- Removal: -Remove and -Uninstall ----------------------------------------------------------------------
# Both delete only what the ownership record names. Each record is checked against the disk when it is planned,
# and again just before its action. The check sets the state its plan line prints:
#   DELETE   the disk matches the record, so the installer removes it.
#   RESTORE  the original backup goes back in place of the file it replaced, and the backup is removed.
#   GONE     the path is already absent, so the record is complete and nothing is deleted.
#   KEEP     the record is finished, and what is left is not the installer's to delete.
#   SKIP     the disk differs from the record, the path is not safe to act on, or the folder is in use. Nothing is
#            deleted for it, and the record stays in the lock so a later run retries it.
# A junction is removed as a link, and its target is kept. A folder is renamed to a quarantine name beside it before
# it is deleted, so a file that is open makes the rename fail with the folder unchanged. Nothing is deleted through
# a junction, and a deletion never leaves the workspace.

$quarantineSuffix = '.maxstack-removing'
$groupFileNames = @('opencode.jsonc', '.pi/agent/settings.json')

function Test-InstallerOutputs {
    foreach ($path in @('.opencode/plugins', '.opencode/agents', '.claude/plugins', '.claude/cache', '.maxstack/bin')) {
        if (Test-Path -LiteralPath (Join-Path $Workspace ($path -replace '/', '\'))) { return $true }
    }
    return $false
}

# The full path of a recorded workspace-relative path. It is refused unless it is a relative path that stays inside
# the workspace and no folder between the workspace and the path is a junction.
function Resolve-WorkspaceEntry {
    param([string] $Relative)

    $refused = 'outside the workspace: the record does not name a workspace path'
    if (-not (Test-RelativePath $Relative) -or $Relative.Contains('\') -or $Relative -in @('stack.lock.json', 'stack.lock.json.bak', 'stack.lock.json.new')) {
        return [pscustomobject]@{ ok = $false; full = $null; reason = $refused }
    }
    $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\')
    $full = [IO.Path]::GetFullPath((Join-Path $root ($Relative -replace '/', '\')))
    if (-not $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ ok = $false; full = $null; reason = 'outside the workspace: the path resolves outside it' }
    }
    $folder = [IO.Path]::GetDirectoryName($full)
    while ($folder.Length -gt $root.Length) {
        if ((Test-Path -LiteralPath $folder) -and (Test-ReparsePoint $folder)) {
            return [pscustomobject]@{ ok = $false; full = $null; reason = 'outside the workspace: a folder on its path is a junction' }
        }
        $folder = [IO.Path]::GetDirectoryName($folder)
    }
    return [pscustomobject]@{ ok = $true; full = $full; reason = $null }
}

# Whether a target, read from a link, is inside the workspace. An empty target is not.
function Test-InsideWorkspace {
    param([string] $Target)

    if (-not $Target) { return $false }
    $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Target).TrimEnd('\')
    return (($full -ieq $root) -or $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase))
}

function Get-EntryItem {
    param([string] $Path)

    return Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

# Whether a path is a real file whose SHA-256 is the recorded one. A link, a folder, a missing file, or a record with
# no hash is not.
function Test-RecordedFile {
    param([string] $Full, [string] $Sha256)

    if (-not $Sha256) { return $false }
    $item = Get-EntryItem $Full
    if ($null -eq $item -or $item.PSIsContainer -or (Test-ReparsePoint $Full)) { return $false }
    return ((Get-FileHash -LiteralPath $Full -Algorithm SHA256).Hash -eq $Sha256)
}

function New-RemovalItem {
    param(
        [string] $State,
        [string] $Path,
        [string] $Reason,
        [string] $Action = 'none',
        [object[]] $Records = @(),
        [string[]] $Gone = @(),
        [string] $Full = $null,
        [string] $Source = $null,
        [string] $Text = $null,
        [string] $ExpectSha = $null,
        [string] $ExpectSource = $null,
        [string] $ExpectTarget = $null,
        [string] $Quarantine = $null
    )

    return [pscustomobject]@{
        state        = $State
        path         = $Path
        reason       = $Reason
        action       = $Action
        records      = @($Records)
        gone         = @($Gone)
        full         = $Full
        source       = $Source
        text         = $Text
        expectSha    = $ExpectSha
        expectSource = $ExpectSource
        expectTarget = $ExpectTarget
        quarantine   = $Quarantine
    }
}

function New-SkipItem {
    param([string] $Path, [string] $Reason)

    return New-RemovalItem -State SKIP -Path $Path -Reason $Reason
}

function New-GoneItem {
    param([string] $Path, [object[]] $Records, [string] $Reason = 'already gone: nothing to delete')

    return New-RemovalItem -State GONE -Path $Path -Reason $Reason -Records $Records
}

function Get-FileRemovalItem {
    param($Record)

    $entry = Resolve-WorkspaceEntry $Record.path
    if (-not $entry.ok) { return New-SkipItem $Record.path $entry.reason }
    $item = Get-EntryItem $entry.full
    if ($null -eq $item) { return New-GoneItem $Record.path @($Record) }
    if (Test-ReparsePoint $entry.full) { return New-SkipItem $Record.path 'modified by hand: a link stands where the file was recorded' }
    if ($item.PSIsContainer) { return New-SkipItem $Record.path 'modified by hand: a folder stands where the file was recorded' }
    if (-not (Test-RecordedFile -Full $entry.full -Sha256 $Record.sha256)) { return New-SkipItem $Record.path 'modified by hand: its SHA-256 differs from the record, or the record has none' }
    return New-RemovalItem -State DELETE -Path $Record.path -Reason 'SHA-256 matches the record' -Action 'remove-file' -Records @($Record) -Gone @($Record.path) -Full $entry.full -ExpectSha $Record.sha256
}

# The folders an owned folder holds under the names the owned rule leaves out (node_modules and .git at any depth).
# They are deleted with the folder, so the plan counts each one, and refuses one with a junction that leads outside.
function Get-ExcludedSubtreeReport {
    param([string] $Root)

    $report = [pscustomobject]@{ subtrees = [System.Collections.Generic.List[object]]::new(); outside = $null }
    Find-ExcludedSubtrees -Dir $Root -Relative '' -Report $report
    return $report
}

function Find-ExcludedSubtrees {
    param([string] $Dir, [string] $Relative, $Report)

    foreach ($child in [IO.Directory]::GetDirectories($Dir)) {
        $name = [IO.Path]::GetFileName($child)
        $relativeChild = if ($Relative -eq '') { $name } else { "$Relative/$name" }
        if (Test-TreeFolderExcluded -Relative $relativeChild -Rule 'owned') {
            Measure-ExcludedSubtree -Dir $child -Relative $relativeChild -Report $Report
        } elseif (-not (Test-ReparsePoint $child)) {
            Find-ExcludedSubtrees -Dir $child -Relative $relativeChild -Report $Report
        }
    }
}

# Counts the files and bytes under one excluded folder without following a junction, and notes any junction that
# leads outside the workspace.
function Measure-ExcludedSubtree {
    param([string] $Dir, [string] $Relative, $Report)

    if (Test-ReparsePoint $Dir) {
        if (-not (Test-InsideWorkspace (Get-LinkTargetText $Dir))) { $Report.outside = $Relative }
        $Report.subtrees.Add([pscustomobject]@{ path = $Relative; files = 0; bytes = [long] 0 })
        return
    }
    $files = 0
    [long] $bytes = 0
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($Dir)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($sub in [IO.Directory]::GetDirectories($current)) {
            if (Test-ReparsePoint $sub) {
                if (-not (Test-InsideWorkspace (Get-LinkTargetText $sub))) { $Report.outside = $Relative }
            } else {
                $pending.Push($sub)
            }
        }
        foreach ($file in [IO.Directory]::GetFiles($current)) {
            if (Test-ReparsePoint $file) {
                if (-not (Test-InsideWorkspace (Get-LinkTargetText $file))) { $Report.outside = $Relative }
                continue
            }
            $files++
            $bytes += ([IO.FileInfo]::new($file)).Length
        }
    }
    $Report.subtrees.Add([pscustomobject]@{ path = $Relative; files = $files; bytes = $bytes })
}

# A quarantine left beside a folder is resumed only when the lock journaled that quarantine's name for this record, and
# its tree still has the recorded hash. Any other folder with that name is the user's, so it is named and not touched.
function Get-QuarantineResumeItem {
    param($Record, [string] $Quarantine)

    $leaf = Split-Path -Leaf $Quarantine
    if ((Get-Field $Record 'quarantine') -ceq $leaf -and -not (Test-ReparsePoint $Quarantine) -and (Test-Path -LiteralPath $Quarantine -PathType Container) -and ((Get-TreeSha256 $Quarantine) -eq $Record.sha256)) {
        return New-RemovalItem -State DELETE -Path $Record.path -Reason "resumes the removal of the folder quarantined as $leaf" -Action 'resume-quarantine' -Records @($Record) -Gone @($Record.path) -Full $Quarantine -Quarantine $Quarantine -ExpectSha $Record.sha256
    }
    if ((Get-Field $Record 'quarantine') -ceq $leaf) { return New-SkipItem $Record.path "in the way: $leaf holds files that changed since its removal began, so it is kept; delete or move it aside by hand" }
    return New-SkipItem $Record.path "in the way: a folder named $leaf exists, and it is not the one an earlier removal quarantined for this path"
}

# A folder is deleted only when its tree hash is the recorded one. The owned folder is wholly the installer's, so a
# file added to it, or a change to one, makes the hash differ and the folder is kept. The folder is renamed to its
# quarantine name first; a rerun resumes a quarantine that a failed delete left behind.
function Get-DirRemovalItem {
    param($Record)

    $entry = Resolve-WorkspaceEntry $Record.path
    if (-not $entry.ok) { return New-SkipItem $Record.path $entry.reason }
    $quarantine = "$($entry.full)$quarantineSuffix"
    $item = Get-EntryItem $entry.full
    if ($null -eq $item) {
        if (Test-Path -LiteralPath $quarantine) {
            return (Get-QuarantineResumeItem -Record $Record -Quarantine $quarantine)
        }
        return New-GoneItem $Record.path @($Record)
    }
    if (Test-ReparsePoint $entry.full) { return New-SkipItem $Record.path 'modified by hand: a link stands where the folder was recorded' }
    if (-not $item.PSIsContainer) { return New-SkipItem $Record.path 'modified by hand: a file stands where the folder was recorded' }
    if ((Get-TreeSha256 $entry.full) -ne $Record.sha256) { return New-SkipItem $Record.path 'modified by hand: a file in it was added, changed, or removed since the install, or the record has no hash' }
    if (Test-Path -LiteralPath $quarantine) {
        $leaf = Split-Path -Leaf $quarantine
        if ((Get-Field $Record 'quarantine') -ceq $leaf) { return New-SkipItem $Record.path "in the way: $leaf holds files that changed since its removal began, so it is kept; delete or move it aside by hand" }
        return New-SkipItem $Record.path "in the way: a folder named $leaf already exists, and no removal journal names it"
    }
    $excluded = Get-ExcludedSubtreeReport $entry.full
    if ($null -ne $excluded.outside) { return New-SkipItem $Record.path "refused: a junction under $($Record.path)/$($excluded.outside) leads outside the workspace" }
    $reason = 'tree hash matches the record'
    $notes = @($excluded.subtrees | ForEach-Object { "$($Record.path)/$($_.path) ($($_.files) files, $($_.bytes) bytes)" })
    if ($notes.Count -gt 0) { $reason += '; also deletes the excluded folders ' + ($notes -join ', ') }
    return New-RemovalItem -State DELETE -Path $Record.path -Reason $reason -Action 'remove-dir' -Records @($Record) -Gone @($Record.path) -Full $entry.full -ExpectSha $Record.sha256 -Quarantine $quarantine
}

# A link is deleted as a link, and only while it points at the recorded target. Its target is never read or changed.
function Get-LinkRemovalItem {
    param($Record)

    $entry = Resolve-WorkspaceEntry $Record.path
    if (-not $entry.ok) { return New-SkipItem $Record.path $entry.reason }
    $target = Resolve-WorkspaceEntry $Record.target
    if (-not $target.ok) { return New-SkipItem $Record.path 'its recorded target is outside the workspace' }
    $item = Get-EntryItem $entry.full
    if ($null -eq $item) { return New-GoneItem $Record.path @($Record) }
    if (-not (Test-ReparsePoint $entry.full)) { return New-SkipItem $Record.path 'modified by hand: a folder or file stands where the link was recorded' }
    if (-not (Test-ClaudeJunction -Child $entry.full -Target $target.full)) { return New-SkipItem $Record.path 'modified by hand: the link no longer points at its recorded target' }
    return New-RemovalItem -State DELETE -Path $Record.path -Reason 'removed as a link; its target is kept' -Action 'remove-link' -Records @($Record) -Gone @($Record.path) -Full $entry.full -ExpectTarget $Record.target
}

# The state of a backup: missing, intact (its bytes are the recorded ones), or modified.
function Get-BackupState {
    param($Backup)

    $entry = Resolve-WorkspaceEntry $Backup.path
    if (-not $entry.ok) { return 'modified' }
    if ($null -eq (Get-EntryItem $entry.full)) { return 'missing' }
    if (Test-RecordedFile -Full $entry.full -Sha256 $Backup.sha256) { return 'intact' }
    return 'modified'
}

# The role of a backup record. A lock from before roles names none, and then a plain X.bak is the file the install first
# replaced: only a file that existed before an install was given a plain .bak. A numbered copy from such a lock has no role.
function Get-BackupRole {
    param($Record)

    $role = Get-Field $Record 'role'
    if ($null -ne $role) { return $role }
    if ($Record.path -cmatch '\.bak$') { return 'original' }
    return $null
}

# Why a backup a removal does not restore is kept: the user's own copy, or an earlier version of the file.
function Get-KeepCopyReason {
    param($Backup)

    if ((Get-BackupRole $Backup) -eq 'user') { return 'kept: a backup the installer did not write, so it is never restored or deleted' }
    return 'kept: a copy of an earlier version, not restored'
}

# The original backup of a file that the installer replaced: the one copy a removal restores.
function Get-OriginalBackup {
    param([object[]] $Backups)

    return (@($Backups | Where-Object { (Get-BackupRole $_) -eq 'original' }) | Select-Object -First 1)
}

function New-KeepBackupItem {
    param($Backup, [string] $Reason)

    return New-RemovalItem -State KEEP -Path $Backup.path -Reason $Reason -Records @($Backup)
}

# Puts the original backup back in place of the file it replaced. The copy is written beside the file and replaced
# over it, so the file is never left half written. A stray copy from an interrupted run is removed.
function New-RestoreItem {
    param([string] $Replaced, $Original, [string] $ExpectSha, [object[]] $Records)

    $replacedEntry = Resolve-WorkspaceEntry $Replaced
    $originalEntry = Resolve-WorkspaceEntry $Original.path
    return New-RemovalItem -State RESTORE -Path $Replaced -Reason "put back from $($Original.path)" -Action 'restore' `
        -Records (@($Original) + @($Records)) -Gone @($Original.path) -Full $replacedEntry.full -Source $originalEntry.full `
        -ExpectSha $ExpectSha -ExpectSource $Original.sha256
}

# The opencode.jsonc group: the config the installer wrote, and its backups. The original is restored only while the
# config still holds the text the last apply wrote. Otherwise the config's own records are removed, and the copies are
# kept. A legacy original (a plain .bak from a lock before roles) is restored under the same test, and only when its bytes
# differ from the installer's text. A changed config with a legacy original is kept as it is, and the original is named.
function Get-ConfigGroupItems {
    param($File, [object[]] $Backups, [bool] $Created)

    $name = 'opencode.jsonc'
    $items = [System.Collections.Generic.List[object]]::new()
    $original = Get-OriginalBackup $Backups
    foreach ($copy in @($Backups | Where-Object { $null -eq $original -or $_.path -cne $original.path })) {
        $items.Add((New-KeepBackupItem $copy (Get-KeepCopyReason $copy)))
    }
    $legacy = ($null -ne $original) -and ($null -eq (Get-Field $original 'role'))
    if ($legacy -and $null -ne $File -and $original.sha256 -eq $File.sha256) {
        # A copy with the installer's own text is no earlier version of the config, so it is kept and never restored.
        $items.Add((New-KeepBackupItem $original 'kept: a copy of the installer''s own text, not restored'))
        $original = $null
    }
    if ($null -ne $original) {
        $state = Get-BackupState $original
        $replacedEntry = Resolve-WorkspaceEntry $name
        if ($state -eq 'missing') {
            # The backup is deleted by a restore, so a backup that is gone with the config holding its bytes means a run
            # restored the config and stopped before it wrote the lock. The restore is complete: the record is finished.
            if ($replacedEntry.ok -and (Test-RecordedFile -Full $replacedEntry.full -Sha256 $original.sha256)) {
                $restored = @($original)
                if ($null -ne $File) { $restored += $File }
                $items.Add((New-GoneItem $name $restored "already restored: $name holds the bytes of its original backup, which an earlier run restored before it stopped"))
                return $items.ToArray()
            }
            $items.Add((New-GoneItem $original.path @($original) 'already gone: the original backup is missing'))
        } elseif ($state -eq 'modified') {
            $items.Add((New-KeepBackupItem $original 'kept: the original backup changed by hand, so it is not restored'))
        } elseif ($null -eq $File) {
            $items.Add((New-KeepBackupItem $original 'kept: the file it replaced is not in the record'))
            return $items.ToArray()
        } elseif ($replacedEntry.ok -and (Test-RecordedFile -Full $replacedEntry.full -Sha256 $original.sha256)) {
            $items.Add((New-RemovalItem -State RESTORE -Path $name -Reason "already holds $($original.path): its backup is removed" -Action 'drop-backup' -Records (@($original) + @($File)) -Gone @($original.path) -Source (Resolve-WorkspaceEntry $original.path).full -ExpectSource $original.sha256))
            return $items.ToArray()
        } elseif ($replacedEntry.ok -and (Get-EntryItem $replacedEntry.full) -and (Test-RecordedFile -Full $replacedEntry.full -Sha256 $File.sha256)) {
            $items.Add((New-RestoreItem -Replaced $name -Original $original -ExpectSha $File.sha256 -Records @($File)))
            return $items.ToArray()
        } elseif ($null -eq (Get-EntryItem $replacedEntry.full)) {
            $items.Add((New-KeepBackupItem $original 'kept: the config is missing, so the original is kept'))
            $items.Add((New-GoneItem $name @($File) 'already gone: opencode.jsonc is missing'))
            return $items.ToArray()
        } elseif ($legacy) {
            $items.Add((New-RemovalItem -State KEEP -Path $name -Reason "kept: it changed since the install, so the original is not restored; the original is in $($original.path)" -Records @($File)))
            $items.Add((New-KeepBackupItem $original 'kept: the config changed since the install, so this original is not restored'))
            return $items.ToArray()
        } else {
            $items.Add((New-SkipItem $name 'modified by hand: kept with its original backup, which is not restored'))
            $items.Add((New-KeepBackupItem $original 'kept: the config was modified by hand'))
            return $items.ToArray()
        }
    }
    if ($null -eq $File) { return $items.ToArray() }
    $fileRemoval = Get-FileRemovalItem $File
    if ($fileRemoval.state -eq 'DELETE' -and -not $Created -and $null -eq $original -and $Backups.Count -eq 0) {
        $items.Add((New-RemovalItem -State KEEP -Path $name -Reason 'it existed before the install and holds the text the installer wrote, so it is kept' -Records @($File)))
        return $items.ToArray()
    }
    $items.Add($fileRemoval)
    return $items.ToArray()
}

# The Pi settings. The original backup is restored only while the file still holds the text the last apply wrote.
# Otherwise only the entries the record names are taken out, every other key and entry stays, and the backup is kept.
function Get-SettingsGroupItems {
    param([object[]] $Records, [object[]] $Backups, [string] $LastSha, [bool] $Created)

    $name = '.pi/agent/settings.json'
    $items = [System.Collections.Generic.List[object]]::new()
    $original = Get-OriginalBackup $Backups
    foreach ($copy in @($Backups | Where-Object { $null -eq $original -or $_.path -cne $original.path })) {
        $items.Add((New-KeepBackupItem $copy (Get-KeepCopyReason $copy)))
    }
    $originalHandled = $false
    if ($null -ne $original) {
        $state = Get-BackupState $original
        $replacedEntry = Resolve-WorkspaceEntry $name
        if ($state -eq 'missing') {
            $items.Add((New-GoneItem $original.path @($original) 'already gone: the original backup is missing'))
            $originalHandled = $true
        } elseif ($state -eq 'modified') {
            $items.Add((New-KeepBackupItem $original 'kept: the original backup changed by hand, so it is not restored'))
            $originalHandled = $true
        } elseif ($replacedEntry.ok -and (Get-EntryItem $replacedEntry.full) -and (Test-RecordedFile -Full $replacedEntry.full -Sha256 $LastSha)) {
            $items.Add((New-RestoreItem -Replaced $name -Original $original -ExpectSha $LastSha -Records $Records))
            return $items.ToArray()
        }
    }
    $edits = @(Get-SettingsEditItems -Records $Records -Created ($Created -and $null -eq $original))
    foreach ($item in $edits) { $items.Add($item) }
    if (-not $originalHandled -and $null -ne $original) {
        # The backup stays owed, as a skip, while the settings file could not be edited: the lock must keep it for a rerun.
        if (@($edits | Where-Object { $_.state -eq 'SKIP' }).Count -gt 0) {
            $items.Add((New-SkipItem $original.path 'kept: the settings file could not be edited, so its original stays in place'))
        } else {
            $items.Add((New-KeepBackupItem $original 'kept: the original is not restored; only the installer entries were removed'))
        }
    }
    return $items.ToArray()
}

# The Pi settings file, with the recorded entries taken out of their keys by a strict JSON parse. Every other key and
# entry stays. A file that is not strict JSON is skipped, and so is one that changed since it was read.
function Get-SettingsEditItems {
    param([object[]] $Records, [bool] $Created)

    $name = '.pi/agent/settings.json'
    $entry = Resolve-WorkspaceEntry $name
    if (-not $entry.ok) { return @($Records | ForEach-Object { New-SkipItem $name "[$($_.key)] $($entry.reason)" }) }
    $item = Get-EntryItem $entry.full
    if ($null -eq $item) { return @($Records | ForEach-Object { New-GoneItem $name @($_) "[$($_.key)] already gone: the settings file is missing" }) }
    if ((Test-ReparsePoint $entry.full) -or $item.PSIsContainer) {
        return @($Records | ForEach-Object { New-SkipItem $name "[$($_.key)] modified by hand: a link or folder stands where the file was recorded" })
    }
    $text = [IO.File]::ReadAllText($entry.full)
    try {
        $root = Read-StrictJsonObject $text
    } catch {
        return @($Records | ForEach-Object { New-SkipItem $name "[$($_.key)] not strict JSON: it has comments, trailing commas, or is not an object, so it is left as it is" })
    }
    $expectSha = Get-FileSha256OrNull $entry.full
    $result = Get-SettingsAfterRemoval -Root $root -Records $Records -CreatedFile $Created
    $records = @($Records)
    if ($Created -and (Test-InstallerShape $result.root)) {
        return @(New-RemovalItem -State DELETE -Path $name -Reason 'the installer created it, and only its empty lists remain' -Action 'remove-json-file' -Records $records -Gone @($name) -Full $entry.full -ExpectSha $expectSha)
    }
    if ($result.removed -eq 0) {
        return @(New-GoneItem $name $records 'already gone: none of the recorded entries is in the file')
    }
    $countText = (@($result.counts.GetEnumerator()) | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '
    $text = $result.root.ToJsonString((New-JsonWriteOptions)) + "`n"
    $state = if ($Created) { 'KEEP' } else { 'DELETE' }
    $reason = "removes the recorded entries ($countText); every other key and entry stays"
    return @(New-RemovalItem -State $state -Path $name -Reason $reason -Action 'write-json' -Records $records -Full $entry.full -Text $text -ExpectSha $expectSha)
}

# Takes the recorded entries out of their keys, in place. A key the installer created is removed once its list is
# empty. Returns the count taken from each key and the total.
function Get-SettingsAfterRemoval {
    param($Root, [object[]] $Records, [bool] $CreatedFile)

    $counts = [ordered]@{}
    $removed = 0
    foreach ($record in $Records) {
        $taken = 0
        $list = $Root[$record.key]
        if ($list -is [System.Text.Json.Nodes.JsonArray]) {
            foreach ($recorded in @($record.entries)) {
                $entryKey = Get-JsonEntryKeyFromPs $recorded
                for ($index = 0; $index -lt $list.Count; $index++) {
                    if ((Get-JsonEntryKey $list[$index]) -ceq $entryKey) { $list.RemoveAt($index); $taken++; break }
                }
            }
            $createdKey = $CreatedFile -or ((Get-Field $record 'createdKey') -eq $true)
            if ($taken -gt 0 -and $list.Count -eq 0 -and $createdKey) { $Root.Remove($record.key) | Out-Null }
        }
        $counts[$record.key] = $taken
        $removed += $taken
    }
    return [pscustomobject]@{ root = $Root; counts = $counts; removed = $removed }
}

# Whether only the keys the installer writes remain, and each of them is an empty list.
function Test-InstallerShape {
    param($Root)

    foreach ($pair in $Root) {
        if ($pair.Key -notin @('packages', 'skills')) { return $false }
        if (-not ($pair.Value -is [System.Text.Json.Nodes.JsonArray]) -or $pair.Value.Count -gt 0) { return $false }
    }
    return $true
}

# The folders the installer created, deepest first. A folder goes when every entry in it is gone by now, and a
# folder with an entry that stays is kept. The uninstall reports each kept folder; a remove does not, because the
# folders it keeps still hold what the remaining selection installs.
function Get-CreatedDirItems {
    param([string[]] $Dirs, [string[]] $Gone, [bool] $Report)

    $goneFull = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $Gone) {
        $entry = Resolve-WorkspaceEntry $path
        if ($entry.ok) { $goneFull.Add($entry.full) | Out-Null }
    }
    $items = [System.Collections.Generic.List[object]]::new()
    $ordered = @($Dirs | Sort-Object -Property @{ Expression = { ($_ -split '/').Count }; Descending = $true }, @{ Expression = { $_ }; Descending = $true })
    foreach ($dir in $ordered) {
        $entry = Resolve-WorkspaceEntry $dir
        if (-not $entry.ok) { $items.Add((New-SkipItem $dir $entry.reason)); continue }
        if ($goneFull.Contains($entry.full)) { continue }
        $item = Get-EntryItem $entry.full
        if ($null -eq $item -or -not $item.PSIsContainer) { continue }
        if (Test-ReparsePoint $entry.full) {
            if ($Report) { $items.Add((New-RemovalItem -State KEEP -Path $dir -Reason 'a link, which is left alone')) }
            continue
        }
        $left = @(Get-ChildItem -LiteralPath $entry.full -Force | Where-Object { -not $goneFull.Contains($_.FullName) })
        if ($left.Count -eq 0) {
            $items.Add((New-RemovalItem -State DELETE -Path $dir -Reason 'empty, and the installer created it' -Action 'delete-empty' -Full $entry.full))
            $goneFull.Add($entry.full) | Out-Null
        } elseif ($Report) {
            $items.Add((New-RemovalItem -State KEEP -Path $dir -Reason 'holds entries that stay'))
        }
    }
    return $items.ToArray()
}

# The leftover copies the installer writes beside a file while it works. A copy is deleted only when its bytes are a
# hash the lock records for that file; any other copy is named and kept, so no unknown bytes are removed.
$strayFileSuffixes = @('.uninstall-restore', '.uninstall-replaced', '.maxstack-tmp', '.maxstack-old')

# The SHA-256 values the lock or the apply knows for one file: the file's own records and its backups, and the text the
# installer last wrote to the config or the Pi settings.
function Get-KnownShas {
    param([string] $Path, [object[]] $Known, $ConfigSha, $SettingsSha)

    $shas = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in @($Known)) {
        if ($record.kind -ne 'file' -or -not $record.sha256) { continue }
        if ($record.path -ceq $Path -or $record.path -cmatch ('^' + [regex]::Escape($Path) + '\.bak(\.\d+)?$')) { $shas.Add($record.sha256) | Out-Null }
    }
    if ($Path -ceq 'opencode.jsonc' -and $ConfigSha) { $shas.Add($ConfigSha) | Out-Null }
    if ($Path -ceq '.pi/agent/settings.json' -and $SettingsSha) { $shas.Add($SettingsSha) | Out-Null }
    return , $shas
}

# The leftover copies beside each recorded file. A copy whose bytes the lock knows is a DELETE; any other copy is a SKIP,
# which keeps the lock for a rerun. A leftover that is a folder or a link is a SKIP too.
function Get-StrayItems {
    param([object[]] $Candidates, [object[]] $Known, $ConfigSha, $SettingsSha)

    $items = [System.Collections.Generic.List[object]]::new()
    $bases = @($Candidates | Where-Object { $_.kind -in @('file', 'json-entries') } | ForEach-Object { $_.path } | Sort-Object -Unique)
    foreach ($base in $bases) {
        $baseEntry = Resolve-WorkspaceEntry $base
        if (-not $baseEntry.ok) { continue }
        $shas = Get-KnownShas -Path $base -Known $Known -ConfigSha $ConfigSha -SettingsSha $SettingsSha
        foreach ($suffix in $strayFileSuffixes) {
            $stray = "$base$suffix"
            $strayEntry = Resolve-WorkspaceEntry $stray
            if (-not $strayEntry.ok) { continue }
            $strayItem = Get-EntryItem $strayEntry.full
            if ($null -eq $strayItem) { continue }
            if ($strayItem.PSIsContainer -or (Test-ReparsePoint $strayEntry.full)) {
                $items.Add((New-SkipItem $stray 'a leftover folder or link beside a recorded file, so it is kept'))
                continue
            }
            $sha = (Get-FileHash -LiteralPath $strayEntry.full -Algorithm SHA256).Hash
            if ($shas.Contains($sha)) {
                $items.Add((New-RemovalItem -State DELETE -Path $stray -Reason "a leftover copy of $base from an interrupted run; its bytes match the lock" -Action 'remove-file' -Full $strayEntry.full -ExpectSha $sha))
            } else {
                $items.Add((New-SkipItem $stray "a leftover copy of $base whose bytes the lock does not record, so it is kept"))
            }
        }
    }
    return $items.ToArray()
}

# Whether a path is one of the file groups or a backup of one.
function Test-GroupMember {
    param([string] $Path)

    foreach ($group in $groupFileNames) {
        if ($Path -ceq $group -or $Path -cmatch ('^' + [regex]::Escape($group) + '\.bak(\.\d+)?$')) { return $true }
    }
    return $false
}

# The plan for the candidate records: one item for each record, for each file group, and for each folder the
# installer created. A file group is decided as one unit, with its backups.
function Get-RemovalPlanItems {
    param([object[]] $Candidates, [string[]] $CreatedDirs, [string[]] $CreatedFiles, [string] $SettingsSha, [bool] $Report)

    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($group in $groupFileNames) {
        $members = @($Candidates | Where-Object { $_.path -ceq $group -or $_.path -cmatch ('^' + [regex]::Escape($group) + '\.bak(\.\d+)?$') })
        if ($members.Count -eq 0) { continue }
        $file = @($members | Where-Object { $_.path -ceq $group -and $_.kind -eq 'file' }) | Select-Object -First 1
        $backups = @($members | Where-Object { $_.path -cmatch ('^' + [regex]::Escape($group) + '\.bak(\.\d+)?$') })
        # A lock from before schema 2 records createdFiles for the Pi settings only. There, a file with no backup was
        # made by the installer, since a file that existed before an install always got one.
        $created = ($CreatedFiles -ccontains $group) -or ($priorLegacy -and $backups.Count -eq 0)
        $groupItems = @()
        try {
            if ($group -eq 'opencode.jsonc') {
                $groupItems = @(Get-ConfigGroupItems -File $file -Backups $backups -Created $created)
            } else {
                $records = @($members | Where-Object { $_.kind -eq 'json-entries' })
                $groupItems = @(Get-SettingsGroupItems -Records $records -Backups $backups -LastSha $SettingsSha -Created $created)
            }
        } catch {
            $groupItems = @(New-SkipItem $group "could not be checked: $($_.Exception.Message)")
        }
        foreach ($item in $groupItems) { $items.Add($item) }
    }
    foreach ($record in $Candidates) {
        if (Test-GroupMember $record.path) { continue }
        try {
            switch ($record.kind) {
                'file' { $items.Add((Get-FileRemovalItem $record)) }
                'dir' { $items.Add((Get-DirRemovalItem $record)) }
                'link' { $items.Add((Get-LinkRemovalItem $record)) }
                default { $items.Add((New-SkipItem $record.path 'the record names an entry kind this installer does not remove')) }
            }
        } catch {
            $items.Add((New-SkipItem $record.path "could not be checked: $($_.Exception.Message)"))
        }
    }
    foreach ($stray in @(Get-StrayItems -Candidates $Candidates -Known $priorOwned -ConfigSha (Get-Field $priorStack 'configSha256') -SettingsSha $priorSettingsSha)) { $items.Add($stray) }
    $gone = @($items | Where-Object { $_.state -in @('DELETE', 'RESTORE') } | ForEach-Object { $_.gone })
    foreach ($item in @(Get-CreatedDirItems -Dirs $CreatedDirs -Gone $gone -Report $Report)) { $items.Add($item) }
    return $items.ToArray()
}

# An apply prints the leftover copies beside the recorded files, and deletes the ones whose bytes the lock knows. A
# quarantine folder an interrupted removal left is named: a removal finishes it through its record.
function Invoke-StrayReport {
    param([object[]] $Known, $ConfigSha, $SettingsSha)

    foreach ($item in @(Get-StrayItems -Candidates $Known -Known $Known -ConfigSha $ConfigSha -SettingsSha $SettingsSha)) {
        if ($item.state -eq 'DELETE') {
            try {
                Confirm-RemovalItem $item
                Invoke-RemovalAction $item
            } catch {
                $item.state = 'SKIP'
                $item.reason = "could not be deleted: $($_.Exception.Message)"
            }
        }
        Write-Host ('{0,-8} {1}  {2}' -f $item.state, $item.path, $item.reason)
    }
    foreach ($record in @($Known | Where-Object { $_.kind -eq 'dir' } | Sort-Object -Property path -Unique)) {
        if ($keptJournals.ContainsKey($record.path)) { continue }
        $entry = Resolve-WorkspaceEntry $record.path
        if (-not $entry.ok) { continue }
        $leftover = "$($entry.full)$quarantineSuffix"
        if (Test-Path -LiteralPath $leftover) {
            Write-Host ('SKIP     {0}{1}  a folder with the removal quarantine name is beside a recorded folder, and no removal journal names it, so it is kept; delete or move it aside by hand' -f $record.path, $quarantineSuffix)
        }
    }
}

# The records a removal deletes: those whose runtime or layers the remaining selection does not keep, and which
# the remaining selection does not produce at the same path. -All takes every record, as -Uninstall does.
function Get-RemovalCandidates {
    param([object[]] $Records, [string[]] $KeepRuntimes, [string[]] $KeepLayers, [hashtable] $Produced, [bool] $All)

    $candidates = [System.Collections.Generic.List[object]]::new()
    foreach ($record in @($Records)) {
        if ($All) { $candidates.Add($record); continue }
        if ($Produced.ContainsKey($record.path)) { continue }
        $runtimeGone = ($null -ne $record.runtime) -and ($KeepRuntimes -cnotcontains $record.runtime)
        $layerGone = @($record.layers | Where-Object { $KeepLayers -cnotcontains $_ }).Count -gt 0
        if ($runtimeGone -or $layerGone) { $candidates.Add($record) }
    }
    return $candidates.ToArray()
}

function Get-PlannedPathSet {
    param([object[]] $Plan)

    $paths = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($record in @($Plan)) { $paths[$record.path] = $true }
    return $paths
}

# The runtimes or layers still selected after -Remove: the recorded ones less the named ones. A name that is not
# recorded removes nothing.
function Get-RemainingSelection {
    param([string[]] $Recorded, [string[]] $Named, [string] $Label)

    foreach ($name in $Named) {
        if ($Recorded -cnotcontains $name) { Write-Host "$Label '$name' is not selected, so there is nothing to remove for it." }
    }
    return @(Sort-Utf8 @($Recorded | Where-Object { $Named -cnotcontains $_ }))
}

# A removal that empties the selection, or leaves a runtime that needs an unselected one, is refused before anything
# is written. Removing everything is -Uninstall.
function Assert-RemainingSelection {
    param([string[]] $Runtimes, [string[]] $Layers)

    if ($Runtimes.Count -eq 0 -or $Layers.Count -eq 0) {
        throw 'Removing every runtime, or every layer, leaves nothing selected. Use -Uninstall to remove the whole bundle.'
    }
    $dependents = @('copilot', 'pi') | Where-Object { ($Runtimes -ccontains $_) -and ($Runtimes -cnotcontains 'claude') }
    if (@($dependents).Count -gt 0) {
        $list = $dependents -join ','
        throw "Removing claude would leave $($dependents -join ' and ') selected, and each needs claude. Remove them in the same command: -Remove -Runtimes claude,$list."
    }
}

function Select-PresentPaths {
    param([object[]] $Paths, [string] $Kind)

    $present = [System.Collections.Generic.List[string]]::new()
    foreach ($path in @($Paths | Where-Object { $_ })) {
        if (Test-Path -LiteralPath (Join-Path $Workspace ($path -replace '/', '\')) -PathType $Kind) { $present.Add($path) }
    }
    return , $present.ToArray()
}

# Writes the lock with the records still owed: the records of the remaining selection, and each candidate a run
# has not finished. The created folders and files it names are only those still on disk.
function Save-RemovalProgress {
    param($Stack, [object[]] $Keep, [object[]] $Pending)

    $pendingList = @($Pending | Where-Object { $null -ne $_ })
    $owed = @($Keep | Where-Object { $null -ne $_ }) + $pendingList
    $ownedList = @()
    if ($owed.Count -gt 0) { $ownedList = @(Sort-OwnedRecords $owed) }
    $Stack.owned = $ownedList
    $Stack.createdDirs = Select-PresentPaths -Paths @($Stack.createdDirs) -Kind 'Container'
    $Stack.createdFiles = Select-PresentPaths -Paths @($Stack.createdFiles) -Kind 'Leaf'
    # The settings hash is the one the installer last wrote. While a pending record still names the settings file it is
    # kept, so the file can be put back. Once none does, the file is the user's, and the hash is kept only while Pi is selected.
    $settingsOwed = @($pendingList | Where-Object { $_.path -like '.pi/agent/settings.json*' }).Count -gt 0
    $settingsSha = $priorSettingsSha
    if (-not $settingsOwed) {
        $settingsSha = $null
        if (($selectedRuntimes -contains 'pi') -and (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf)) {
            $settingsSha = (Get-FileHash -LiteralPath $piSettingsTarget -Algorithm SHA256).Hash
        }
    }
    if ($null -ne (Get-Field $Stack 'pi')) { $Stack.pi | Add-Member -NotePropertyName settingsSha256 -NotePropertyValue $settingsSha -Force }
    Write-LockAtomically -Text ($Stack | ConvertTo-Json -Depth 8)
}

# A test seam, and nothing else. MAXSTACK_TEST_HOOK holds one fault: swap:<path> turns that file into a folder after
# the plan, and crash:<path> stops the run after that path's action and before the lock is written. Unset, it does nothing.
function Invoke-RemovalTestHook {
    param([string] $Stage, [string] $Path)

    $hook = $env:MAXSTACK_TEST_HOOK
    if ([string]::IsNullOrEmpty($hook)) { return }
    $parts = $hook -split ':', 2
    if ($parts.Count -ne 2 -or $parts[1] -cne $Path) { return }
    if ($Stage -eq 'before' -and $parts[0] -eq 'swap') {
        $full = (Resolve-WorkspaceEntry $Path).full
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            [IO.File]::Delete($full)
            [IO.Directory]::CreateDirectory($full) | Out-Null
        }
    }
    if ($Stage -eq 'after' -and $parts[0] -eq 'crash') {
        throw "injected fault after the action on $Path, before the lock was written"
    }
}

# The SHA-256 of a file, or of a folder's tree, that a planned action was based on must still be the one the plan saw.
# A file swapped for a folder, or changed since the plan, is refused here, not deleted.
function Confirm-RemovalItem {
    param($Item)

    if ($Item.action -eq 'none') { return }
    $entry = Resolve-WorkspaceEntry $Item.path
    if (-not $entry.ok) { throw $entry.reason }
    $changed = 'changed since the plan: rerun the command to plan it again'
    switch ($Item.action) {
        'remove-file' { if (-not (Test-RecordedFile -Full $entry.full -Sha256 $Item.expectSha)) { throw $changed } }
        'remove-json-file' { if ((Get-FileSha256OrNull $entry.full) -ne $Item.expectSha) { throw $changed } }
        'write-json' { if ((Get-FileSha256OrNull $entry.full) -ne $Item.expectSha) { throw $changed } }
        'remove-link' {
            $target = Resolve-WorkspaceEntry $Item.expectTarget
            if (-not $target.ok -or -not (Test-ClaudeJunction -Child $entry.full -Target $target.full)) { throw $changed }
        }
        'remove-dir' {
            $current = Get-EntryItem $entry.full
            if ($null -eq $current -or -not $current.PSIsContainer -or (Test-ReparsePoint $entry.full)) { throw $changed }
            if ((Get-TreeSha256 $entry.full) -ne $Item.expectSha) { throw $changed }
        }
        'restore' {
            if (-not (Test-RecordedFile -Full $entry.full -Sha256 $Item.expectSha)) { throw $changed }
            if (-not (Test-RecordedFile -Full $Item.source -Sha256 $Item.expectSource)) { throw 'the backup changed since the plan' }
        }
        'drop-backup' { if (-not (Test-RecordedFile -Full $Item.source -Sha256 $Item.expectSource)) { throw 'the backup changed since the plan' } }
        'resume-quarantine' {
            if (-not (Test-Path -LiteralPath $Item.quarantine -PathType Container) -or (Test-ReparsePoint $Item.quarantine)) { throw $changed }
            if ((Get-TreeSha256 $Item.quarantine) -ne $Item.expectSha) { throw $changed }
        }
        'delete-empty' {
            $current = Get-EntryItem $entry.full
            if ($null -eq $current -or -not $current.PSIsContainer -or (Test-ReparsePoint $entry.full)) { throw $changed }
            if (@(Get-ChildItem -LiteralPath $entry.full -Force).Count -gt 0) { throw $changed }
        }
    }
}

# Renames the folder to its quarantine name, then deletes the quarantine. A file that is open makes the rename fail with
# the folder unchanged. A failed delete leaves the quarantine, which a rerun deletes.
function Remove-QuarantinedDir {
    param($Item)

    [IO.Directory]::Move($Item.full, $Item.quarantine)
    Remove-OwnedTree $Item.quarantine
}

# Puts the original back in place of the file it replaced. A failure removes the copy it was writing.
function Restore-Original {
    param($Item)

    $temp = "$($Item.full).uninstall-restore"
    $replaced = "$($Item.full).uninstall-replaced"
    try {
        if (Test-Path -LiteralPath $replaced) { [IO.File]::Delete($replaced) }
        [IO.File]::Copy($Item.source, $temp, $true)
        [IO.File]::Replace($temp, $Item.full, $replaced)
    } finally {
        foreach ($stray in @($temp, $replaced)) {
            if (Test-Path -LiteralPath $stray -PathType Leaf) { [IO.File]::Delete($stray) }
        }
    }
    [IO.File]::Delete($Item.source)
}

function Invoke-RemovalAction {
    param($Item)

    switch ($Item.action) {
        'remove-file' { Remove-OwnedTree $Item.full }
        'remove-json-file' { Remove-OwnedTree $Item.full }
        'remove-link' { Remove-OwnedTree $Item.full }
        'remove-dir' { Remove-QuarantinedDir $Item }
        'resume-quarantine' { Remove-OwnedTree $Item.quarantine }
        'restore' { Restore-Original $Item }
        'drop-backup' { [IO.File]::Delete($Item.source) }
        'write-json' {
            Assert-UnchangedSince $Item.full $Item.expectSha
            Write-FileAtomically $Item.full $Item.text
        }
        'delete-empty' { [IO.Directory]::Delete($Item.full, $false) }
    }
}

# The reason an action failed. A folder that could not be renamed or deleted is in use: it is either unchanged, or
# quarantined for a rerun to finish.
function Get-ActionFailureReason {
    param($Item, $ErrorRecord)

    $message = $ErrorRecord.Exception.Message
    if ($Item.action -in @('remove-dir', 'resume-quarantine')) {
        if ($Item.quarantine -and (Test-Path -LiteralPath $Item.quarantine)) {
            return "in use: part of it could not be deleted; it is quarantined as $(Split-Path -Leaf $Item.quarantine), and a rerun resumes it ($message)"
        }
        return "in use: could not be renamed, so the folder is unchanged ($message)"
    }
    return "could not be removed: $message"
}

# Prints each item's state, path, and reason, and with -Execute runs the items that act. An item that fails, or whose
# record changed since the plan, becomes a skip. Each item that finishes records is followed by a lock write, so an
# interrupted run leaves the lock listing only what is still owed.
function Invoke-RemovalItems {
    param($Stack, [object[]] $Keep, [object[]] $Candidates, [object[]] $Items, [bool] $Execute)

    $finished = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($item in $Items) {
        $acts = $item.action -ne 'none' -and $item.state -ne 'SKIP' -and $item.state -ne 'GONE'
        if ($Execute -and $acts) {
            try {
                Invoke-RemovalTestHook -Stage before -Path $item.path
                Confirm-RemovalItem $item
                if ($item.action -eq 'remove-dir' -and $null -ne $Stack) {
                    # The journal: the lock names the quarantine before the rename, so a rerun resumes only that folder.
                    $item.records[0] | Add-Member -NotePropertyName quarantine -NotePropertyValue (Split-Path -Leaf $item.quarantine) -Force
                    Save-RemovalProgress -Stack $Stack -Keep $Keep -Pending (Get-PendingRecords -Candidates $Candidates -Finished $finished)
                }
                Invoke-RemovalAction $item
            } catch {
                $item.state = 'SKIP'
                $item.reason = Get-ActionFailureReason $item $_
            }
        }
        Write-Host ('{0,-8} {1}  {2}' -f $item.state, $item.path, $item.reason)
        if ($Execute -and $item.state -ne 'SKIP') {
            if ($acts) { Invoke-RemovalTestHook -Stage after -Path $item.path }
            foreach ($record in $item.records) { $finished[(Get-OwnedKey $record)] = $true }
            if ($item.records.Count -gt 0) { Save-RemovalProgress -Stack $Stack -Keep $Keep -Pending (Get-PendingRecords -Candidates $Candidates -Finished $finished) }
        }
    }
    if ($Execute) { Save-RemovalProgress -Stack $Stack -Keep $Keep -Pending (Get-PendingRecords -Candidates $Candidates -Finished $finished) }
}

# The candidates a run has not finished. A skipped record is one of them, so the lock keeps it for a later run.
function Get-PendingRecords {
    param([object[]] $Candidates, [hashtable] $Finished)

    return , @($Candidates | Where-Object { -not $Finished.ContainsKey((Get-OwnedKey $_)) })
}

function Write-RemovalSummary {
    param([object[]] $Items)

    $counts = foreach ($state in @('DELETE', 'RESTORE', 'GONE', 'KEEP', 'SKIP')) { "$(@($Items | Where-Object { $_.state -eq $state }).Count) $($state.ToLower())" }
    Write-Host ('Summary: ' + ($counts -join ', '))
}

function Get-SkipCount {
    param([object[]] $Items)

    return @($Items | Where-Object { $_.state -eq 'SKIP' }).Count
}

# -Remove without -Apply: the plan for the removal. Writes nothing.
function Write-RemovalDryRun {
    param([object[]] $Records, [object[]] $Plan, [string[]] $SelectedRuntimes, [string[]] $SelectedLayers)

    $candidates = @(Get-RemovalCandidates -Records $Records -KeepRuntimes $SelectedRuntimes -KeepLayers $SelectedLayers -Produced (Get-PlannedPathSet $Plan) -All $false)
    $items = @(Get-RemovalPlanItems -Candidates $candidates -CreatedDirs $priorCreatedDirs -CreatedFiles $priorCreatedFiles -SettingsSha $priorSettingsSha -Report $false)
    Write-Host 'Removal plan:'
    Invoke-RemovalItems -Stack $null -Keep @() -Candidates $candidates -Items $items -Execute $false
    Write-RemovalSummary -Items $items
    Write-Host 'Dry run: nothing was removed or written. Rerun with -Apply to execute this plan.'
    if ($Strict -and (Get-SkipCount $items) -gt 0) { exit 1 }
}

# -Remove -Apply: after the remaining selection is applied, deletes what the selection no longer produces.
function Invoke-RemovalFlow {
    param($Stack, [object[]] $PlanRecords, [object[]] $Plan)

    $candidates = @(Get-RemovalCandidates -Records $priorOwned -KeepRuntimes $selectedRuntimes -KeepLayers $selectedLayers -Produced (Get-PlannedPathSet $Plan) -All $false)
    $items = @(Get-RemovalPlanItems -Candidates $candidates -CreatedDirs $priorCreatedDirs -CreatedFiles $priorCreatedFiles -SettingsSha $priorSettingsSha -Report $false)
    Write-Host 'Removal:'
    Invoke-RemovalItems -Stack $Stack -Keep $PlanRecords -Candidates $candidates -Items $items -Execute $true
    Write-RemovalSummary -Items $items
    $skipped = Get-SkipCount $items
    if ($skipped -gt 0) {
        Write-Host "$skipped items skipped; lock kept; rerun -Remove -Apply to retry."
    } else {
        Write-Host "Removed. Selection: runtimes $($selectedRuntimes -join ', '); layers $($selectedLayers -join ', ')."
    }
    if ($Strict -and $skipped -gt 0) { exit 1 }
}

# -Uninstall: removes every record, then the lock files when nothing was skipped. Without -Apply it prints the plan.
function Invoke-UninstallFlow {
    $candidates = @(Get-RemovalCandidates -Records $priorOwned -KeepRuntimes @() -KeepLayers @() -Produced @{} -All $true)
    $items = @(Get-RemovalPlanItems -Candidates $candidates -CreatedDirs $priorCreatedDirs -CreatedFiles $priorCreatedFiles -SettingsSha $priorSettingsSha -Report $true)
    if ($items.Count -eq 0) { Write-Host 'Nothing to remove: the lock records no path.' }
    Invoke-RemovalItems -Stack $priorStack -Keep @() -Candidates $candidates -Items $items -Execute $Apply
    if ($items.Count -gt 0) { Write-RemovalSummary -Items $items }
    $skipped = Get-SkipCount $items
    if (-not $Apply) {
        Write-Host 'Dry run: nothing was removed or written. Rerun with -Uninstall -Apply to execute this plan.'
    } elseif ($skipped -eq 0) {
        foreach ($file in @($stackTarget, "$stackTarget.bak", "$stackTarget.new")) {
            if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
        }
        $kept = @($items | Where-Object { $_.state -eq 'KEEP' } | ForEach-Object { $_.path })
        if ($kept.Count -eq 0) {
            Write-Host 'Uninstalled: every recorded path was removed, and the lock files with it.'
        } else {
            Write-Host "Uninstalled: the lock files are removed. Kept on disk, not restored or deleted: $($kept -join ', ')."
        }
    } else {
        Write-Host "$skipped items skipped; lock kept; rerun -Uninstall -Apply to retry."
    }
    if ($Strict -and $skipped -gt 0) { exit 1 }
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace not found: $Workspace"
}

$workspaceName = Split-Path -Leaf $Workspace.TrimEnd('\', '/')
if ([string]::IsNullOrWhiteSpace($workspaceName)) {
    throw "Could not derive a workspace name from: $Workspace"
}

$layerManifest = Get-Content -LiteralPath $layersPath -Raw | ConvertFrom-Json
$layers = @($layerManifest.layers | ForEach-Object { New-LayerModel $_ })
$layerNames = @($layers | ForEach-Object { $_.name })
if (@($layerNames | Select-Object -Unique).Count -ne $layerNames.Count) { throw 'layers.json names a layer twice.' }

# The per-run sources the command line names: -Source, and -LayerSource as its local alias. A name not in layers.json is refused.
$explicitSources = Read-SourceSpecs -Specs $SourceOverrides -LayerSpecs $LayerSource -LayerNames $layerNames

# The previous lock records what the last apply installed. It is read before anything is resolved,
# because its selection decides which layers and runtimes this run touches. Audit compares against
# it, and apply removes only the folders it recorded.
$priorStack = $null
$priorLayers = @{}
# The source overrides the lock records. A plain apply reuses them until -Source name=default drops one.
$recordedOverrides = @{}
$priorPi = $null
# The ownership list the previous apply wrote. $null means the lock predates it, or there is no lock.
$priorOwned = $null
# The directories and files an earlier apply recorded as created by the installer.
$priorCreatedDirs = @()
$priorCreatedFiles = @()
# A lock from before schema 2: its records name no runtime or layer, and its createdFiles is partial.
$priorLegacy = $false
if (Test-Path -LiteralPath $stackTarget -PathType Leaf) {
    $priorStack = Read-PriorLock
    $priorLegacy = ((Get-Field $priorStack 'ownedSchema') -ne $ownedSchemaVersion)
    foreach ($priorLayer in @($priorStack.layers)) {
        $priorLayers[$priorLayer.name] = $priorLayer
    }
    $recordedOverrides = Get-RecordedOverrides $priorStack
    $priorPi = Get-Field $priorStack 'pi'
    if ($null -ne $priorStack.PSObject.Properties['owned']) { $priorOwned = @($priorStack.owned | Where-Object { $null -ne $_ }) }
    if ($null -ne $priorStack.PSObject.Properties['createdDirs']) { $priorCreatedDirs = @($priorStack.createdDirs) }
    if ($null -ne $priorStack.PSObject.Properties['createdFiles']) { $priorCreatedFiles = @($priorStack.createdFiles) }
    # A schema-1 lock records no created config. A config it names with no backup was made by the installer, as a removal
    # of that lock infers, so the upgrade apply records it as created too.
    if ($priorLegacy -and @($priorOwned | Where-Object { $null -ne $_ -and $_.path -ceq 'opencode.jsonc' -and $_.kind -eq 'file' }).Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $Workspace 'opencode.jsonc.bak') -PathType Leaf)) {
        $priorCreatedFiles = @($priorCreatedFiles) + 'opencode.jsonc'
    }
}
# The hash each replaced file held when the last apply wrote it. A backup is taken only when the file no longer
# holds it, and -Remove or -Uninstall restores a backup only while the file still holds it.
$priorOpenCodeSha = $null
if ($null -ne $priorOwned) {
    $priorConfigRecord = @($priorOwned | Where-Object { $_.path -eq 'opencode.jsonc' -and $_.kind -eq 'file' })
    if ($priorConfigRecord.Count -gt 0) { $priorOpenCodeSha = $priorConfigRecord[0].sha256 }
}
$priorSettingsSha = Get-Field $priorPi 'settingsSha256'
# The runtimes a removal keeps. An uninstall keeps none, and a removal sets this when it narrows the selection.
$selectedRuntimes = @()

# -Remove and -Uninstall delete only what the record names, so they need a record. -Uninstall needs only the owned list,
# because restoring and deleting name each path directly. -Remove needs version 2, which names each record's runtime
# and layers, so it can pick the records of what it removes.
if ($removing -or $uninstalling) {
    $hasOwned = ($null -ne $priorStack) -and ($null -ne $priorOwned)
    $schemaOk = ($null -ne $priorStack) -and ((Get-Field $priorStack 'ownedSchema') -eq $ownedSchemaVersion)
    $usable = $hasOwned -and ($uninstalling -or $schemaOk)
    if (-not $usable -and $null -ne $priorStack) {
        $why = if ($null -eq $priorOwned) { 'it has no owned list' } else { "its ownedSchema is $(Get-Field $priorStack 'ownedSchema'), and -Remove needs version $ownedSchemaVersion, which names each record's runtime and layers" }
        throw "stack.lock.json has no usable ownership record: $why. Run Install-Workspace.ps1 -Apply once to write it, then rerun."
    }
    if (-not $usable) {
        if (Test-InstallerOutputs) { throw "There is no usable ownership record (no $stackTarget). Run Install-Workspace.ps1 -Apply once to create it, then rerun." }
        Write-Host "Nothing to remove: $Workspace has no stack.lock.json and none of the installer's outputs."
        return
    }
}
# -Update re-resolves the recorded sources, so it needs the lock and the selection the lock records.
if ($updating) {
    if ($null -eq $priorStack) { throw "-Update needs a stack.lock.json with a selection, and $Workspace has none. Run Install-Workspace.ps1 -Apply first." }
    if ($null -eq (Get-Field $priorStack 'selection')) { throw "stack.lock.json predates the selection, so -Update cannot tell which layers and runtimes to update. Run Install-Workspace.ps1 -Apply once, then -Update." }
}
if ($uninstalling) {
    Invoke-UninstallFlow
    return
}

# The selection. Flags add names to the recorded selection; an unnamed dimension keeps what is recorded.
# A lock with no selection reads as all, and a new workspace starts with exactly what is named.
$recordedSelection = Read-RecordedSelection -Stack $priorStack -LayerNames $layerNames
$recordedRuntimes = if ($null -ne $recordedSelection) { $recordedSelection.runtimes } else { $null }
$recordedLayers = if ($null -ne $recordedSelection) { $recordedSelection.layers } else { $null }
$runtimesNamed = $PSBoundParameters.ContainsKey('RequestedRuntimes')
$layersNamed = $PSBoundParameters.ContainsKey('RequestedLayers')
$namedRuntimes = if ($runtimesNamed) { Get-NamedValues -Values $RequestedRuntimes -Valid $runtimeNames -Parameter 'Runtimes' } else { @() }
$namedLayers = if ($layersNamed) { Get-NamedValues -Values $RequestedLayers -Valid $layerNames -Parameter 'Layers' } else { @() }
if ($removing) {
    # -Remove narrows the recorded selection. A name that is not selected removes nothing. With nothing to
    # remove and no leftovers from an interrupted remove, the run ends here.
    $removesSomething = (@($namedRuntimes | Where-Object { $recordedRuntimes -ccontains $_ }).Count + @($namedLayers | Where-Object { $recordedLayers -ccontains $_ }).Count) -gt 0
    $leftovers = @(Get-RemovalCandidates -Records $priorOwned -KeepRuntimes $recordedRuntimes -KeepLayers $recordedLayers -Produced @{} -All $false)
    if (-not $removesSomething -and $leftovers.Count -eq 0) {
        foreach ($name in $namedRuntimes) { Write-Host "runtime '$name' is not selected, so there is nothing to remove for it." }
        foreach ($name in $namedLayers) { Write-Host "layer '$name' is not selected, so there is nothing to remove for it." }
        Write-Host 'Nothing to remove.'
        return
    }
    $selectedRuntimes = @(Get-RemainingSelection -Recorded $recordedRuntimes -Named $namedRuntimes -Label 'runtime')
    $selectedLayers = @(Get-RemainingSelection -Recorded $recordedLayers -Named $namedLayers -Label 'layer')
    Assert-RemainingSelection -Runtimes $selectedRuntimes -Layers $selectedLayers
} else {
    $selectedRuntimes = @(Merge-Selected -Recorded $recordedRuntimes -All $runtimeNames -Named $namedRuntimes -HasNames $runtimesNamed -Label 'runtimes')
    $selectedLayers = @(Merge-Selected -Recorded $recordedLayers -All $layerNames -Named $namedLayers -HasNames $layersNamed -Label 'layers')
    Assert-SelectionRuntimes -Runtimes $selectedRuntimes
}
# A layer or runtime that layers.json names but the selection leaves out is said so, on every run. A removal
# leaves out what it removed on purpose, so it is not said.
$unselectedNotes = @(Get-UnselectedNotes -AllLayers $layers -SelectedLayers $selectedLayers -SelectedRuntimes $selectedRuntimes)
if (-not $removing) {
    foreach ($note in $unselectedNotes) {
        Write-Warning "$($note.kind) '$($note.name)' is in layers.json but not selected, so this run does not install it. Add it with $($note.flag) $($note.name)."
    }
}
$copilotSelected = $selectedRuntimes -contains 'copilot'
$piSelected = $selectedRuntimes -contains 'pi'
$openCodeSelected = $selectedRuntimes -contains 'opencode'
$claudeSelected = $selectedRuntimes -contains 'claude'

# A layer installs only the selected runtimes it declares. A selected layer that declares none of them
# is reported and installs nothing. An unselected layer keeps no runtimes, so the lock records it disabled.
$allLayers = $layers
foreach ($layer in $allLayers) {
    $active = @{}
    if ($selectedLayers -contains $layer.name) {
        foreach ($runtime in $selectedRuntimes) {
            if ($layer.declared.ContainsKey($runtime)) { $active[$runtime] = $layer.declared[$runtime] }
        }
        if ($active.Count -eq 0) { Write-Host "Layer '$($layer.name)' declares none of the selected runtimes, so it installs nothing." }
    }
    $layer.runtimes = $active
}
# Every layer's source is chosen before the active set is cut, so an unselected layer's lock record is right too.
Set-LayerSources -Layers $allLayers -Explicit $explicitSources -Recorded $recordedOverrides -Updating $updating -SelectedLayers $selectedLayers
$layers = @($allLayers | Where-Object { $_.runtimes.Count -gt 0 })
$activeLayerNames = @($layers | ForEach-Object { $_.name })
$unselectedLayerNames = @($layerNames | Where-Object { $selectedLayers -notcontains $_ })

# A local folder that is gone stops an apply, which would write what the folder holds, and a removal too, which rewrites the
# config from every selected layer's fragment. Every other run reports the folder and goes on.
foreach ($layer in $layers) {
    if ($layer.sourceKind -ne 'local' -or -not $layer.folderMissing) { continue }
    if ($Apply) { throw "Layer '$($layer.name)' is not checked out at $($layer.localPath). Restore the folder, or drop the override with -Source $($layer.name)=default, then rerun." }
}

# Before any write, an apply records what already exists: the directories an install may create, the
# settings file, and its Pi keys. The ownership record then tells the paths this install created from
# the paths that were there first, so an uninstall never removes what it did not create.
$installerDirs = @(Get-InstallerDirectories -Layers $layers)
$existedBefore = @()
$existedBeforeFiles = @()
$settingsKeysBefore = @()
$settingsFileBefore = $false
if ($Apply) {
    $existedBefore = @($installerDirs | Where-Object { Test-Path -LiteralPath (Join-Path $Workspace ($_ -replace '/', '\')) -PathType Container })
    $settingsFileBefore = Test-Path -LiteralPath $piSettingsTarget -PathType Leaf
    if ($settingsFileBefore) {
        $settingsBefore = Get-Content -LiteralPath $piSettingsTarget -Raw | ConvertFrom-Json
        if ($null -ne $settingsBefore) { $settingsKeysBefore = @($settingsBefore.PSObject.Properties | ForEach-Object { $_.Name }) }
    }
    $existedBeforeFiles = @($replacedFileNames | Where-Object { Test-Path -LiteralPath (Join-Path $Workspace ($_ -replace '/', '\')) -PathType Leaf })
}

# Git sources are synced before anything is written, so a bad pin stops the run with
# the workspace unchanged. Audit reads no git source; it reports what the last apply left.
if ($Apply) {
    foreach ($layer in @($layers | Where-Object { $null -ne $_.url })) {
        $cache = Sync-GitPlugin $layer
        $layer.root = Join-SourceSub $cache $layer.sourcePath
        if (-not (Test-Path -LiteralPath $layer.root -PathType Container)) {
            throw "Layer '$($layer.name)' has no $($layer.sourcePath) folder at the pinned commit."
        }
    }
}
# A git layer's root is its cache folder once the cache is at the pin. Without an apply, a cache that is not at the pin
# leaves the root null, and what needs the root is then unknown until an apply syncs the cache.
foreach ($layer in @($layers | Where-Object { $null -ne $_.url })) { $layer.root = Get-LayerRoot $layer }

$claudeRecords = @($layers | ForEach-Object { Get-ClaudeRecord $_ } | Where-Object { $null -ne $_ })

$openCodeLayers = @($layers | Where-Object { $_.runtimes.ContainsKey('opencode') })
$openCodeSpecs = @{}
foreach ($layer in $openCodeLayers) { $openCodeSpecs[$layer.name] = Get-OpenCodeSpec $layer }

$priorOpenCodeFolders = @($priorLayers.Values | ForEach-Object { Get-Field (Get-Field $_ 'opencode') 'folder' } | Where-Object { $_ } | ForEach-Object { Split-Path -Leaf $_ })

$copilotLayers = @($layers | Where-Object { $_.runtimes.ContainsKey('copilot') })
$copilotDirs = @($copilotLayers | ForEach-Object { Join-Path $claudePluginsTarget $_.name })
$copilotExecutable = if ($copilotLayers.Count -gt 0) { Find-WrappedExecutable $CopilotCommand } else { $null }
$copilotCmdText = $null
$copilotShText = $null
if ($copilotExecutable) {
    $copilotCmdText = New-CopilotCmdText -Executable $copilotExecutable -PluginDirs $copilotDirs
    $copilotShText = New-CopilotShText -PluginDirs $copilotDirs
} elseif ($copilotLayers.Count -gt 0) {
    Write-Warning "Copilot CLI not found: no '$CopilotCommand' application outside .maxstack\bin. Skipping $copilotCmdTarget and $copilotShTarget. Install Copilot, then rerun with -Apply."
}

# Pi lists each layer's package when its package.json has a pi key, and each layer's skills
# folder. The settings and the lock's pi list hold those entries relative to the agent folder;
# each layer's lock record holds its folder relative to the workspace.
$piLayers = @($layers | Where-Object { $_.runtimes.ContainsKey('pi') })
$piRecords = @($piLayers | ForEach-Object { Get-PiLayerRecord $_ })
$piByLayer = @{}
foreach ($record in $piRecords) { $piByLayer[$record.layer] = $record }
$piPending = @($piRecords | Where-Object { $_.pending }).Count -gt 0
$piPackageEntries = @($piRecords | Where-Object { $_.package } | ForEach-Object { '../../' + $_.package })
$piSkillEntries = @($piRecords | Where-Object { $_.skills } | ForEach-Object { '../../' + $_.skills })
$piExecutable = if ($piLayers.Count -gt 0) { Find-WrappedExecutable $PiCommand } else { $null }
$piCmdText = $null
$piShText = $null
if ($piExecutable) {
    $piCmdText = New-PiCmdText -Executable $piExecutable -AgentDir $piAgentDir
    $piShText = New-PiShText -AgentDir $piAgentDir
} elseif ($piLayers.Count -gt 0) {
    Write-Warning "Pi CLI not found: no '$PiCommand' application outside .maxstack\bin. Skipping $piCmdTarget and $piShTarget. Install Pi, then rerun with -Apply."
}
$piSettings = $null
if ($piSelected -and ($piLayers.Count -gt 0 -or (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf))) {
    $piSettings = Get-PiSettings -Packages $piPackageEntries -Skills $piSkillEntries `
        -OwnedPackages (Get-OwnedPiEntries -Owned $priorOwned -LegacyPi $priorPi -Key 'packages') `
        -OwnedSkills (Get-OwnedPiEntries -Owned $priorOwned -LegacyPi $priorPi -Key 'skills')
}

# The config is OpenCode's. Without the opencode runtime it is neither built nor written. A config layer whose root is
# unknown (a git cache not yet at its pin) makes the whole document unknown, since its fragment is merged into it.
$configUnknown = @($layers | Where-Object { $_.kind -eq 'config' -and $null -eq $_.root }).Count -gt 0
$document = $null
if ($openCodeSelected -and -not $configUnknown) {
    $base = Get-Content -LiteralPath $baseConfigFile -Raw | ConvertFrom-Json
    $serverMaps = @()
    $extraPermissions = @()
    foreach ($layer in $layers) {
        if ($layer.kind -ne 'config') { continue }
        $layerJson = Read-LayerJson $layer.root
        $fragmentName = Get-Field $layerJson 'config'
        $fragmentPath = Join-Path $layer.root $(if ($fragmentName) { $fragmentName } else { 'opencode.fragment.jsonc' })
        if (-not (Test-Path -LiteralPath $fragmentPath -PathType Leaf)) {
            throw "Layer '$($layer.name)' has no config fragment: $fragmentPath"
        }
        $fragment = Get-Content -LiteralPath $fragmentPath -Raw | ConvertFrom-Json
        $mcpProperty = $fragment.PSObject.Properties['mcp']
        if ($mcpProperty) {
            $serversProperty = $mcpProperty.Value.PSObject.Properties['servers']
            if ($serversProperty) { $serverMaps += $serversProperty.Value }
        }
        $permissionProperty = $fragment.PSObject.Properties['permissions']
        if ($permissionProperty) { $extraPermissions += $permissionProperty.Value }
    }

    $servers = [ordered]@{}
    foreach ($map in $serverMaps) {
        foreach ($property in $map.PSObject.Properties) {
            $servers[$property.Name] = $property.Value
        }
    }

    if (-not $base.PSObject.Properties['mcp']) {
        $base | Add-Member -NotePropertyName mcp -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not $base.mcp.PSObject.Properties['servers']) {
        $base.mcp | Add-Member -NotePropertyName servers -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    foreach ($name in $servers.Keys) {
        $base.mcp.servers | Add-Member -NotePropertyName $name -NotePropertyValue $servers[$name] -Force
    }
    if ($extraPermissions.Count -gt 0) {
        $base.permissions = @($base.permissions) + $extraPermissions
    }
    # A nested entry point is named here, relative to this file, so the path holds no
    # machine-specific root. Root-level index.ts entries load on their own and are not listed.
    $pluginEntries = @($openCodeLayers | ForEach-Object { Get-OpenCodePluginPath -Layer $_ -Spec $openCodeSpecs[$_.name] } | Where-Object { $_ })
    if ($pluginEntries.Count -gt 0) {
        $base | Add-Member -NotePropertyName plugin -NotePropertyValue $pluginEntries -Force
    }
    $document = ($base | ConvertTo-Json -Depth 100)
}

# Apply needs the plan, and status needs it only to compare with a record. Audit does not need it.
# A pinned layer whose cache is not at its pin cannot say which Pi entries it adds. Only those entries
# are unknown; every other entry is known.
$piUnknown = @{ packages = @(); skills = @() }
foreach ($record in $piRecords) {
    if (-not $record.pending) { continue }
    $piUnknown.packages += "../../$($record.unknownPackage)"
    $piUnknown.skills += "../../$($record.unknownSkills)"
}

# The backup each replaced file gets, and the text it had when the install read it. Decided before any write, so the
# plan records the backup and the write makes exactly that copy.
$configBackupTarget = [pscustomobject]@{ action = 'none'; path = $null }
$configSourceSha = $null
if ($null -ne $document) {
    $configSourceSha = Get-FileSha256OrNull $configTarget
    $configBackupTarget = Get-BackupTarget -Path $configTarget -LastSha $priorOpenCodeSha -NewText $document -Created ($priorCreatedFiles -ccontains 'opencode.jsonc') -RecordedOriginalSha (Get-PriorOriginalSha 'opencode.jsonc')
}
$settingsBackupTarget = [pscustomobject]@{ action = 'none'; path = $null }
if ($null -ne $piSettings -and -not $piPending) {
    $settingsBackupTarget = Get-BackupTarget -Path $piSettingsTarget -LastSha $priorSettingsSha -NewText $piSettings.text -Created ($priorCreatedFiles -ccontains '.pi/agent/settings.json') -RecordedOriginalSha (Get-PriorOriginalSha '.pi/agent/settings.json')
}

# A removal that stopped after it journaled a quarantine leaves the moved folder beside the recorded one. A plain apply
# deletes that folder first when its tree still has the journaled hash: it is the installer's own copy, and the folder
# is written again. Otherwise the apply keeps the folder and its journal, and names the folder and the reason once.
$keptJournals = @{}
if ($Apply -and -not $removing -and -not $uninstalling -and $null -ne $priorOwned) {
    foreach ($record in @($priorOwned | Where-Object { $_.kind -eq 'dir' -and $null -ne (Get-Field $_ 'quarantine') })) {
        $entry = Resolve-WorkspaceEntry $record.path
        if (-not $entry.ok) { continue }
        $quarantine = "$($entry.full)$quarantineSuffix"
        if (-not (Test-Path -LiteralPath $quarantine)) { continue }
        $leaf = Split-Path -Leaf $quarantine
        if (-not (Test-ReparsePoint $quarantine) -and ((Get-TreeSha256 $quarantine) -eq $record.sha256)) {
            Remove-OwnedTree $quarantine
            Write-Host "Deleted $leaf, the quarantine an interrupted removal left for $($record.path)."
        } else {
            $keptJournals[$record.path] = $leaf
            Write-Host ('SKIP     {0}  kept: {1} holds files that changed since its removal began, so it is not deleted. The folder is written again beside it; delete or move {1} aside by hand.' -f $record.path, $leaf)
        }
    }
}

$plan = @()
if ($Apply -or $removing -or $updating -or ($Status -and $null -ne $priorOwned)) {
    $plan = Get-OwnedPlan -Document $document -Layers $layers -ClaudeRecords $claudeRecords -OpenCodeLayers $openCodeLayers `
        -OpenCodeSpecs $openCodeSpecs -CopilotCmdText $copilotCmdText -CopilotShText $copilotShText `
        -PiCmdText $piCmdText -PiShText $piShText -PiSettings $piSettings -PiPending $piPending -PiUnknown $piUnknown
}

# The Claude plugin folders, and the OpenCode folders that no unselected layer owns. An unselected
# runtime's folders and files are left alone, so neither apply nor audit touches them.
$staleOpenCodeFolders = @()
if ($openCodeSelected) {
    $staleOpenCodeFolders = @(Get-StalePluginFolders -Wanted @($openCodeLayers | ForEach-Object { $_.name }) | Where-Object { $unselectedLayerNames -notcontains $_.Name })
}

# -Update reports what the recorded sources would move to before anything is applied, so the report is the same with or
# without -Apply. Its count is the number of changes -Strict counts.
$updateChanges = 0
if ($updating) {
    $updateChanges = Write-UpdateReport -Layers $allLayers -PriorStack $priorStack -SelectedLayers $selectedLayers `
        -SelectedRuntimes $selectedRuntimes -Plan $plan -Owned $priorOwned -NotSelected @(Get-NotSelectedPaths -SelectedRuntimes $selectedRuntimes)
}

if ($Status) {
    if ($null -eq $priorStack) {
        Write-Host 'Selection: none recorded; an apply selects all'
    } else {
        $legacyNote = if ($null -eq (Get-Field $priorStack 'selection')) { ' (the lock predates the selection, so all)' } else { '' }
        Write-Host ((Format-Selection -Runtimes $selectedRuntimes -Layers $selectedLayers) + $legacyNote)
    }
    Write-SourcePinBlock -Entries (Get-RecordedSourceEntries $priorStack)
    if ($null -eq $priorOwned) {
        Write-Host 'no ownership record; run -Apply once to create it'
        if ($Strict) { exit 1 }
        return
    }
    $notSelected = @(Get-NotSelectedPaths -SelectedRuntimes $selectedRuntimes)
    $results = @(Get-OwnershipReport -Recorded $priorOwned -Plan $plan -SelectedRuntimes $selectedRuntimes -NotSelected $notSelected)
    foreach ($note in $unselectedNotes) {
        $results += [pscustomobject]@{ state = 'not selected'; label = "$($note.kind) $($note.name) (add with $($note.flag) $($note.name))" }
    }
    foreach ($result in $results) { Write-Host ('{0,-12} {1}' -f $result.state, $result.label) }
    $counts = foreach ($state in @('matching', 'drifted', 'modified', 'missing', 'untracked', 'not selected')) {
        "$(@($results | Where-Object { $_.state -eq $state }).Count) $state"
    }
    Write-Host ('Summary: ' + ($counts -join ', '))
    if ($Strict -and @($results | Where-Object { $_.state -notin @('matching', 'not selected') }).Count -gt 0) { exit 1 }
    return
}

if (-not $Apply) {
    Write-Host "Workspace:      $Workspace"
    Write-Host (Format-Selection -Runtimes $selectedRuntimes -Layers $selectedLayers)
    Write-SourcePinBlock -Entries (Get-ResolvedSourceEntries -Layers $allLayers)
    foreach ($layer in $layers) {
        $where = if ($layer.root) { $layer.root } elseif ($layer.sourceKind -eq 'local') { "$($layer.localPath): folder missing" } else { "pinned $($layer.url) at $($layer.commit)" }
        Write-Host ("Layer:          {0} ({1}) at {2}" -f $layer.name, $layer.kind, $where)
    }
    if ($openCodeSelected) {
        Write-Host "Config target:  $configTarget"
        $configState = if ($configUnknown) { 'unknown until -Apply syncs the layer cache' } else { Get-DriftState -Path $configTarget -Text $document }
        Write-Host ("Drift:          {0}: {1}" -f $configTarget, $configState)
    }
    if ($claudeSelected) {
        $wantedClaude = @($claudeRecords | ForEach-Object { $_.plugin })
        foreach ($record in $claudeRecords) {
            $child = Join-Path $claudePluginsTarget $record.plugin
            $target = if ($record.kind -eq 'junction') { Join-Path $Workspace $record.target } else { $null }
            $prior = Get-Field $priorLayers[$record.layer] 'claude'
            Write-Host ("Drift:          {0}: {1}" -f $child, (Get-ClaudeChildState -Record $record -Prior $prior -Child $child -Target $target))
        }
        if (Test-Path -LiteralPath $claudePluginsTarget -PathType Container) {
            foreach ($entry in Get-ChildItem -LiteralPath $claudePluginsTarget -Force) {
                if ($wantedClaude -notcontains $entry.Name -and $unselectedLayerNames -notcontains $entry.Name) { Write-Host ("Drift:          {0}: stale" -f $entry.FullName) }
            }
        }
    }
    foreach ($layer in $openCodeLayers) {
        $spec = $openCodeSpecs[$layer.name]
        $folder = Join-Path $opencodePluginsTarget $layer.name
        $entryPath = Join-Path $folder ($spec.entry -replace '/', '\')
        $prior = Get-Field $priorLayers[$layer.name] 'opencode'
        $plugin = Get-OpenCodePluginPath -Layer $layer -Spec $spec
        Write-Host ("Drift:          {0}: {1}" -f $folder, (Get-OpenCodeState -EntryPath $entryPath -Prior $prior -Entry $spec.entry -Plugin $plugin))
    }
    foreach ($entry in $staleOpenCodeFolders) {
        Write-Host ("Drift:          {0}: stale" -f $entry.FullName)
    }
    if ($copilotSelected) {
        if ($copilotCmdText) {
            Write-Host ("Drift:          {0}: {1}" -f $copilotCmdTarget, (Get-DriftState -Path $copilotCmdTarget -Text $copilotCmdText))
            Write-Host ("Drift:          {0}: {1}" -f $copilotShTarget, (Get-DriftState -Path $copilotShTarget -Text $copilotShText))
        } else {
            foreach ($path in @($copilotCmdTarget, $copilotShTarget)) {
                if (Test-Path -LiteralPath $path -PathType Leaf) { Write-Host ("Drift:          {0}: stale" -f $path) }
            }
        }
    }
    if ($piSelected) {
        if ($piCmdText) {
            Write-Host ("Drift:          {0}: {1}" -f $piCmdTarget, (Get-DriftState -Path $piCmdTarget -Text $piCmdText))
            Write-Host ("Drift:          {0}: {1}" -f $piShTarget, (Get-DriftState -Path $piShTarget -Text $piShText))
        } else {
            foreach ($path in @($piCmdTarget, $piShTarget)) {
                if (Test-Path -LiteralPath $path -PathType Leaf) { Write-Host ("Drift:          {0}: stale" -f $path) }
            }
        }
        if ($piPending) {
            Write-Host ("Drift:          {0}: unknown until -Apply syncs the pstack cache" -f $piSettingsTarget)
        } elseif ($piSettings) {
            Write-Host ("Drift:          {0}: {1}" -f $piSettingsTarget, (Get-DriftState -Path $piSettingsTarget -Text $piSettings.text))
        }
    }
    if ($removing) {
        Write-RemovalDryRun -Records $priorOwned -Plan $plan -SelectedRuntimes $selectedRuntimes -SelectedLayers $selectedLayers
        return
    }
    if ($updating) {
        Write-UpdateSummary -Changes $updateChanges
        Write-Host 'Dry run: nothing was written. Rerun with -Update -Apply to move the sources and apply the change.'
        if ($Strict -and $updateChanges -gt 0) { exit 1 }
        return
    }
    Write-Host 'Audit only. No files or workspace configuration changed. Rerun with -Apply after reviewing.'
    return
}

if ($openCodeSelected) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $configTarget) -Force | Out-Null
    if ((Test-Path -LiteralPath $configTarget) -and ((Get-Content -LiteralPath $configTarget -Raw).Trim() -eq $document.Trim())) {
        Write-Host "Config already matches: $configTarget"
    } else {
        if ($configBackupTarget.action -in @('original', 'edited')) {
            Copy-Item -LiteralPath $configTarget -Destination $configBackupTarget.path -Force
            Write-Host "Backed up the previous config to $($configBackupTarget.path)"
        } elseif ($configBackupTarget.action -eq 'duplicate') {
            Write-Host "The previous config is already kept in $($configBackupTarget.path), so no new copy was made."
        }
        Assert-UnchangedSince $configTarget $configSourceSha
        Write-FileAtomically $configTarget $document
        Write-Host "Wrote $configTarget"
    }
}

# Each OpenCode layer gets its own folder under .opencode\plugins, holding the items the
# layer names. The entry's own folder is the npm install point, so its SDK resolves there.
$agentNamesByLayer = @{}
foreach ($layer in $openCodeLayers) {
    $spec = $openCodeSpecs[$layer.name]
    $claudeDeclared = $layer.runtimes.ContainsKey('claude')
    $folder = Join-Path $opencodePluginsTarget $layer.name
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    # The folder is wholly the installer's. What the layer no longer installs is removed, and each item is
    # replaced by a fresh copy, so the folder holds exactly what the layer names.
    $items = @(Get-OpenCodeItems -Layer $layer -Root $layer.root | Where-Object { $_ -ne '.claude-plugin' -or $claudeDeclared })
    Remove-FolderExtras -Folder $folder -Items $items -Top
    foreach ($item in $items) {
        $source = Join-Path $layer.root $item
        if (-not (Test-Path -LiteralPath $source)) { throw "Plugin layer '$($layer.name)' is missing: $source" }
        $destination = Join-Path $folder $item
        Remove-OwnedTree $destination
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
    $entryPath = Join-Path $folder ($spec.entry -replace '/', '\')
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
        throw "Plugin layer '$($layer.name)' has no entry at $entryPath. Check runtimes.opencode.entry in layers.json."
    }
    Write-Host "Copied plugin layer '$($layer.name)' into $folder"

    $installDir = if ($spec.dir -eq '') { $folder } else { Join-Path $folder ($spec.dir -replace '/', '\') }
    $shippedLocks = Get-ShippedLocks $installDir
    if ((Test-Path -LiteralPath (Join-Path $installDir 'package.json') -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $installDir 'node_modules\@opencode\plugin'))) {
        Write-Host 'Installing plugin dependencies'
        # --ignore-scripts: a layer's own install scripts, and its dependencies', never run from a checkout the installer reads.
        & npm install --prefix $installDir --omit=dev --no-audit --no-fund --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw "npm install failed in $installDir" }
        Write-IgnoredScriptWarning -Name $layer.name -Folder $installDir
    }
    Resolve-NpmLocks -Folder $installDir -Shipped $shippedLocks

    $agentNamesByLayer[$layer.name] = @()
    if ($spec.agents) {
        $agentsSource = Join-Path $layer.root ($spec.agents -replace '/', '\')
        if (-not (Test-Path -LiteralPath $agentsSource -PathType Container)) {
            throw "Plugin layer '$($layer.name)' names agents at $agentsSource, which does not exist."
        }
        New-Item -ItemType Directory -Path $agentsTarget -Force | Out-Null
        foreach ($agent in @(Get-ChildItem -LiteralPath $agentsSource -Filter '*.md')) {
            $destination = Join-Path $agentsTarget $agent.Name
            Copy-Item -LiteralPath $agent.FullName -Destination $destination -Force
            Remove-AgentModel -Path $destination
            Write-Host "Installed agent profile $($agent.Name)"
            $agentNamesByLayer[$layer.name] += $agent.Name
        }
    }
}

# A folder under .opencode\plugins that no selected layer names goes when the previous lock
# recorded it, or when it is the retired port's folder. Any other folder is kept.
foreach ($entry in $staleOpenCodeFolders) {
    # A quarantine beside a recorded folder is named with that folder, once, by the removal journal check.
    if ($entry.Name.EndsWith($quarantineSuffix)) {
        $recordedBase = '.opencode/plugins/' + $entry.Name.Substring(0, $entry.Name.Length - $quarantineSuffix.Length)
        if (@($priorOwned | Where-Object { $null -ne $_ -and $_.kind -eq 'dir' -and $_.path -ceq $recordedBase }).Count -gt 0) { continue }
    }
    if (($priorOpenCodeFolders -contains $entry.Name) -or ($retiredOpenCodeFolders -contains $entry.Name)) {
        Remove-OwnedTree $entry.FullName
        Write-Host "Removed the stale plugin folder $($entry.FullName)"
    } else {
        Write-Host ("Drift:          {0}: stale, kept because the previous stack.lock.json does not record it" -f $entry.FullName)
    }
}

# Build the Claude children. A local child is a junction to the installed copy when opencode is
# selected, and a copy of its items when it is not. A git child is a copy of the pinned plugin folder.
$layerByName = @{}
foreach ($layer in $layers) { $layerByName[$layer.name] = $layer }
if ($claudeSelected) {
    New-Item -ItemType Directory -Path $claudePluginsTarget -Force | Out-Null
    foreach ($record in $claudeRecords) {
        $child = Join-Path $claudePluginsTarget $record.plugin
        if ($record.kind -eq 'junction') {
            $target = Join-Path $Workspace $record.target
            if (-not (Test-ClaudeJunction -Child $child -Target $target)) {
                Remove-ClaudeChild $child
                New-Item -ItemType Junction -Path $child -Target $target | Out-Null
                Write-Host "Linked Claude plugin '$($record.plugin)' to $target"
            }
        } elseif ($record.kind -eq 'copy' -and $null -ne $record.items) {
            Remove-ClaudeChild $child
            Copy-LayerItems -Root $layerByName[$record.layer].root -Items $record.items -Destination $child
            Write-Host "Copied Claude plugin '$($record.plugin)' from $($layerByName[$record.layer].root)"
        } else {
            Remove-ClaudeChild $child
            Copy-WholeFolder -Root $layerByName[$record.layer].root -Destination $child
            if ($null -ne (Get-Field $record 'url')) {
                Write-Host "Copied Claude plugin '$($record.plugin)' from $($record.url) at $($record.commit)"
            } else {
                Write-Host "Copied Claude plugin '$($record.plugin)' from $($layerByName[$record.layer].root)"
            }
        }
        $declared = Get-Field (Get-Content -LiteralPath (Join-Path $child '.claude-plugin\plugin.json') -Raw | ConvertFrom-Json) 'name'
        if ($declared -ne $record.plugin) {
            throw "Claude plugin '$($record.plugin)' materialised at $child names '$declared' in its manifest."
        }
    }
    if (Test-Path -LiteralPath $claudePluginsTarget -PathType Container) {
        $wantedClaude = @($claudeRecords | ForEach-Object { $_.plugin })
        foreach ($entry in Get-ChildItem -LiteralPath $claudePluginsTarget -Force) {
            if (($wantedClaude -notcontains $entry.Name) -and ($unselectedLayerNames -notcontains $entry.Name)) {
                Remove-ClaudeChild $entry.FullName
                Write-Host "Removed the stale Claude plugin $($entry.Name)"
            }
        }
    }
}

# The Copilot wrappers run the Claude folders above, so they are written last.
if ($copilotCmdText) {
    New-Item -ItemType Directory -Path $copilotBinTarget -Force | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($copilotCmdTarget, $copilotCmdText, $utf8)
    [IO.File]::WriteAllText($copilotShTarget, $copilotShText, $utf8)
    Set-ShellExecutable $copilotShTarget
    Write-Host "Wrote $copilotCmdTarget and $copilotShTarget"
} elseif ($copilotSelected) {
    foreach ($path in @($copilotCmdTarget, $copilotShTarget)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-WrapperIfRecorded -Path $path
        }
    }
}

# The Pi settings and wrappers come after the Claude folders, so every package and skills folder
# they name is installed when they are written.
foreach ($record in $piRecords) {
    if ($record.package) { Assert-PiKeyInstalled $record }
    if ($record.skills -and -not (Test-Path -LiteralPath (Join-Path $Workspace ($record.skills -replace '/', '\')) -PathType Container)) {
        throw "Layer '$($record.layer)' has no skills folder at $($record.skills) after the install. Check runtimes.pi and the layer's files list."
    }
}
if ($piSettings) {
    $piSettingsText = $piSettings.text
    New-Item -ItemType Directory -Path $piAgentDir -Force | Out-Null
    if ((Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) -and ((Get-Content -LiteralPath $piSettingsTarget -Raw).Trim() -eq $piSettingsText.Trim())) {
        Write-Host "Pi settings already match: $piSettingsTarget"
    } else {
        if ($settingsBackupTarget.action -in @('original', 'edited')) {
            Copy-Item -LiteralPath $piSettingsTarget -Destination $settingsBackupTarget.path -Force
            Write-Host "Backed up the previous Pi settings to $($settingsBackupTarget.path)"
        } elseif ($settingsBackupTarget.action -eq 'duplicate') {
            Write-Host "The previous Pi settings are already kept in $($settingsBackupTarget.path), so no new copy was made."
        }
        Assert-UnchangedSince $piSettingsTarget $piSettings.sourceSha
        Write-FileAtomically $piSettingsTarget $piSettingsText
        Write-Host "Wrote $piSettingsTarget"
    }
}
if ($piCmdText) {
    New-Item -ItemType Directory -Path $copilotBinTarget -Force | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($piCmdTarget, $piCmdText, $utf8)
    [IO.File]::WriteAllText($piShTarget, $piShText, $utf8)
    Set-ShellExecutable $piShTarget
    Write-Host "Wrote $piCmdTarget and $piShTarget"
} elseif ($piSelected) {
    foreach ($path in @($piCmdTarget, $piShTarget)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-WrapperIfRecorded -Path $path
        }
    }
}

$claudeByLayer = @{}
foreach ($record in $claudeRecords) { $claudeByLayer[$record.layer] = $record }
# A layer that installs nothing this run is recorded disabled, and a pinned one keeps its pin.
$layerRecords = foreach ($layer in $allLayers) {
    $record = $claudeByLayer[$layer.name]
    if ($record) {
        $child = Join-Path $claudePluginsTarget $record.plugin
        $treeSha = Get-LegacyTreeSha256 $child
        if ($record.kind -eq 'junction') {
            $claude = [pscustomobject]@{
                enabled    = $true
                plugin     = $record.plugin
                kind       = 'junction'
                child      = ".claude/plugins/$($record.plugin)"
                target     = $record.target
                treeSha256 = $treeSha
            }
        } elseif ($record.kind -eq 'copy') {
            $claude = [pscustomobject]@{
                enabled    = $true
                plugin     = $record.plugin
                kind       = 'copy'
                child      = ".claude/plugins/$($record.plugin)"
                treeSha256 = $treeSha
            }
        } else {
            $claude = [pscustomobject]@{
                enabled    = $true
                plugin     = $record.plugin
                kind       = 'git'
                child      = ".claude/plugins/$($record.plugin)"
                repository = $record.url
                path       = $record.path
                commit     = $record.commit
                treeSha256 = $treeSha
            }
        }
    } else {
        $claude = [pscustomobject]@{ enabled = $false }
    }

    if ($openCodeSpecs.ContainsKey($layer.name)) {
        $spec = $openCodeSpecs[$layer.name]
        $opencode = [pscustomobject]@{
            enabled = $true
            folder  = ".opencode/plugins/$($layer.name)"
            entry   = $spec.entry
            loader  = $spec.loader
            plugin  = Get-OpenCodePluginPath -Layer $layer -Spec $spec
            agents  = @($agentNamesByLayer[$layer.name])
        }
    } else {
        $opencode = [pscustomobject]@{ enabled = $false }
    }

    $copilotRecord = if ($layer.runtimes.ContainsKey('copilot')) {
        [pscustomobject]@{ enabled = $true; pluginDir = ".claude/plugins/$($layer.name)" }
    } else {
        [pscustomobject]@{ enabled = $false }
    }

    $piRecord = if ($piByLayer.ContainsKey($layer.name)) {
        [pscustomobject]@{ enabled = $true; package = $piByLayer[$layer.name].package; skills = $piByLayer[$layer.name].skills }
    } else {
        [pscustomobject]@{ enabled = $false }
    }

    [pscustomobject]@{
        name     = $layer.name
        kind     = $layer.kind
        path     = $layer.localPath
        source   = New-SourceRecord $layer
        commit   = $layer.commit
        claude   = $claude
        opencode = $opencode
        copilot  = $copilotRecord
        pi       = $piRecord
    }
}

$copilotLock = if ($copilotCmdText) {
    [pscustomobject]@{
        enabled    = $true
        executable = [IO.Path]::GetFileName($copilotExecutable)
        wrappers   = @('.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh')
        cmdSha256  = Get-TextSha256 $copilotCmdText
        shSha256   = Get-TextSha256 $copilotShText
    }
} else {
    $reason = if (-not $copilotSelected) { 'not selected' } elseif ($copilotLayers.Count -eq 0) { 'no layer declares copilot' } else { "no '$CopilotCommand' application outside .maxstack\bin" }
    [pscustomobject]@{ enabled = $false; reason = $reason }
}

# The hash of the Pi settings file as the last apply left it. -Remove and -Uninstall restore a backup only while the
# file still holds it. A run that does not write the settings keeps the hash the last write recorded.
$settingsSha = $priorSettingsSha
if (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) {
    if ($piSettings) { $settingsSha = (Get-FileHash -LiteralPath $piSettingsTarget -Algorithm SHA256).Hash }
} else {
    $settingsSha = $null
}

$piLock = if ($piCmdText) {
    [pscustomobject]@{
        enabled        = $true
        executable     = [IO.Path]::GetFileName($piExecutable)
        wrappers       = @('.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh')
        cmdSha256      = Get-TextSha256 $piCmdText
        shSha256       = Get-TextSha256 $piShText
        agentDir       = '.pi/agent'
        packages       = @($piPackageEntries)
        skills         = @($piSkillEntries)
        settingsSha256 = $settingsSha
    }
} else {
    $reason = if (-not $piSelected) { 'not selected' } elseif ($piLayers.Count -eq 0) { 'no layer declares pi' } else { "no '$PiCommand' application outside .maxstack\bin" }
    [pscustomobject]@{
        enabled        = $false
        reason         = $reason
        agentDir       = '.pi/agent'
        packages       = @($piPackageEntries)
        skills         = @($piSkillEntries)
        settingsSha256 = $settingsSha
    }
}

# The Pi keys this apply created in a settings file that already existed, or kept from an earlier apply.
# A settings file the apply created is listed in createdFiles instead.
$priorCreatedKeys = @()
if ($null -ne $priorOwned) {
    $priorCreatedKeys = @($priorOwned | Where-Object { $_.kind -eq 'json-entries' -and (Get-Field $_ 'createdKey') -eq $true } | ForEach-Object { $_.key })
}
$settingsNow = $null
if (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) { $settingsNow = Get-Content -LiteralPath $piSettingsTarget -Raw | ConvertFrom-Json }
$createdKeys = @{}
foreach ($key in @('packages', 'skills')) {
    $presentNow = ($null -ne $settingsNow) -and ($null -ne $settingsNow.PSObject.Properties[$key])
    $createdHere = $settingsFileBefore -and -not ($settingsKeysBefore -ccontains $key)
    $createdKeys[$key] = [bool]($presentNow -and ($createdHere -or ($priorCreatedKeys -ccontains $key)))
}
$createdDirs = @(Get-CreatedPaths -Candidates $installerDirs -Prior $priorCreatedDirs -ExistedBefore $existedBefore -Kind 'dir')
$createdFiles = @(Get-CreatedPaths -Candidates $replacedFileNames -Prior $priorCreatedFiles -ExistedBefore $existedBeforeFiles -Kind 'file')

# The ownership record: every path this apply wrote, after the writes, so -Status and a later
# remove or uninstall know what is theirs. It holds no path outside the workspace and not the lock.
$owned = Get-OwnedRecords -Plan $plan -CreatedKeys $createdKeys
# A kept quarantine keeps its journal on the folder's new record, so a later removal knows which quarantine is the removal's.
foreach ($keptPath in @($keptJournals.Keys)) {
    foreach ($record in @($owned | Where-Object { $_.path -ceq $keptPath -and $_.kind -eq 'dir' })) {
        $record | Add-Member -NotePropertyName quarantine -NotePropertyValue $keptJournals[$keptPath] -Force
    }
}

$stack = [pscustomobject]@{
    generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
    workspace    = $workspaceName
    selection    = [pscustomobject]@{ runtimes = @($selectedRuntimes); layers = @($selectedLayers) }
    configSha256 = if ($null -ne $document) { Get-TextSha256 $document } else { $null }
    copilot      = $copilotLock
    pi           = $piLock
    layers       = $layerRecords
    ownedSchema  = $ownedSchemaVersion
    owned        = @($owned)
    createdDirs  = $createdDirs
    createdFiles = $createdFiles
}
if ($removing) {
    # The removal writes the lock: it keeps the records this selection produces, and each record it removes
    # leaves the lock once its file is gone.
    Invoke-RemovalFlow -Stack $stack -PlanRecords $owned -Plan $plan
    return
}
# Leftovers of an interrupted write or removal beside the recorded files: named, and deleted when the lock knows their bytes.
$knownNow = @(@($owned) + @($priorOwned) | Where-Object { $null -ne $_ })
$settingsNowSha = if (($null -ne $piSettings) -and -not $piPending) { Get-TextSha256 $piSettingsText } else { $priorSettingsSha }
Invoke-StrayReport -Known $knownNow -ConfigSha $stack.configSha256 -SettingsSha $settingsNowSha
Write-LockAtomically -Text ($stack | ConvertTo-Json -Depth 8)
Write-Host "Wrote $stackTarget"

Write-Host 'Workspace bundle installed from the layer manifest.'
Write-Host 'Restart the running OpenCode server, then start a new T3 session to load it: T3 can reuse that server across sessions. Claude Code reads plugins when a session starts. Pi reads its settings when a session starts.'
