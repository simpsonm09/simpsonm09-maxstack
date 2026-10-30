# platforms: windows
#requires -Version 7.0
Set-StrictMode -Version Latest

function Get-MaxstackSafePathDisplay {
    param([string] $Path)
    $display = [Text.StringBuilder]::new()
    foreach ($character in $Path.ToCharArray()) {
        $code = [int] $character
        if ($code -lt 32 -or $code -eq 127) {
            [void] $display.Append(('\u{0:X4}' -f $code))
        }
        else {
            [void] $display.Append($character)
        }
    }
    return $display.ToString()
}

function Assert-MaxstackPathHasNoControlCharacters {
    param([string] $Path, [string] $Name)

    foreach ($character in $Path.ToCharArray()) {
        $code = [int] $character
        if ($code -lt 32 -or $code -eq 127) {
            $display = Get-MaxstackSafePathDisplay $Path
            throw "$Name path contains control characters: $display"
        }
    }
}

function ConvertTo-MaxstackFullPath {
    param([string] $Path, [string] $BaseDirectory)

    Assert-MaxstackPathHasNoControlCharacters $Path 'Workspace'
    Assert-MaxstackPathHasNoControlCharacters $BaseDirectory 'Base directory'
    $safePath = Get-MaxstackSafePathDisplay $Path
    try {
        if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
        return [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
    }
    catch {
        throw "Workspace path is invalid: $safePath"
    }
}

function Assert-MaxstackWorkspaceTarget {
    param([string] $Path, [string] $Source)

    Assert-MaxstackPathHasNoControlCharacters $Path $Source
    $safePath = Get-MaxstackSafePathDisplay $Path
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
            throw "$Source target does not exist or is not a directory: $safePath"
        }
        $item = Get-Item -LiteralPath $Path -Force
        if (-not $item.PSIsContainer) { throw "$Source target is not a directory: $safePath" }
        return [IO.Path]::GetFullPath($item.FullName)
    }
    catch {
        if ($_.Exception.Message -like "$Source target does not exist*" -or $_.Exception.Message -like "$Source target is not a directory*") { throw }
        throw "$Source target could not be checked: $safePath"
    }
}

function Find-MaxstackCwdMarker {
    param([string] $CurrentDirectory)

    $cursor = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($CurrentDirectory))
    while ($null -ne $cursor) {
        foreach ($name in @('maxstack.settings.json', 'stack.lock.json')) {
            $marker = Join-Path $cursor.FullName $name
            if (Test-Path -LiteralPath $marker -PathType Leaf) {
                return [pscustomobject]@{ Path = $cursor.FullName; Marker = $name }
            }
        }
        $cursor = $cursor.Parent
    }
    return $null
}

function Get-MaxstackScriptLayoutWorkspace {
    param([string] $ScriptRoot)

    Assert-MaxstackPathHasNoControlCharacters $ScriptRoot 'Script root'
    try { $fullScriptRoot = [IO.Path]::GetFullPath($ScriptRoot) }
    catch { throw "Script root is invalid: $(Get-MaxstackSafePathDisplay $ScriptRoot)" }
    $scriptDirectory = [IO.DirectoryInfo]::new($fullScriptRoot)
    if ($scriptDirectory.Name -ine 'scripts') { return $null }
    $repo = $scriptDirectory.Parent
    if ($null -eq $repo) { return $null }
    $layoutDirectory = $repo.Parent
    if ($null -eq $layoutDirectory -or $layoutDirectory.Name -ine 'repos' -and $layoutDirectory.Name -ine 'worktrees') { return $null }
    $projectsDirectory = $layoutDirectory.Parent
    if ($null -eq $projectsDirectory -or $projectsDirectory.Name -ine 'projects') { return $null }
    $workspace = $projectsDirectory.Parent
    if ($null -eq $workspace) { return $null }
    return $workspace.FullName
}

function Resolve-MaxstackWorkspace {
    [CmdletBinding()]
    param(
        [switch] $ExplicitSpecified,
        [AllowNull()][string] $ExplicitValue,
        [string] $CurrentDirectory = (Get-Location).Path,
        [string] $ScriptRoot = $PSScriptRoot,
        [AllowNull()][string] $LegacyWorkspace = $null
    )

    if ((Get-Location).Provider.Name -cne 'FileSystem') {
        throw 'Workspace discovery requires a filesystem current location.'
    }
    Assert-MaxstackPathHasNoControlCharacters $CurrentDirectory 'Current directory'
    $safeCurrentDirectory = Get-MaxstackSafePathDisplay $CurrentDirectory
    try {
        if (-not (Test-Path -LiteralPath $CurrentDirectory -PathType Container)) {
            throw "Current directory does not exist or is not a filesystem directory: $safeCurrentDirectory"
        }
        $cwd = [IO.Path]::GetFullPath($CurrentDirectory)
    }
    catch {
        if ($_.Exception.Message -like 'Current directory does not exist*') { throw }
        throw "Current directory could not be checked: $safeCurrentDirectory"
    }

    if ($ExplicitSpecified) {
        if ([string]::IsNullOrWhiteSpace($ExplicitValue)) { throw '-Workspace was explicitly supplied but is empty.' }
        Assert-MaxstackPathHasNoControlCharacters $ExplicitValue '-Workspace'
        $target = Assert-MaxstackWorkspaceTarget (ConvertTo-MaxstackFullPath $ExplicitValue $cwd) '-Workspace'
        return [pscustomobject]@{ Workspace = $target; Origin = '-Workspace'; Warning = $false }
    }

    $environmentWorkspace = [Environment]::GetEnvironmentVariable('MAXSTACK_WORKSPACE')
    if ($null -ne $environmentWorkspace) {
        if ([string]::IsNullOrWhiteSpace($environmentWorkspace)) { throw 'MAXSTACK_WORKSPACE is set but empty.' }
        Assert-MaxstackPathHasNoControlCharacters $environmentWorkspace 'MAXSTACK_WORKSPACE'
        $target = Assert-MaxstackWorkspaceTarget (ConvertTo-MaxstackFullPath $environmentWorkspace $cwd) 'MAXSTACK_WORKSPACE'
        return [pscustomobject]@{ Workspace = $target; Origin = 'MAXSTACK_WORKSPACE'; Warning = $false }
    }

    $marker = Find-MaxstackCwdMarker $cwd
    if ($null -ne $marker) {
        $target = Assert-MaxstackWorkspaceTarget $marker.Path "cwd marker $($marker.Marker)"
        return [pscustomobject]@{ Workspace = $target; Origin = "cwd marker $($marker.Marker)"; Warning = $false }
    }

    $layoutWorkspace = Get-MaxstackScriptLayoutWorkspace $ScriptRoot
    if ($null -ne $layoutWorkspace -and (Test-Path -LiteralPath $layoutWorkspace -PathType Container)) {
        $target = Assert-MaxstackWorkspaceTarget $layoutWorkspace 'script layout'
        return [pscustomobject]@{ Workspace = $target; Origin = 'script layout'; Warning = $false }
    }

    if (-not [string]::IsNullOrWhiteSpace($LegacyWorkspace)) {
        Assert-MaxstackPathHasNoControlCharacters $LegacyWorkspace 'Legacy workspace'
    }
    if (-not [string]::IsNullOrWhiteSpace($LegacyWorkspace) -and (Test-Path -LiteralPath $LegacyWorkspace -PathType Container)) {
        $target = Assert-MaxstackWorkspaceTarget $LegacyWorkspace 'legacy default'
        return [pscustomobject]@{ Workspace = $target; Origin = 'legacy default'; Warning = $true }
    }

    throw 'Workspace discovery failed. Tried -Workspace, MAXSTACK_WORKSPACE, cwd marker (maxstack.settings.json or stack.lock.json), script layout (projects/repos/<repo> or projects/worktrees/<repo>), and legacy default.'
}
