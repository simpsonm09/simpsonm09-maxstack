# platforms: windows
Set-StrictMode -Version Latest

$script:SettingsTopLevelKeys = @('$schema', 'version', 'os', 'runtimes', 'layers', 't3')
$script:SettingsRuntimeIds = @('claude', 'copilot', 'opencode', 'pi')
$script:SettingsCliModes = @('detect', 'install')
$script:SettingsOsModes = @('auto', 'windows', 'macos', 'linux')
$script:SettingsT3Defaults = @('leave-alone', 'apply-defaults')
$script:SettingsSourceMaxLength = 2048

function ConvertTo-CanonicalSettingsValue {
    param($Value)

    if ($Value -is [System.Collections.IDictionary]) {
        $sorted = [ordered]@{}
        $keys = [string[]] @($Value.Keys)
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) {
            $sorted[$key] = ConvertTo-CanonicalSettingsValue $Value[$key]
        }
        return $sorted
    }
    return $Value
}

function Assert-SettingsObjectKeys {
    param($Value, [string[]] $Allowed, [string] $Where)

    if ($Value -isnot [System.Collections.IDictionary]) { throw "maxstack.settings.json: $Where must be an object." }
    foreach ($key in $Value.Keys) {
        if ($Allowed -cnotcontains [string] $key) {
            $valid = $Allowed -join ', '
            throw "maxstack.settings.json: unknown key '$(ConvertTo-SettingsSafeName ([string] $key))' in $Where. Valid keys: $valid."
        }
    }
}

function ConvertTo-SettingsSafeName {
    param([string] $Value)

    $safe = [regex]::Replace($Value, '[\x00-\x1f\x7f]', { param($match) '\u{0:X4}' -f [int] [char] $match.Value })
    if ($safe.Length -gt 80) { return $safe.Substring(0, 77) + '...' }
    return $safe
}

function Assert-SettingsSource {
    param([string] $Name, $Value)

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt $script:SettingsSourceMaxLength -or $Value -match '[\x00-\x1f\x7f]') {
        throw "maxstack.settings.json: layers.$Name.source must be a non-empty source string of at most $($script:SettingsSourceMaxLength) characters."
    }
    if ($Value -ceq 'default') { return }
    if ($Value.StartsWith('local:', [StringComparison]::Ordinal)) {
        $local = $Value.Substring(6)
        if ([string]::IsNullOrWhiteSpace($local) -or $local -match '(^|[\\/])\.\.([\\/]|$)') {
            throw "maxstack.settings.json: layers.$Name.source has an unsafe local path. Use local:<workspace-relative-path>."
        }
        if ([IO.Path]::IsPathRooted($local)) { Write-Warning "layers.$Name.source contains a machine path; use local: with a path relative to the workspace." }
        return
    }
    if ($Value -notmatch '^(?:[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+|https://[^/@\s]+/[^@\s]+)@[^@\s]+$') {
        throw "maxstack.settings.json: layers.$Name.source is not a supported source. Use owner/repo@ref, https://host/path.git@ref, local:<path>, or default."
    }
    $at = $Value.LastIndexOf('@')
    $location = $Value.Substring(0, $at)
    $ref = $Value.Substring($at + 1)
    $fault = Get-SpecFault $Value
    $validLocation = ($location -cmatch '^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$') -or (Test-HttpsGitUrl $location)
    if ($fault -or -not $validLocation -or -not (Test-SafeRefNameSyntax $ref)) {
        throw "maxstack.settings.json: layers.$Name.source is not a supported source. Use owner/repo@ref, https://host/path.git@ref, local:<path>, or default."
    }
}

# Resolves a settings-only local:<relative-path> against the workspace. Each existing path component is
# canonicalized so a junction cannot move a relative declaration outside the workspace.
function Resolve-SettingsLocalPath {
    param([string] $Name, [string] $Path, [string] $WorkspaceRoot)

    if ([IO.Path]::IsPathRooted($Path)) {
        $fault = Get-LocalPathFault $Path
        if ($fault) { throw "maxstack.settings.json: layers.$Name.source local path $fault" }
        $full = Get-FullFolderPath $Path
        return [pscustomobject]@{ path = $Path; canonicalPath = $full; relative = $false; missing = -not (Test-Path -LiteralPath $Path -PathType Container) }
    }
    if ($Path -match '(^|[\\/])\.\.([\\/]|$)' -or $Path -match '[\x00-\x1f\x7f]') {
        throw "maxstack.settings.json: layers.$Name.source has an unsafe local path. Use local:<workspace-relative-path>."
    }
    $root = [IO.Path]::GetFullPath($WorkspaceRoot)
    $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($root, ($Path -replace '/', '\')))
    $fault = Get-LocalPathFault $candidate
    if ($fault) { throw "maxstack.settings.json: layers.$Name.source local path $fault" }
    $rootEntry = Get-Item -LiteralPath $root -Force
    $rootPhysical = $rootEntry.ResolveLinkTarget($true)
    if ($null -ne $rootPhysical) { $root = $rootPhysical.FullName }
    $current = $root
    $relativePath = [IO.Path]::GetRelativePath([IO.Path]::GetFullPath($WorkspaceRoot), $candidate)
    foreach ($part in @($relativePath -split '[\\/]')) {
        if ([string]::IsNullOrEmpty($part) -or $part -ceq '.') { continue }
        $current = Join-Path $current $part
        $entry = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -eq $entry) { continue }
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $target = $entry.ResolveLinkTarget($true)
            if ($null -eq $target) { throw "maxstack.settings.json: layers.$Name.source has an unresolved link in its local path." }
            $current = $target.FullName
        } else { $current = $entry.FullName }
        $fault = Get-LocalPathFault ([IO.Path]::GetFullPath($current))
        if ($fault) { throw "maxstack.settings.json: layers.$Name.source local path $fault" }
        $rootFull = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        $currentFull = [IO.Path]::GetFullPath($current)
        if (-not $currentFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -and -not $currentFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "maxstack.settings.json: layers.$Name.source resolves outside the workspace."
        }
    }
    return [pscustomobject]@{ path = $candidate; canonicalPath = [IO.Path]::GetFullPath($current); relative = $true; missing = -not (Test-Path -LiteralPath $candidate -PathType Container) }
}

function Test-SettingsSourceSpecEqual {
    param([string] $Left, [string] $Right, [string] $Name, [string] $WorkspaceRoot)

    $leftLocal = $Left.StartsWith('local:', [StringComparison]::Ordinal)
    $rightLocal = $Right.StartsWith('local:', [StringComparison]::Ordinal)
    if (-not $leftLocal -or -not $rightLocal) { return $Left.Equals($Right, [StringComparison]::Ordinal) }
    $leftPath = Resolve-SettingsLocalPath -Name $Name -Path $Left.Substring(6) -WorkspaceRoot $WorkspaceRoot
    $rightPath = Resolve-SettingsLocalPath -Name $Name -Path $Right.Substring(6) -WorkspaceRoot $WorkspaceRoot
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    return $leftPath.canonicalPath.Equals($rightPath.canonicalPath, $comparison)
}

function Test-SettingsLocalReadable {
    param([string] $Path)

    try {
        $items = [IO.Directory]::EnumerateFileSystemEntries($Path).GetEnumerator()
        try { [void] $items.MoveNext() } finally { if ($items -is [IDisposable]) { $items.Dispose() } }
        return $true
    } catch { return $false }
}

function ConvertTo-SettingsSourceSpec {
    param([string] $Name, [string] $Spec, [string] $WorkspaceRoot)

    if (-not $Spec.StartsWith('local:', [StringComparison]::Ordinal)) { return (Read-SourceSpec -Name $Name -Spec $Spec) }
    $local = Resolve-SettingsLocalPath -Name $Name -Path $Spec.Substring(6) -WorkspaceRoot $WorkspaceRoot
    return [pscustomobject]@{ kind = 'local'; path = $local.path; settingsRelative = $local.relative; missing = $local.missing }
}

function ConvertTo-SettingsSpecFromRecord {
    param($Source, [string] $WorkspaceRoot)

    if ($Source.kind -eq 'git') {
        if ($Source.url -cmatch '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$') { return "$($Matches[1])/$($Matches[2])@$($Source.ref)" }
        return "$($Source.url)@$($Source.ref)"
    }
    $path = [IO.Path]::GetFullPath([string] $Source.path)
    $root = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\', '/')
    if ($path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        return 'local:' + [IO.Path]::GetRelativePath($root, $path).Replace('\', '/')
    }
    return "local:$path"
}

function Get-InitSettingsOverrides {
    param($Stack)

    $overrides = @{}
    foreach ($layer in @($Stack.layers)) {
        $block = Get-Field $layer 'source'
        if (-not (($block -is [pscustomobject]) -and ((Get-Field $block 'override') -eq $true))) { continue }
        $kind = Get-Field $block 'kind'
        if ($kind -eq 'git') {
            $url = [string] (Get-Field $block 'url')
            $ref = [string] (Get-Field $block 'ref')
            $commit = [string] (Get-Field $block 'commit')
            if (-not (Test-HttpsGitUrl $url) -or (Get-SpecFault $url) -or -not (Test-SafeRefNameSyntax $ref) -or -not (Test-CommitRef $commit)) {
                throw "-InitSettings cannot migrate the recorded git source for '$($layer.name)' because its URL, ref, or commit is invalid."
            }
        } elseif ($kind -eq 'local') {
            $path = [string] (Get-Field $block 'path')
            $fault = Get-LocalPathFault $path
            if ($fault) { throw "-InitSettings cannot migrate the recorded local source for '$($layer.name)': $fault" }
        } else { throw "-InitSettings cannot migrate the recorded source for '$($layer.name)' because its kind is invalid." }
        $overrides[$layer.name] = $block
    }
    return $overrides
}

function Read-InitSettingsLock {
    param([string] $Path, [string[]] $LayerNames)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt 65536) { throw '-InitSettings cannot read stack.lock.json because it is larger than the 65536 byte limit.' }
        $buffer = [byte[]]::new(65537)
        $read = 0
        while ($read -lt $buffer.Length) {
            $count = $stream.Read($buffer, $read, $buffer.Length - $read)
            if ($count -eq 0) { break }
            $read += $count
        }
        if ($read -gt 65536) { throw '-InitSettings cannot read stack.lock.json because it is larger than the 65536 byte limit.' }
        $bytes = [byte[]]::new($read)
        [Array]::Copy($buffer, $bytes, $read)
    } finally { $stream.Dispose() }
    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 3 } else { 0 }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset) }
    catch { throw '-InitSettings cannot read stack.lock.json because it is not valid UTF-8.' }
    try {
        $options = [System.Text.Json.JsonDocumentOptions]::new()
        $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        $options.AllowTrailingCommas = $false
        $options.MaxDepth = 32
        $document = [System.Text.Json.JsonDocument]::Parse($text, $options)
        try {
            if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'root is not an object' }
            Assert-SettingsNoDuplicateKeys -Element $document.RootElement
        } finally { $document.Dispose() }
    } catch {
        if ($_.Exception.Message -match '^duplicate key ') { throw "-InitSettings cannot read stack.lock.json because it has $($_.Exception.Message)." }
        throw '-InitSettings cannot read stack.lock.json as strict JSON.'
    }
    try { $stack = ConvertFrom-Json -InputObject $text -AsHashtable -Depth 32 -ErrorAction Stop }
    catch { throw '-InitSettings cannot read stack.lock.json as strict JSON.' }
    if ($stack -isnot [System.Collections.IDictionary]) { throw '-InitSettings cannot read stack.lock.json because the root is not an object.' }
    $schema = $stack['ownedSchema']
    if ($null -ne $schema -and (($schema -isnot [long] -and $schema -isnot [int]) -or $schema -notin @(1, 2))) {
        throw '-InitSettings cannot migrate a lock with an unsupported ownedSchema.'
    }
    $selection = $stack['selection']
    if ($selection -isnot [System.Collections.IDictionary]) { throw '-InitSettings needs a valid recorded selection in stack.lock.json.' }
    foreach ($key in $selection.Keys) {
        if ($key -cnotin @('runtimes', 'layers')) { throw '-InitSettings cannot migrate a selection with an unknown field.' }
    }
    foreach ($pair in @(@('runtimes', $script:SettingsRuntimeIds), @('layers', $LayerNames))) {
        $names = $selection[$pair[0]]
        if ($names -isnot [array] -or $names.Count -eq 0) { throw "-InitSettings needs a valid recorded $($pair[0]) selection in stack.lock.json." }
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($name in $names) {
            if ($name -isnot [string] -or $pair[1] -cnotcontains $name -or -not $seen.Add($name)) {
                throw "-InitSettings cannot migrate an unknown, duplicate, or invalid $($pair[0]) selection."
            }
        }
    }
    if ($stack['layers'] -isnot [array]) { throw '-InitSettings cannot migrate a lock without a valid layers list.' }
    $seenLayers = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($layer in $stack['layers']) {
        if ($layer -isnot [System.Collections.IDictionary] -or $layer['name'] -isnot [string] -or $LayerNames -cnotcontains $layer['name'] -or -not $seenLayers.Add($layer['name'])) {
            throw '-InitSettings cannot migrate an unknown, duplicate, or invalid layer record.'
        }
        if ($layer.Contains('source') -and $layer['source'] -isnot [string] -and $layer['source'] -isnot [System.Collections.IDictionary]) {
            throw '-InitSettings cannot migrate a malformed recorded source.'
        }
        if ($layer['source'] -is [System.Collections.IDictionary] -and $layer['source'].Contains('override') -and $layer['source']['override'] -isnot [bool]) {
            throw '-InitSettings cannot migrate a malformed recorded source.'
        }
    }
    return [pscustomobject]@{ stack = $stack; text = $text }
}

function ConvertTo-InitSettingsValue {
    param($Stack, [string] $WorkspaceRoot)

    $selectionProperty = $Stack.PSObject.Properties['selection']
    $selection = if ($null -eq $selectionProperty) { $null } else { $selectionProperty.Value }
    if ($null -eq $selection) { throw '-InitSettings needs a lock with a recorded selection. Run Install-Workspace.ps1 -Apply first.' }
    $runtimes = @($selection.runtimes | Sort-Object -Unique)
    $layers = @($selection.layers | Sort-Object -Unique)
    $settingsLayers = [ordered]@{}
    $sources = Get-InitSettingsOverrides $Stack
    foreach ($name in $layers) {
        $entry = [ordered]@{}
        if ($sources.ContainsKey($name)) {
            $source = $sources[$name]
            if ($source.kind -eq 'git') {
                $url = [string] $source.url
                if ($url -cmatch '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$') {
                    $spec = "$($Matches[1])/$($Matches[2])@$($source.ref)"
                } else { $spec = "$url@$($source.ref)" }
            } else {
                $path = [IO.Path]::GetFullPath([string] $source.path)
                $root = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\', '/')
                if ($path.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { throw "-InitSettings cannot represent layer '$name' as a local source at the workspace root." }
                if ($path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                    $relative = [IO.Path]::GetRelativePath($root, $path).Replace('\', '/')
                    $spec = "local:$relative"
                } else {
                    $spec = "local:$path"
                }
            }
            Assert-SettingsSource -Name $name -Value $spec
            $entry.source = $spec
        }
        $settingsLayers[$name] = $entry
    }
    $settings = [ordered]@{ version = 1; runtimes = [ordered]@{}; layers = $settingsLayers }
    foreach ($name in $runtimes) { $settings.runtimes[$name] = [ordered]@{} }
    return $settings
}

function Invoke-InitSettings {
    param([string] $Path, [string] $WorkspaceRoot, [string[]] $LayerNames, [switch] $Write)

    if ([IO.Directory]::Exists($Path)) {
        throw "-InitSettings cannot write because $Path is a directory."
    }
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $entry) {
        if ($Write) { throw "-InitSettings refuses to overwrite existing $Path." }
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '-InitSettings cannot read because the settings destination is a link.' }
    }
    $stackPath = Join-Path $WorkspaceRoot 'stack.lock.json'
    if (-not (Test-Path -LiteralPath $stackPath -PathType Leaf)) { throw "-InitSettings needs $stackPath. Run Install-Workspace.ps1 -Apply first." }
    $readLock = Read-InitSettingsLock -Path $stackPath -LayerNames $LayerNames
    $stack = ConvertFrom-Json -InputObject $readLock.text -Depth 32 -ErrorAction Stop
    $settings = ConvertTo-InitSettingsValue -Stack $stack -WorkspaceRoot $WorkspaceRoot
    $json = ConvertTo-Json -InputObject $settings -Depth 8
    if (-not $Write) {
        Write-Host 'InitSettings: derived settings file (dry run, no files written):'
        Write-Output $json
        return
    }
    $temp = Join-Path $WorkspaceRoot ('.maxstack.settings.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + [Environment]::NewLine)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        [IO.File]::Move($temp, $Path)
        Write-Host "InitSettings: wrote $Path. No runtime files were changed."
    } finally {
        if (Test-Path -LiteralPath $temp -PathType Leaf) { [IO.File]::Delete($temp) }
    }
}

function Assert-SettingsNoDuplicateKeys {
    param([System.Text.Json.JsonElement] $Element, [string] $At = 'root')

    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $seen.Add($property.Name)) { throw "duplicate key '$(ConvertTo-SettingsSafeName $property.Name)' at $At" }
            Assert-SettingsNoDuplicateKeys -Element $property.Value -At "$At.$(ConvertTo-SettingsSafeName $property.Name)"
        }
    } elseif ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        $index = 0
        foreach ($item in $Element.EnumerateArray()) {
            Assert-SettingsNoDuplicateKeys -Element $item -At "$At[$index]"
            $index += 1
        }
    }
}

function Read-MaxstackSettings {
    param([string] $Path, [string[]] $LayerNames)

    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $entry) {
        if ([IO.Directory]::Exists($Path)) { throw 'maxstack.settings.json settings path is a directory.' }
        return [pscustomobject]@{ present = $false; value = $null; hash = $null }
    }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'maxstack.settings.json settings path is a symbolic link or reparse point.' }
    if ($entry.PSIsContainer) { throw 'maxstack.settings.json settings path is a directory.' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt 65536) { throw 'maxstack.settings.json is larger than the 65536 byte limit.' }
        $buffer = [byte[]]::new(65537)
        $read = 0
        while ($read -lt $buffer.Length) {
            $count = $stream.Read($buffer, $read, $buffer.Length - $read)
            if ($count -eq 0) { break }
            $read += $count
        }
        if ($read -gt 65536) { throw 'maxstack.settings.json is larger than the 65536 byte limit.' }
        $bytes = [byte[]]::new($read)
        [Array]::Copy($buffer, $bytes, $read)
    } finally { $stream.Dispose() }
    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 3 } else { 0 }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset) }
    catch { throw 'maxstack.settings.json is not valid UTF-8.' }
    try {
        $jsonOptions = [System.Text.Json.JsonDocumentOptions]::new()
        $jsonOptions.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        $jsonOptions.AllowTrailingCommas = $false
        $jsonOptions.MaxDepth = 32
        $document = [System.Text.Json.JsonDocument]::Parse($text, $jsonOptions)
        try {
            if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'maxstack.settings.json must hold one JSON object.' }
            Assert-SettingsNoDuplicateKeys -Element $document.RootElement
        } finally { $document.Dispose() }
    }
    catch {
        if ($_.Exception.Message -eq 'maxstack.settings.json must hold one JSON object.') { throw $_.Exception.Message }
        if ($_.Exception.Message -match '^duplicate key ') { throw $_.Exception.Message }
        throw 'maxstack.settings.json is not strict JSON. Comments and trailing commas are not allowed.'
    }
    try { $value = ConvertFrom-Json -InputObject $text -AsHashtable -Depth 32 -ErrorAction Stop }
    catch { throw 'maxstack.settings.json is not strict JSON. Comments and trailing commas are not allowed.' }
    Assert-SettingsObjectKeys $value $script:SettingsTopLevelKeys 'the top level'
    if ($value.Contains('$schema') -and $value['$schema'] -isnot [string]) { throw 'maxstack.settings.json: $schema must be a string.' }
    if (-not $value.Contains('version')) { throw 'maxstack.settings.json needs "version": 1.' }
    if (($value.version -isnot [long] -and $value.version -isnot [int]) -or $value.version -ne 1) { throw 'maxstack.settings.json needs "version": 1.' }
    if ($value.Contains('os') -and $value.os -cnotin $script:SettingsOsModes) {
        throw "maxstack.settings.json: os has an unsupported value. Valid values: $($script:SettingsOsModes -join ', ')."
    }
    if ($value.Contains('runtimes')) {
        if ($value.runtimes -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: runtimes must be an object.' }
        Assert-SettingsObjectKeys $value.runtimes $script:SettingsRuntimeIds 'runtimes'
        if ($value.runtimes.Count -eq 0) { throw 'maxstack.settings.json: runtimes names no runtime. Omit it to use the recorded selection.' }
        foreach ($runtime in $value.runtimes.Keys) {
            Assert-SettingsObjectKeys $value.runtimes[$runtime] @('cli') "runtimes.$runtime"
            if ($value.runtimes[$runtime].Contains('cli') -and $value.runtimes[$runtime].cli -cnotin $script:SettingsCliModes) {
                throw "maxstack.settings.json: runtimes.$runtime.cli must be detect or install."
            }
        }
    }
    if ($value.Contains('layers')) {
        if ($value.layers -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: layers must be an object.' }
        Assert-SettingsObjectKeys $value.layers @($LayerNames) 'layers'
        if ($value.layers.Count -eq 0) { throw 'maxstack.settings.json: layers names no layer. Omit it to use the recorded selection.' }
        foreach ($layer in $value.layers.Keys) {
            Assert-SettingsObjectKeys $value.layers[$layer] @('source') "layers.$layer"
            if ($value.layers[$layer].Contains('source')) { Assert-SettingsSource $layer $value.layers[$layer].source }
        }
    }
    if ($value.Contains('t3')) {
        if ($value.t3 -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: t3 must be an object.' }
        Assert-SettingsObjectKeys $value.t3 @('cli', 'snapshot', 'defaults') 't3'
        if ($value.t3.Contains('cli') -and $value.t3.cli -cnotin $script:SettingsCliModes) { throw 'maxstack.settings.json: t3.cli must be detect or install.' }
        if ($value.t3.Contains('snapshot') -and $value.t3.snapshot -isnot [bool]) { throw 'maxstack.settings.json: t3.snapshot must be true or false.' }
        if ($value.t3.Contains('defaults') -and $value.t3.defaults -cnotin $script:SettingsT3Defaults) {
            throw 'maxstack.settings.json: t3.defaults must be leave-alone or apply-defaults.'
        }
        if ($value.t3.Contains('defaults') -and $value.t3.defaults -ceq 'apply-defaults') { Write-Warning 't3.defaults apply-defaults is reserved and unsupported in this release; T3 settings are left alone.' }
    }
    $canonical = ConvertTo-Json -InputObject (ConvertTo-CanonicalSettingsValue $value) -Compress -Depth 100
    $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical)))
    return [pscustomobject]@{ present = $true; value = $value; hash = $sha }
}

function Get-SettingsNames {
    param($Settings, [string] $Key)

    if (-not $Settings.present -or -not $Settings.value.Contains($Key)) { return @() }
    return @($Settings.value[$Key].Keys)
}
