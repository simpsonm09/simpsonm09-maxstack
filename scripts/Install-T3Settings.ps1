# platforms: windows
#requires -Version 7.0

Set-StrictMode -Version Latest

$script:T3PolicyRoot = Split-Path -Parent $PSScriptRoot
$script:T3AllowlistData = Get-Content -LiteralPath (Join-Path $script:T3PolicyRoot 't3/allowlist.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 64
$script:T3Drivers = @($script:T3AllowlistData.drivers.Keys)
$script:T3DefaultsTemplate = Get-Content -LiteralPath (Join-Path $script:T3PolicyRoot 't3/defaults.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 64
$script:T3EnabledDefaults = $script:T3AllowlistData.driverEnabledDefaults
$script:T3ConfigDefaults = $script:T3AllowlistData.driverConfigDefaults
$script:T3Allowed = [ordered]@{}
foreach ($key in $script:T3AllowlistData.top.Keys) {
    $rule = $script:T3AllowlistData.top[$key]
    $normalized = @{ kind = $rule.rule }
    if ($rule.Contains('values')) { $normalized.values = @($rule.values) }
    if ($rule.Contains('keys')) { $normalized.keys = $rule.keys }
    if ($rule.Contains('nullable')) { $normalized.nullable = [bool]$rule.nullable }
    if ($rule.Contains('t3Default')) { $normalized.default = $rule.t3Default }
    $script:T3Allowed[$key] = $normalized
}
$script:T3Excluded = $script:T3AllowlistData.excluded

function Get-T3SafeKey {
    param([string] $Name)
    if ($Name -match '(?i)(token|secret|password|credential|api[-_]?key|key)[^\p{L}\p{N}]{0,8}[a-z0-9+/=_-]{12,}' -or
        $Name -match '[A-Za-z0-9+/=_-]{32,}' -or
        ($Name.Length -ge 40 -and $Name -match '[A-Z]' -and $Name -match '[a-z]' -and $Name -match '[0-9]')) { return '[redacted key name]' }
    $safe = $Name -replace '[\p{Cc}\p{Cf}]', '?'
    if ($safe.Length -gt 80) { $safe = $safe.Substring(0, 77) + '...' }
    return $safe
}

function Test-T3ExactKey {
    param($Map, [string] $Name)
    if ($Map -is [array]) {
        foreach ($key in $Map) { if ([string]$key -ceq $Name) { return $true } }
        return $false
    }
    if ($Map -isnot [System.Collections.IDictionary]) { return $false }
    foreach ($key in $Map.Keys) { if ([string]$key -ceq $Name) { return $true } }
    return $false
}

function Get-T3ExactValue {
    param($Map, [string] $Name)
    foreach ($key in $Map.Keys) { if ([string]$key -ceq $Name) { return $Map[$key] } }
    return $null
}

function Test-T3DuplicateKeys {
    param([System.Text.Json.JsonElement] $Element)
    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $seen.Add($property.Name)) { return $true }
            if (Test-T3DuplicateKeys $property.Value) { return $true }
        }
    } elseif ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        foreach ($item in $Element.EnumerateArray()) { if (Test-T3DuplicateKeys $item) { return $true } }
    }
    return $false
}

function Read-T3Input {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @{ state = 'missing'; value = $null } }
    $readStage = 'io'
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer) { return @{ state = 'unreadable'; value = $null } }
        if ($item.Length -gt 2MB) { return @{ state = 'unreadable'; value = $null } }
        $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -gt 2MB) { return @{ state = 'unreadable'; value = $null } }
            $bytes = [byte[]]::new([int]$stream.Length)
            $position = 0
            while ($position -lt $bytes.Length) {
                $read = $stream.Read($bytes, $position, $bytes.Length - $position)
                if ($read -eq 0) { break }
                $position += $read
            }
            if ($position -ne $bytes.Length -or $stream.ReadByte() -ne -1) { return @{ state = 'unreadable'; value = $null } }
        } finally { $stream.Dispose() }
        $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 3 } else { 0 }
        $readStage = 'parse'
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
        $options = [System.Text.Json.JsonDocumentOptions]@{ MaxDepth = 64; CommentHandling = 'Disallow'; AllowTrailingCommas = $false }
        $doc = [System.Text.Json.JsonDocument]::Parse($text, $options)
        try {
            if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object -or (Test-T3DuplicateKeys $doc.RootElement)) {
                return @{ state = 'malformed'; value = $null }
            }
        } finally { $doc.Dispose() }
        $value = ConvertFrom-Json -InputObject $text -AsHashtable -Depth 64 -ErrorAction Stop
        return @{ state = 'present'; value = $value }
    } catch {
        $state = if ($readStage -eq 'io') { 'unreadable' } else { 'malformed' }
        return @{ state = $state; value = $null }
    }
}

function Get-T3RuleValue {
    param([string] $Key, $Value, [string] $Workspace)
    $rule = $script:T3Allowed[$Key]
    if ($rule.kind -eq 'exclude') { return @{ ok = $false } }
    if ($rule.kind -eq 'bool' -and $Value -is [bool]) { return @{ ok = $true; value = $Value } }
    if ($rule.kind -eq 'enum' -and (($null -eq $Value -and $rule.Contains('nullable') -and $rule.nullable) -or ($Value -is [string] -and $rule.values -ccontains $Value))) { return @{ ok = $true; value = $Value } }
    if ($rule.kind -eq 'object' -and $Value -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        $unknown = [Collections.Generic.List[string]]::new()
        $bad = $false
        foreach ($name in @($Value.Keys | Sort-Object -CaseSensitive)) {
            $child = $null
            foreach ($allowedName in $rule.keys.Keys) { if ([string]$allowedName -ceq [string]$name) { $child = $rule.keys[$allowedName]; break } }
            if ($null -eq $child) { $unknown.Add((Get-T3SafeKey ([string]$name))); continue }
            $v = $Value[$name]
            if ($child.rule -eq 'bool' -and $v -is [bool]) { $out[$name] = $v }
            elseif ($child.rule -eq 'nullable-int' -and ($null -eq $v -or (($v -is [int] -or $v -is [long]) -and $v -ge $child.minimum -and $v -le $child.maximum))) { $out[$name] = $v }
            else { $bad = $true }
        }
        return @{ ok = (-not $bad); value = $out; unknownKeys = @($unknown); bad = $bad }
    }
    return @{ ok = $false }
}

function Convert-T3Command {
    param($Value, [string] $Workspace)
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { return @{ ok = $false; value = '{path}' } }
    if ($Value -notmatch '[\\/]' -and $Value -notmatch '^[A-Za-z]:') {
        if ($script:T3AllowlistData.commands -ccontains $Value) { return @{ ok = $true; value = $Value } }
        return @{ ok = $false; value = '{path}' }
    }
    $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/') -replace '\\', '/'
    $candidate = $Value -replace '^\\\\\?\\', '' -replace '\\', '/'
    if ($candidate -match '(^|/)\.\.(/|$)') { return @{ ok = $false; value = '{path}' } }
    if ($candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase)) {
        $tail = $candidate.Substring($root.Length).TrimStart('/')
        $allowed = @('.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh', '.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh')
        if ($tail) {
            $canonicalWrapper = @($allowed | Where-Object { $_.Equals($tail, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)
            if ($canonicalWrapper.Count -gt 0 -and (Test-T3PhysicalWorkspacePath -Path ([IO.Path]::GetFullPath($Value)) -Workspace $Workspace)) { return @{ ok = $true; value = '{workspace}/' + $canonicalWrapper[0] } }
        }
    }
    return @{ ok = $false; value = '{path}' }
}

function Convert-T3PluginDirectory {
    param([string] $PathValue, [string] $Workspace, [string[]] $LayerNames)
    if ($PathValue -match '(^|/)\.\.(/|$)') { return @{ ok = $false; value = '{path}' } }
    $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')
    $candidate = $PathValue -replace '^\\\\\?\\', ''
    if (-not [IO.Path]::IsPathRooted($candidate)) { return @{ ok = $false; value = '{path}' } }
    try { $full = [IO.Path]::GetFullPath($candidate) } catch { return @{ ok = $false; value = '{path}' } }
    if (-not ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) { return @{ ok = $false; value = '{path}' } }
    $relativePath = $full.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
    $known = $false
    foreach ($rootRule in $script:T3AllowlistData.launchArgs.pathRoots) {
        if ($rootRule.Contains('<known-layer>')) {
            foreach ($layer in $LayerNames) { if ($relativePath.Equals($rootRule.Replace('<known-layer>', $layer), [StringComparison]::OrdinalIgnoreCase)) { $known = $true } }
        } elseif ($relativePath.Equals($rootRule, [StringComparison]::OrdinalIgnoreCase)) { $known = $true }
    }
    if (-not $known) { return @{ ok = $false; value = '{path}' } }
    if (-not (Test-T3PhysicalWorkspacePath -Path $full -Workspace $root)) { return @{ ok = $false; value = '{path}' } }
    return @{ ok = $true; value = '{workspace}/' + $relativePath }
}

function Test-T3PhysicalWorkspacePath {
    param([string] $Path, [string] $Workspace)
    try {
        $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')
        $physicalRoot = $root
        $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $physicalRoot = $rootItem.ResolveLinkTarget($true).FullName }
        $relative = [IO.Path]::GetFullPath($Path).Substring($root.Length).TrimStart('\', '/')
        $cursor = $root
        foreach ($segment in @($relative -split '[\\/]+' | Where-Object { $_ })) {
            $cursor = Join-Path $cursor $segment
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
            if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $target = $item.ResolveLinkTarget($true)
                if ($null -eq $target) { return $false }
                $resolved = [IO.Path]::GetFullPath($target.FullName).TrimEnd('\', '/')
                if (-not ($resolved.Equals($physicalRoot, [StringComparison]::OrdinalIgnoreCase) -or $resolved.StartsWith($physicalRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) { return $false }
            }
        }
        return $true
    } catch { return $false }
}

function Convert-T3PluginArgs {
    param($Value, [string] $Workspace, [string[]] $LayerNames)
    if ($Value -isnot [string]) { return @{ ok = $false; value = '{args: 1 tokens}' } }
    $match = [regex]::Match($Value, '^\s*--plugin-dir\s+(?:"([^"]+)"|''([^'']+)''|(\S+))\s*$')
    if (-not $match.Success -or $script:T3AllowlistData.launchArgs.allowedFlags -cnotcontains '--plugin-dir') {
        $tokens = @($Value -split '\s+' | Where-Object { $_ }).Count
        return @{ ok = $false; value = "{args: $tokens tokens}" }
    }
    $path = if ($match.Groups[1].Success) { $match.Groups[1].Value } elseif ($match.Groups[2].Success) { $match.Groups[2].Value } else { $match.Groups[3].Value }
    $normalized = Convert-T3PluginDirectory -PathValue $path -Workspace $Workspace -LayerNames $LayerNames
    if (-not $normalized.ok) { return @{ ok = $false; value = '{args: 2 tokens}' } }
    return @{ ok = $true; value = "--plugin-dir $($normalized.value)" }
}

function Get-T3WorkspaceSlug {
    param([string] $Workspace)
    $name = Split-Path -Leaf $Workspace.TrimEnd('\', '/')
    $parts = @($name -split '[^A-Za-z0-9]+' | Where-Object { $_ })
    $slug = (($parts | ForEach-Object { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }) -join '')
    if (-not $slug) { $slug = 'Workspace' }
    if ($slug -notmatch '^[A-Za-z]') { $slug = 'Workspace' + $slug }
    if ($slug.Length -gt 64) { $slug = $slug.Substring(0, 64) }
    return $slug
}

function Expand-T3DefaultValue {
    param($Value, [string] $Workspace, [string] $WorkspaceSlug)
    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.Contains('$os')) {
            $osName = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'macos' } else { 'linux' }
            if (-not $Value['$os'].Contains($osName)) { return $null }
            return Expand-T3DefaultValue $Value['$os'][$osName] $Workspace $WorkspaceSlug
        }
        $result = [ordered]@{}
        foreach ($key in $Value.Keys) { $result[$key] = Expand-T3DefaultValue $Value[$key] $Workspace $WorkspaceSlug }
        return $result
    }
    if ($Value -is [array]) { return , @($Value | ForEach-Object { Expand-T3DefaultValue $_ $Workspace $WorkspaceSlug }) }
    if ($Value -is [string]) {
        $native = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')
        $posix = $native -replace '\\', '/'
        return $Value.Replace('{Workspace}', $WorkspaceSlug).Replace('{workspacePosix}', $posix).Replace('{workspace}', $native)
    }
    return $Value
}

function Get-T3Defaults {
    param([string] $Workspace)
    $suffix = Get-T3WorkspaceSlug $Workspace
    $instances = [ordered]@{}
    foreach ($templateId in $script:T3DefaultsTemplate.instances.Keys) {
        $id = $templateId.Replace('{Workspace}', $suffix)
        $instances[$id] = Expand-T3DefaultValue $script:T3DefaultsTemplate.instances[$templateId] $Workspace $suffix
    }
    return @{ instances = $instances; app = Expand-T3DefaultValue $script:T3DefaultsTemplate.app $Workspace $suffix }
}

function Convert-T3ExpectedInstanceForReport {
    param($Expected, [string] $Workspace, [string[]] $LayerNames)
    $safe = [ordered]@{ driver = $Expected.envelope.driver; enabled = $Expected.envelope.enabled }
    $config = [ordered]@{}
    foreach ($field in $Expected.config.Keys) {
        $value = $Expected.config[$field]
        if ($field -in @('binaryPath', 'commandPath')) { $value = (Convert-T3Command $value $Workspace).value }
        elseif ($field -eq 'launchArgs' -and $value -is [string] -and $value.StartsWith('--plugin-dir ', [StringComparison]::Ordinal)) {
            $normalized = Convert-T3PluginDirectory -PathValue $value.Substring('--plugin-dir '.Length) -Workspace $Workspace -LayerNames $LayerNames
            $value = if ($normalized.ok) { '--plugin-dir ' + $normalized.value } else { '{args: 2 tokens}' }
        }
        elseif ($field -eq 'commandArgs' -and $value -is [array] -and $value.Count -eq 2) {
            $value = @($value[0], (Convert-T3PluginDirectory -PathValue $value[1] -Workspace $Workspace -LayerNames $LayerNames).value)
        }
        $config[$field] = $value
    }
    $safe.config = $config
    return $safe
}

function Get-T3SettingsReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][string] $Workspace, [string[]] $RuntimeNames = @('claude', 'copilot', 'pi'), [string[]] $LayerNames = @())
    $inputState = Read-T3Input $Path
    $counts = [ordered]@{ recorded = 0; excluded = 0; unknown = 0; unverifiable = 0; environment = 0 }
    $snapshot = [ordered]@{}
    $unknownNames = [Collections.Generic.List[string]]::new()
    $unverifiable = [Collections.Generic.List[string]]::new()
    $strict = [Collections.Generic.List[string]]::new()
    $providerInstancesApproved = (Test-T3ExactKey $script:T3Allowed 'providerInstances') -and $script:T3Allowed.providerInstances.kind -ceq 'instances'
    $instanceDrift = @{}
    $instanceStates = @{}
    if ($inputState.state -eq 'present') {
        $topKeys = [string[]] @($inputState.value.Keys)
        [Array]::Sort($topKeys, [StringComparer]::Ordinal)
        foreach ($key in $topKeys) {
            if (Test-T3ExactKey $script:T3Excluded $key) { $counts.excluded++; continue }
            if (-not (Test-T3ExactKey $script:T3Allowed $key)) { $counts.unknown++; $unknownNames.Add((Get-T3SafeKey $key)); $strict.Add('unknown'); continue }
            if ($key -ceq 'providerInstances') { continue }
            $checked = Get-T3RuleValue -Key $key -Value (Get-T3ExactValue $inputState.value $key) -Workspace $Workspace
            if ($checked.ContainsKey('unknownKeys')) { foreach ($nested in @($checked.unknownKeys)) { $counts.unknown++; $unknownNames.Add("$key.$nested"); $strict.Add('unknown') } }
            if ($checked.ok) {
                $snapshot[$key] = $checked.value; $counts.recorded++
            }
            else { $counts.unverifiable++; $unverifiable.Add((Get-T3SafeKey $key)); $strict.Add('unverifiable') }
        }
        if ($providerInstancesApproved -and $inputState.value.Contains('providerInstances') -and $inputState.value.providerInstances -is [System.Collections.IDictionary]) {
            $instances = [ordered]@{}
            $defaults = Get-T3Defaults $Workspace
            $knownIds = @($defaults.instances.Keys)
            $knownIdTemplates = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
            foreach ($template in $script:T3DefaultsTemplate.instances.Keys) { $knownIdTemplates[$template.Replace('{Workspace}', (Get-T3WorkspaceSlug $Workspace))] = $template }
            $extraIndex = 0
            foreach ($id in @($inputState.value.providerInstances.Keys | Sort-Object -CaseSensitive)) {
                $instance = $inputState.value.providerInstances[$id]
                $label = if ($knownIdTemplates.ContainsKey([string]$id)) { $knownIdTemplates[[string]$id] } else { $extraIndex++; "mapextra$extraIndex" }
                if ($instance -isnot [System.Collections.IDictionary]) {
                    $counts.unverifiable++; $strict.Add('unverifiable')
                    $stateKey = if ($knownIdTemplates.ContainsKey([string]$id)) { [string]$id } else { $label }
                    $instanceStates[$stateKey] = 'unverifiable'
                    continue
                }
                $unknownBeforeInstance = $counts.unknown
                $strictBeforeInstance = $strict.Count
                $driver = Get-T3ExactValue $instance 'driver'
                $driverKnown = ($driver -is [string]) -and ($script:T3Drivers -ccontains $driver)
                $envelopeAllowed = $script:T3AllowlistData.providerEnvelope.allowed
                $driverApproved = Test-T3ExactKey $envelopeAllowed 'driver'
                $enabledApproved = Test-T3ExactKey $envelopeAllowed 'enabled'
                $configApproved = Test-T3ExactKey $envelopeAllowed 'config'
                $safe = [ordered]@{}
                foreach ($field in $instance.Keys) {
                    if (Test-T3ExactKey $envelopeAllowed ([string]$field)) { continue }
                    if (Test-T3ExactKey $script:T3AllowlistData.providerEnvelope.excluded ([string]$field)) { $counts.excluded++ }
                    else { $counts.unknown++; $unknownNames.Add("providerInstances.$label.$(Get-T3SafeKey ([string]$field))"); $strict.Add('unknown') }
                }
                if ($driverKnown -and $driverApproved) { $safe.driver = $driver }
                elseif (-not $driverKnown -and $driverApproved) { $counts.unverifiable++; $strict.Add('unverifiable') }
                $envelopeEnabled = $null
                if ($enabledApproved -and (Test-T3ExactKey $instance 'enabled')) { $enabledValue = Get-T3ExactValue $instance 'enabled'; if ($enabledValue -is [bool]) { $envelopeEnabled = $enabledValue } else { $counts.unverifiable++; $strict.Add('unverifiable') } }
                $envCount = 0
                if (Test-T3ExactKey $instance 'environment') { $environmentValue = Get-T3ExactValue $instance 'environment'; if ($environmentValue -is [System.Collections.IDictionary] -or $environmentValue -is [array]) { $envCount = $environmentValue.Count } else { $counts.unverifiable++; $strict.Add('unverifiable') } }
                $counts.environment += $envCount
                $config = [ordered]@{}
                if ($configApproved -and $driverKnown -and $driver -ceq 'acpRegistry') {
                    $instanceConfig = Get-T3ExactValue $instance 'config'
                    if ($instanceConfig -is [System.Collections.IDictionary]) {
                    $acpAllowed = $script:T3AllowlistData.drivers.acpRegistry.allowed
                    foreach ($field in @('source', 'distribution')) {
                        if (-not (Test-T3ExactKey $acpAllowed $field)) { continue }
                        $accepted = $script:T3AllowlistData.drivers.acpRegistry.values[$field]
                        if (-not (Test-T3ExactKey $instanceConfig $field)) { continue }
                        $fieldValue = Get-T3ExactValue $instanceConfig $field
                        if ($fieldValue -is [string] -and $accepted -ccontains $fieldValue) { $config[$field] = $fieldValue }
                        else { $counts.unverifiable++; $strict.Add('unverifiable') }
                    }
                    if ((Test-T3ExactKey $acpAllowed 'agentId') -and (Test-T3ExactKey $instanceConfig 'agentId')) { $agentId = Get-T3ExactValue $instanceConfig 'agentId'; if ($agentId -is [string] -and $script:T3AllowlistData.drivers.acpRegistry.values.agentId -ccontains $agentId) { $config.agentId = $agentId } else { $counts.unverifiable++; $strict.Add('unverifiable') } }
                    if ((Test-T3ExactKey $acpAllowed 'commandPath') -and (Test-T3ExactKey $instanceConfig 'commandPath')) { $normalized = Convert-T3Command (Get-T3ExactValue $instanceConfig 'commandPath') $Workspace; $config.commandPath = $normalized.value; if (-not $normalized.ok) { $counts.unverifiable++; $strict.Add('unverifiable') } }
                    if ((Test-T3ExactKey $acpAllowed 'commandArgs') -and (Test-T3ExactKey $instanceConfig 'commandArgs')) {
                        $argsValue = Get-T3ExactValue $instanceConfig 'commandArgs'
                        if ($argsValue -is [array] -and $argsValue.Count -eq 0) { $config.commandArgs = @() }
                        elseif ($argsValue -is [array] -and $argsValue.Count -eq 2 -and $argsValue[0] -ceq '--plugin-dir') {
                            $normalized = Convert-T3PluginDirectory -PathValue $argsValue[1] -Workspace $Workspace -LayerNames $LayerNames
                            if ($argsValue[1] -is [string] -and $normalized.ok) { $config.commandArgs = @('--plugin-dir', $normalized.value.Replace('{workspace}/', '{workspace}/')) }
                            else { $config.commandArgs = "{args: $($argsValue.Count) tokens}"; $counts.unverifiable++; $strict.Add('unverifiable') }
                        } else { $config.commandArgs = "{args: $(@($argsValue).Count) tokens}"; $counts.unverifiable++; $strict.Add('unverifiable') }
                    }
                    $configKnown = @($script:T3AllowlistData.drivers.acpRegistry.allowed) + @($script:T3AllowlistData.drivers.acpRegistry.excluded)
                    foreach ($field in $instanceConfig.Keys) {
                        if ($configKnown -cnotcontains $field) { $counts.unknown++; $unknownNames.Add("providerInstances.$label.config.$(Get-T3SafeKey ([string]$field))"); $strict.Add('unknown') }
                        elseif ($script:T3AllowlistData.drivers.acpRegistry.excluded -ccontains $field) { $counts.excluded++ }
                    }
                    } else { $counts.unverifiable++; $strict.Add('unverifiable') }
                } elseif ($configApproved -and $driverKnown -and (Test-T3ExactKey $script:T3AllowlistData.drivers $driver)) {
                    $driverPolicy = $script:T3AllowlistData.drivers[$driver]
                    $instanceConfig = Get-T3ExactValue $instance 'config'
                    if ($instanceConfig -isnot [System.Collections.IDictionary]) { $counts.unverifiable++; $strict.Add('unverifiable'); $instanceConfig = @{} }
                    foreach ($field in $driverPolicy.allowed) {
                        $value = Get-T3ExactValue $instanceConfig $field
                        if ($field -eq 'enabled') { continue }
                        if (-not (Test-T3ExactKey $instanceConfig $field) -or $field -eq 'enabled') { continue }
                        if ($field -eq 'binaryPath') { $normalized = Convert-T3Command $value $Workspace; $config[$field] = $normalized.value; if (-not $normalized.ok) { $counts.unverifiable++; $strict.Add('unverifiable') } }
                        elseif ($field -eq 'launchArgs' -and $value -is [string]) {
                            if ($value -eq '') { $config[$field] = '' }
                            else { $normalized = Convert-T3PluginArgs -Value $value -Workspace $Workspace -LayerNames $LayerNames; $config[$field] = $normalized.value; if (-not $normalized.ok) { $counts.unverifiable++; $strict.Add('unverifiable') } }
                        } elseif ($field -eq 'launchArgs') { $counts.unverifiable++; $strict.Add('unverifiable') }
                    }
                    $configKnown = @($driverPolicy.allowed) + @($driverPolicy.excluded)
                    foreach ($field in $instanceConfig.Keys) {
                        if ($configKnown -cnotcontains $field) { $counts.unknown++; $unknownNames.Add("providerInstances.$label.config.$(Get-T3SafeKey ([string]$field))"); $strict.Add('unknown') }
                        elseif ($driverPolicy.excluded -ccontains $field) { $counts.excluded++ }
                    }
                } elseif ($configApproved) { $counts.unverifiable++; $strict.Add('unverifiable') }
                $resolvedEnabled = $null
                if ($driverKnown) {
                    $legacyEnabled = $null
                    $legacyConfig = if ($configApproved) { Get-T3ExactValue $instance 'config' } else { @{} }
                    $nestedEnabledApproved = if ($driver -ceq 'acpRegistry') { Test-T3ExactKey $script:T3AllowlistData.drivers.acpRegistry.allowed 'enabled' } elseif (Test-T3ExactKey $script:T3AllowlistData.drivers $driver) { Test-T3ExactKey $script:T3AllowlistData.drivers[$driver].allowed 'enabled' } else { $false }
                    if ($configApproved -and $nestedEnabledApproved -and (Test-T3ExactKey $legacyConfig 'enabled')) {
                        $legacyValue = Get-T3ExactValue $legacyConfig 'enabled'
                        if ($legacyValue -is [bool]) { $legacyEnabled = $legacyValue } else { $counts.unverifiable++; $strict.Add('unverifiable') }
                    }
                    $driverDefault = $script:T3EnabledDefaults[[string]$driver]
                    $resolvedEnabled = if ($envelopeEnabled -eq $false -or $legacyEnabled -eq $false) { $false } elseif ($null -ne $envelopeEnabled) { $envelopeEnabled } elseif ($null -ne $legacyEnabled) { $legacyEnabled } else { $driverDefault }
                    if ($enabledApproved) { $safe.enabled = $resolvedEnabled }
                } elseif ($null -ne $envelopeEnabled -and $enabledApproved) { $safe.enabled = $envelopeEnabled }
                if ($config.Count -gt 0) { $safe.config = $config }
                $instances[$label] = $safe
                if ($knownIdTemplates.ContainsKey([string]$id)) {
                    $expected = $defaults.instances[$id]
                    $safeExpected = Convert-T3ExpectedInstanceForReport -Expected $expected -Workspace $Workspace -LayerNames $LayerNames
                    $state = if ($counts.unknown -gt $unknownBeforeInstance) { 'unknown' } elseif ($strict.Count -gt $strictBeforeInstance) { 'unverifiable' } else { 'matching' }
                    if ($state -eq 'matching' -and ($driver -cne $expected.envelope.driver -or $resolvedEnabled -ne $expected.envelope.enabled)) { $state = 'differs' }
                    $wantedConfig = $expected.config
                    foreach ($field in $wantedConfig.Keys) {
                        $wantedValue = $wantedConfig[$field]
                        if ($field -in @('binaryPath', 'commandPath') -and $wantedValue -is [string]) { $wantedValue = (Convert-T3Command $wantedValue $Workspace).value }
                        if ($field -eq 'launchArgs' -and $wantedValue -is [string] -and $wantedValue.StartsWith('--plugin-dir ', [StringComparison]::Ordinal)) {
                            $wantedValue = '--plugin-dir ' + (Convert-T3PluginDirectory $wantedValue.Substring('--plugin-dir '.Length) $Workspace $LayerNames).value
                        }
                        if ($config.Contains($field)) { $actualValue = $config[$field] }
                        elseif ($script:T3ConfigDefaults.ContainsKey([string]$driver) -and $script:T3ConfigDefaults[[string]$driver].ContainsKey($field)) { $actualValue = $script:T3ConfigDefaults[[string]$driver][$field] }
                        else { $actualValue = '{unset}' }
                        if ($state -eq 'matching' -and ($actualValue | ConvertTo-Json -Depth 16 -Compress) -cne ($wantedValue | ConvertTo-Json -Depth 16 -Compress)) { $state = 'differs' }
                    }
                    $instanceStates[$id] = $state
                    if ($state -eq 'differs') { $instanceDrift[$id] = @{ wanted = $safeExpected; observed = $safe } }
                } else {
                    $instanceStates[$label] = if ($driverKnown) { 'extra' } else { 'unverifiable' }
                }
            }
            $snapshot.providerInstances = $instances
        } elseif ($providerInstancesApproved -and (Test-T3ExactKey $inputState.value 'providerInstances')) {
            $counts.unverifiable++; $strict.Add('unverifiable')
            foreach ($id in $script:T3DefaultsTemplate.instances.Keys) { $instanceStates[$id.Replace('{Workspace}', (Get-T3WorkspaceSlug $Workspace))] = 'unverifiable' }
        }
    }
    $defaults = Get-T3Defaults $Workspace
    $drift = [Collections.Generic.List[object]]::new()
    foreach ($id in @($defaults.instances.Keys | Where-Object { $inputState.state -eq 'present' -and $providerInstancesApproved })) {
        $wanted = $defaults.instances[$id]
        if ($RuntimeNames -notcontains $wanted.runtime) { continue }
        $providerMap = Get-T3ExactValue $inputState.value 'providerInstances'
        if ($inputState.state -ne 'present' -or -not (Test-T3ExactKey $inputState.value 'providerInstances')) { $state = 'missing'; $strict.Add('missing') }
        elseif ($providerMap -isnot [System.Collections.IDictionary]) { $state = $instanceStates[$id] }
        elseif (-not (Test-T3ExactKey $providerMap $id)) { $state = 'missing'; $strict.Add('missing') }
        else { $state = $instanceStates[$id] }
        if ($state -in @('differs', 'unverifiable', 'unknown')) { $strict.Add($state) }
        $safeId = $script:T3DefaultsTemplate.instances.Keys | Where-Object { $_.Replace('{Workspace}', (Get-T3WorkspaceSlug $Workspace)) -ceq $id } | Select-Object -First 1
        $entry = @{ id = $safeId; state = $state }
        if ($state -eq 'differs' -and $instanceDrift.ContainsKey($id)) { $entry.wanted = $instanceDrift[$id].wanted; $entry.observed = $instanceDrift[$id].observed }
        $drift.Add($entry)
    }
    if ($providerInstancesApproved -and $inputState.state -eq 'present' -and (Test-T3ExactKey $inputState.value 'providerInstances') -and (Get-T3ExactValue $inputState.value 'providerInstances') -is [System.Collections.IDictionary]) {
        foreach ($instanceId in $instanceStates.Keys) { if ($instanceStates[$instanceId] -in @('extra', 'unverifiable')) { $drift.Add(@{ id = $instanceId; state = $instanceStates[$instanceId] }) } }
    }
    foreach ($key in @($defaults.app.Keys | Where-Object { $inputState.state -eq 'present' })) {
        $appDrift = $null
        if ($snapshot.Contains($key)) {
            if ($snapshot[$key] -ceq $defaults.app[$key]) { $state = 'matching' } else { $state = 'differs'; $strict.Add('differs'); $appDrift = @{ wanted = $defaults.app[$key]; observed = $snapshot[$key] } }
        } elseif ($inputState.state -eq 'present' -and (Test-T3ExactKey $inputState.value $key)) {
            $state = 'unverifiable'; $strict.Add('unverifiable')
        } else {
            $rule = $script:T3Allowed[$key]
            if (-not $rule.Contains('default')) { $state = 'unset (T3 default unknown)' }
            elseif (($rule.default | ConvertTo-Json -Depth 16 -Compress) -ceq ($defaults.app[$key] | ConvertTo-Json -Depth 16 -Compress)) { $state = 'unset' }
            else { $state = 'differs'; $strict.Add('differs'); $appDrift = @{ wanted = $defaults.app[$key]; observed = $rule.default } }
        }
        $entry = @{ id = $key; state = $state }
        if ($null -ne $appDrift) { $entry.wanted = $appDrift.wanted; $entry.observed = $appDrift.observed }
        $drift.Add($entry)
    }
    $canonical = if ($inputState.state -eq 'present') { $snapshot | ConvertTo-Json -Depth 64 -Compress } else { '{}' }
    if ($inputState.state -in @('malformed', 'unreadable')) { $strict.Add('malformedSource') }
    $snapshotPath = Join-Path $Workspace '.maxstack/t3/settings.snapshot.json'
    $stale = $true
    if (Test-T3SnapshotPathSafe -Workspace $Workspace -AllowMissing) {
        try {
            if ([IO.File]::Exists($snapshotPath)) {
                $stream = [IO.File]::Open($snapshotPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                try {
                    if ($stream.Length -le 2MB) {
                        $bytes = [byte[]]::new([int]$stream.Length + 1)
                        $read = 0
                        while ($read -lt $bytes.Length) {
                            $count = $stream.Read($bytes, $read, $bytes.Length - $read)
                            if ($count -eq 0) { break }
                            $read += $count
                        }
                        if ($read -eq $stream.Length) {
                            $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, 0, $read)
                            $stale = $text -cne ($canonical + "`n")
                        }
                    }
                } finally { $stream.Dispose() }
            }
        } catch { $stale = $true }
    }
    return [pscustomobject]@{ sourceState = $inputState.state; topLevelCount = if ($inputState.state -eq 'present') { $inputState.value.Count } else { 0 }; snapshot = $snapshot; canonical = $canonical; stale = $stale; counts = $counts; unknownKeys = @($unknownNames); unverifiableKeys = @($unverifiable); strictFailures = @($strict | Select-Object -Unique); drift = @($drift); snapshotSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical + "`n"))).ToLowerInvariant() }
}

function Test-T3SnapshotPathSafe {
    param([string] $Workspace, [switch] $AllowMissing)
    $target = Join-Path $Workspace '.maxstack/t3/settings.snapshot.json'
    $cursor = $Workspace
    foreach ($part in @('.maxstack', 't3')) {
        $cursor = Join-Path $cursor $part
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            if (-not $item.PSIsContainer) { return $false }
        } elseif (-not $AllowMissing -and [IO.Directory]::Exists((Split-Path -Parent $cursor))) {
            # A missing path component is normal during the first snapshot write.
        }
    }
    $targetItem = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if ($null -ne $targetItem -and (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $targetItem.PSIsContainer)) { return $false }
    if (-not $AllowMissing) {
        $temp = "$target.maxstack-tmp"
        $tempItem = Get-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        if ($null -ne $tempItem) { return $false }
    }
    return $true
}

function Assert-T3SnapshotDestination {
    param([string] $Workspace)
    $target = Join-Path $Workspace '.maxstack/t3/settings.snapshot.json'
    if (-not (Test-T3SnapshotPathSafe -Workspace $Workspace)) { throw 'T3 snapshot destination has a linked ancestor, unsafe leaf, or pre-existing temporary path.' }
    return $target
}

function Write-T3Snapshot {
    param([string] $Workspace, $Report)
    $target = Assert-T3SnapshotDestination $Workspace
    $folder = $Workspace
    foreach ($part in @('.maxstack', 't3')) {
        $folder = Join-Path $folder $part
        if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
    }
    $text = $Report.canonical + "`n"
    $temp = "$target.maxstack-$([guid]::NewGuid().ToString('N')).tmp"
    $createdTemp = $false
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $createdTemp = $true
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if (-not (Test-T3SnapshotPathSafe -Workspace $Workspace -AllowMissing)) { throw 'T3 snapshot destination changed during the write.' }
        if (Test-Path -LiteralPath $target -PathType Leaf) { [IO.File]::Move($temp, $target, $true) }
        else { [IO.File]::Move($temp, $target) }
    } finally {
        if ($createdTemp -and [IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
    return Get-FileHash -LiteralPath $target -Algorithm SHA256 | Select-Object -ExpandProperty Hash
}

function Write-T3SettingsReport {
    param($Report, [string] $Workspace, [bool] $SnapshotEnabled)
    if (-not $SnapshotEnabled) { Write-Host 'T3 settings: snapshot disabled by workspace settings.'; return }
    if ($Report.sourceState -eq 'missing') { Write-Host 'T3 settings: no settings file was found at the explicitly selected source.'; return }
    if ($Report.sourceState -ne 'present') { Write-Host "T3 settings: source is $($Report.sourceState); existing snapshot was preserved."; return }
    Write-Host ("T3 settings: {0} top-level keys: {1} recorded, {2} excluded, {3} unknown, {4} unverifiable" -f $Report.topLevelCount, $Report.counts.recorded, $Report.counts.excluded, $Report.counts.unknown, $Report.counts.unverifiable)
    foreach ($name in $Report.unknownKeys) { Write-Host "  unknown: $name (not in t3/allowlist.json)" }
    foreach ($name in $Report.unverifiableKeys) { Write-Host "  unverifiable: $name" }
    foreach ($item in $Report.drift) {
        if ($item.Contains('wanted')) { Write-Host ("  {0}  {1} (wanted {2}; observed {3})" -f $item.id, $item.state, ($item.wanted | ConvertTo-Json -Compress), ($item.observed | ConvertTo-Json -Compress)) }
        else { Write-Host ("  {0}  {1}" -f $item.id, $item.state) }
    }
    if ($Report.stale) { Write-Host 'Snapshot: .maxstack/t3/settings.snapshot.json (stale: would change)' }
    else { Write-Host 'Snapshot: .maxstack/t3/settings.snapshot.json (current)' }
}
