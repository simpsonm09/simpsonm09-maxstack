"""Check that the workspace settings schema matches its seed and installer validator."""

from __future__ import annotations

import json
import re
from pathlib import Path


def _read_json(path: Path, root: Path, failures: list[str]) -> object | None:
    if not path.is_file():
        failures.append(f"missing file: {path.relative_to(root)}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        failures.append(f"{path.relative_to(root)} is not valid UTF-8")
        return None
    except json.JSONDecodeError as error:
        failures.append(f"{path.relative_to(root)} is not valid JSON: {error}")
        return None


def _object(parent: dict, key: str, name: str, failures: list[str]) -> dict:
    value = parent.get(key)
    if not isinstance(value, dict):
        failures.append(f"settings schema {name} must be an object")
        return {}
    return value


def _enum(node: dict, key: str, failures: list[str], name: str) -> tuple:
    item = node.get(key)
    if not isinstance(item, dict):
        failures.append(f"settings schema {name} must be an object")
        return ()
    values = item.get("enum")
    if not isinstance(values, list):
        failures.append(f"settings schema {name} must have an enum list")
        return ()
    return tuple(values)


def _validator_constants(validator: str) -> dict[str, tuple[str, ...]]:
    names = (
        "SettingsTopLevelKeys",
        "SettingsRuntimeIds",
        "SettingsCliModes",
        "SettingsOsModes",
        "SettingsT3Defaults",
    )
    constants: dict[str, tuple[str, ...]] = {}
    for name in names:
        match = re.search(rf"\$script:{name}\s*=\s*@\(([^)]*)\)", validator)
        if match is not None:
            constants[name] = tuple(re.findall(r"'([^']*)'", match.group(1)))
    return constants


def _check_nested_keys(properties: dict, validator: str, failures: list[str]) -> None:
    nested = (
        (
            "runtime",
            "runtimes",
            r"Assert-SettingsObjectKeys \$value\.runtimes\[\$runtime\] @\(([^)]*)\)",
            ("cli",),
        ),
        (
            "layer",
            "layers",
            r"Assert-SettingsObjectKeys \$value\.layers\[\$layer\] @\(([^)]*)\)",
            ("source",),
        ),
        (
            "T3",
            "t3",
            r"Assert-SettingsObjectKeys \$value\.t3 @\(([^)]*)\)",
            ("cli", "snapshot", "defaults"),
        ),
    )
    for block_name, property_name, pattern, expected in nested:
        match = re.search(pattern, validator)
        validator_keys = (
            tuple(re.findall(r"'([^']*)'", match.group(1))) if match else ()
        )
        block = properties.get(property_name)
        if not isinstance(block, dict):
            failures.append(f"settings schema {block_name} must be an object")
            schema_nested_keys = ()
        else:
            entry = block if block_name == "T3" else block.get("additionalProperties")
            if not isinstance(entry, dict):
                failures.append(f"settings schema {block_name} entries must be objects")
                schema_nested_keys = ()
            else:
                entry_properties = entry.get("properties")
                if not isinstance(entry_properties, dict):
                    failures.append(
                        f"settings schema {block_name} entries need an object properties field"
                    )
                    schema_nested_keys = ()
                else:
                    schema_nested_keys = tuple(entry_properties.keys())
        if validator_keys != expected or schema_nested_keys != expected:
            failures.append(
                f"settings schema {block_name} keys differ from Install-Settings.ps1 validator keys"
            )


def _check_enums(properties: dict, constants: dict, failures: list[str]) -> None:
    runtime_schema = properties.get("runtimes")
    runtime_entries = (
        runtime_schema.get("additionalProperties")
        if isinstance(runtime_schema, dict)
        else None
    )
    runtime_properties = (
        runtime_entries.get("properties") if isinstance(runtime_entries, dict) else {}
    )
    if not isinstance(runtime_properties, dict):
        runtime_properties = {}
    t3 = properties.get("t3")
    t3_properties = t3.get("properties") if isinstance(t3, dict) else {}
    if not isinstance(t3_properties, dict):
        t3_properties = {}
    for name, expected_values, node, key in (
        ("SettingsCliModes", ("detect", "install"), runtime_properties, "cli"),
        ("SettingsOsModes", ("auto", "windows", "macos", "linux"), properties, "os"),
        (
            "SettingsT3Defaults",
            ("leave-alone", "apply-defaults"),
            t3_properties,
            "defaults",
        ),
    ):
        values = _enum(node, key, failures, f"{name} enum")
        if constants.get(name) != values or values != expected_values:
            failures.append(
                f"settings schema values differ from Install-Settings.ps1 {name}"
            )


def _check_source_length(properties: dict, validator: str, failures: list[str]) -> None:
    source_limit = re.search(r"\$script:SettingsSourceMaxLength\s*=\s*(\d+)", validator)
    layers = properties.get("layers")
    layer_entries = (
        layers.get("additionalProperties") if isinstance(layers, dict) else None
    )
    layer_properties = (
        layer_entries.get("properties") if isinstance(layer_entries, dict) else None
    )
    source_schema = (
        layer_properties.get("source") if isinstance(layer_properties, dict) else None
    )
    if (
        source_limit is None
        or not isinstance(source_schema, dict)
        or source_schema.get("type") != "string"
        or source_schema.get("minLength") != 1
        or source_schema.get("maxLength") != int(source_limit.group(1))
    ):
        failures.append(
            "settings source schema length differs from Install-Settings.ps1 validator limit"
        )


def _check_closed_objects(properties: dict, failures: list[str]) -> None:
    for name in ("runtimes", "layers", "t3"):
        block = properties.get(name)
        if not isinstance(block, dict):
            failures.append(f"settings schema {name} must be an object")
            continue
        if block.get("type") != "object" or (
            name == "t3" and block.get("additionalProperties") is not False
        ):
            failures.append(f"settings schema {name} must be a closed object")
        entry = block if name == "t3" else block.get("additionalProperties")
        if (
            not isinstance(entry, dict)
            or entry.get("type") != "object"
            or entry.get("additionalProperties") is not False
        ):
            failures.append(f"settings schema {name} entries must be closed objects")


def _check_schema(
    schema: dict, constants: dict, validator: str, failures: list[str]
) -> None:
    if (
        schema.get("type") != "object"
        or schema.get("additionalProperties") is not False
    ):
        failures.append("maxstack.settings.schema.json must be a closed object schema")
    properties = _object(schema, "properties", "properties", failures)
    version_schema = properties.get("version")
    if not isinstance(version_schema, dict):
        failures.append("settings schema version must be an object")
        version_schema = {}
    if (
        schema.get("required") != ["version"]
        or version_schema.get("type") != "integer"
        or version_schema.get("const") != 1
    ):
        failures.append("settings schema must require version 1")
    if constants.get("SettingsTopLevelKeys") != tuple(properties.keys()):
        failures.append(
            "settings schema top-level keys differ from Install-Settings.ps1 validator keys"
        )

    runtimes = _object(properties, "runtimes", "runtimes", failures)
    runtime_names = _object(
        runtimes, "propertyNames", "runtimes propertyNames", failures
    )
    runtime_enum = runtime_names.get("enum")
    if not isinstance(runtime_enum, list):
        failures.append("settings schema runtimes propertyNames must have an enum list")
        runtime_enum = []
    if constants.get("SettingsRuntimeIds") != tuple(runtime_enum):
        failures.append(
            "settings schema runtime ids differ from Install-Settings.ps1 validator ids"
        )
    _check_nested_keys(properties, validator, failures)
    _check_enums(properties, constants, failures)
    _check_source_length(properties, validator, failures)
    _check_closed_objects(properties, failures)


def check_settings_files(root: Path, failures: list[str]) -> None:
    schema = _read_json(
        root / "schemas" / "maxstack.settings.schema.json", root, failures
    )
    seed = _read_json(root / "workspace" / "maxstack.settings.json", root, failures)
    validator_path = root / "scripts" / "Install-Settings.ps1"
    if not validator_path.is_file():
        failures.append("scripts/Install-Settings.ps1 is missing")
        return
    validator = validator_path.read_text(encoding="utf-8")
    if schema is None or seed is None:
        return
    if not isinstance(schema, dict):
        failures.append("maxstack.settings.schema.json must be an object")
        return
    if seed != {"version": 1}:
        failures.append(
            "workspace/maxstack.settings.json must be the path-free version 1 seed"
        )
    _check_schema(schema, _validator_constants(validator), validator, failures)
