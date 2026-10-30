#!/usr/bin/env python3
"""Check that the workspace manifests the installer consumes agree.

`scripts/Install-Workspace.ps1` reads `layers.json`, `pstack.lock.json`, and
`workspace/opencode.jsonc`. A drift between them installs a broken bundle, so this
fails CI first. By default it reads only the manifests and never reaches the network.
With `--online` it also asks GitHub whether the pinned branch still points at the
locked commit.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from verify_ownership import check_lock_file
from verify_settings import check_settings_files

REPO_ROOT = Path(__file__).resolve().parents[1]
HEX40 = re.compile(r"^[0-9a-f]{40}$")
GIT_URL = re.compile(r"^https://github\.com/[^/]+/[^/]+\.git$")
FOLDER_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
LAYER_KINDS = ("plugin", "config")
RUNTIMES = ("claude", "opencode", "copilot", "pi")
PIN_LOCK = "pstack.lock.json"
RETIRED_LOCK = "pstack-opencode.lock.json"
MODEL_KEYS = ("model", "small_model")
BYTECODE = re.compile(r"(^|/)__pycache__/|\.pyc$")


def is_nonempty_str(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def is_relative_path(value: object) -> bool:
    return (
        is_nonempty_str(value)
        and not str(value).startswith("/")
        and ".." not in str(value).split("/")
    )


def strip_jsonc(text: str) -> str:
    """Strip // and /* */ comments; the standard library has no JSONC parser."""
    out: list[str] = []
    index = 0
    in_string = False
    while index < len(text):
        char = text[index]
        if in_string:
            out.append(char)
            if char == "\\" and index + 1 < len(text):
                out.append(text[index + 1])
                index += 2
                continue
            if char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == "/" and index + 1 < len(text):
            next_char = text[index + 1]
            if next_char == "/":
                newline = text.find("\n", index)
                index = len(text) if newline == -1 else newline
                continue
            if next_char == "*":
                end = text.find("*/", index + 2)
                index = len(text) if end == -1 else end + 2
                continue
        out.append(char)
        index += 1
    return "".join(out)


def load_json(path: Path, failures: list[str]) -> dict | None:
    if not path.is_file():
        failures.append(f"missing file: {path.relative_to(REPO_ROOT)}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        failures.append(f"{path.relative_to(REPO_ROOT)} is not valid JSON: {error}")
        return None


def load_jsonc(path: Path, failures: list[str]) -> dict | None:
    if not path.is_file():
        failures.append(f"missing file: {path.relative_to(REPO_ROOT)}")
        return None
    try:
        return json.loads(strip_jsonc(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as error:
        failures.append(f"{path.relative_to(REPO_ROOT)} is not valid JSONC: {error}")
        return None


def check_runtime_block(where: str, runtimes: dict, failures: list[str]) -> None:
    for key, block in runtimes.items():
        if key not in RUNTIMES:
            failures.append(f"{where} names an unknown runtime '{key}'")
        if not isinstance(block, dict):
            failures.append(f"{where}.{key} must be an object")
    if "copilot" in runtimes and "claude" not in runtimes:
        failures.append(
            f"{where} declares copilot, which loads the Claude plugin folder, so it also needs claude"
        )
    if "pi" in runtimes and "claude" not in runtimes:
        failures.append(
            f"{where} declares pi, which lists the Claude plugin folder's skills, so it also needs claude"
        )


def check_opencode_block(where: str, block: dict, failures: list[str]) -> None:
    entry = block.get("entry", "index.ts")
    if not is_relative_path(entry) or not str(entry).endswith((".ts", ".js")):
        failures.append(f"{where}.entry must be a relative .ts or .js file")
    elif "/" not in entry and entry != "index.ts":
        failures.append(
            f"{where}.entry names the root file {entry}; only index.ts loads from the plugin folder itself"
        )
    if "agents" in block and not is_relative_path(block["agents"]):
        failures.append(f"{where}.agents must be a relative folder")
    if "files" in block:
        files = block["files"]
        if not isinstance(files, list) or not all(
            is_nonempty_str(item) for item in files
        ):
            failures.append(f"{where}.files must be a list of names")


def check_source(where: str, layer: dict, failures: list[str]) -> dict | None:
    """Check a layer's source; return the git pin it declares, if any."""
    source = layer.get("source")
    kind = layer.get("kind")
    if isinstance(source, str):
        if not GIT_URL.match(source):
            failures.append(
                f"{where} source must be an https github.com git URL: {source}"
            )
        if not is_relative_path(layer.get("path")):
            failures.append(f"{where} is a local checkout, so it needs a relative path")
        return None
    if not isinstance(source, dict):
        failures.append(
            f"{where} needs a source: a URL string with a path, or a git source object"
        )
        return None

    if kind != "plugin":
        failures.append(
            f"{where} is pinned to a git source, so its kind must be plugin"
        )
    if "path" in layer:
        failures.append(
            f"{where} has a git source, which carries its own path, so the layer needs no path"
        )
    url = source.get("url")
    if not isinstance(url, str) or not GIT_URL.match(url):
        failures.append(f"{where}.source.url must be an https github.com git URL")
    if not is_relative_path(source.get("path")):
        failures.append(
            f"{where}.source.path must be a relative path inside the repository"
        )
    if not isinstance(source.get("commit"), str) or not HEX40.match(source["commit"]):
        failures.append(
            f"{where}.source.commit must be a 40-character lowercase commit SHA"
        )
    if not is_nonempty_str(source.get("ref")):
        failures.append(f"{where}.source.ref must name the branch the commit came from")
    return source


def check_layer_runtimes(where: str, layer: dict, failures: list[str]) -> None:
    """Check a layer's runtime map and the prerequisites between its runtimes."""
    runtimes = layer.get("runtimes", {})
    if not isinstance(runtimes, dict):
        failures.append(f"{where}.runtimes must be an object")
        return
    check_runtime_block(f"{where}.runtimes", runtimes, failures)
    if (
        "claude" in runtimes
        and isinstance(layer.get("source"), str)
        and "opencode" not in runtimes
    ):
        failures.append(
            f"{where} declares claude from a local checkout, which links to its OpenCode copy, so it also needs opencode"
        )
    if isinstance(runtimes.get("opencode"), dict):
        check_opencode_block(
            f"{where}.runtimes.opencode", runtimes["opencode"], failures
        )


def check_layers(layers: dict | None, failures: list[str]) -> list[dict]:
    """Validate each layer and return the git sources it pins."""
    if layers is None:
        return []
    records = layers.get("layers")
    if not isinstance(records, list) or not records:
        failures.append("layers.json: layers must be a non-empty list")
        return []
    names: list[str] = []
    pins: list[dict] = []
    plugins = 0
    for index, layer in enumerate(records):
        where = f"layers.json: layers[{index}]"
        if not isinstance(layer, dict):
            failures.append(f"{where} must be an object")
            continue
        name = layer.get("name")
        if not is_nonempty_str(name) or not FOLDER_SAFE.match(name):
            failures.append(f"{where} name must be a folder-safe name")
        else:
            names.append(name)
        if layer.get("kind") not in LAYER_KINDS:
            failures.append(f"{where} kind must be one of {list(LAYER_KINDS)}")
        if layer.get("kind") == "plugin":
            plugins += 1
        pin = check_source(where, layer, failures)
        if pin is not None:
            pins.append(pin)
        check_layer_runtimes(where, layer, failures)

    if len(set(names)) != len(names):
        failures.append("layers.json: two layers share a name")
    if plugins != 1:
        failures.append(
            f"layers.json: expected exactly one plugin layer, found {plugins}"
        )
    return pins


def check_pin_lock(
    pin_lock: dict | None, pins: list[dict], failures: list[str]
) -> None:
    """The one pstack pin must name the same source as its git source in layers.json."""
    if not pins:
        if pin_lock is not None:
            failures.append(f"{PIN_LOCK} exists but no layer has a git source")
        return
    if pin_lock is None:
        failures.append(f"{PIN_LOCK} is required by the git source in layers.json")
        return
    if len(pins) != 1:
        failures.append(
            f"layers.json pins {len(pins)} git sources; {PIN_LOCK} records exactly one"
        )
        return
    pin = pins[0]
    for key in ("url", "path", "commit", "ref"):
        expected = pin.get(key)
        recorded = pin_lock.get("repository") if key == "url" else pin_lock.get(key)
        if recorded != expected:
            failures.append(
                f"{PIN_LOCK}: {key} does not match layers.json ({recorded} != {expected})"
            )
    commit = pin_lock.get("commit")
    if not isinstance(commit, str) or not HEX40.match(commit):
        failures.append(f"{PIN_LOCK}: commit must be a 40-character lowercase hex SHA")


def check_retired_lock(failures: list[str]) -> None:
    if (REPO_ROOT / RETIRED_LOCK).exists():
        failures.append(
            f"{RETIRED_LOCK} is retired: the pstack source is pinned once, in {PIN_LOCK}"
        )


def check_workspace_config(config: dict, failures: list[str]) -> None:
    for key in MODEL_KEYS:
        if key in config:
            failures.append(
                f"workspace/opencode.jsonc must not set {key}: maxstack sets no model, "
                "the user picks it in the harness"
            )
    if not is_nonempty_str(config.get("default_agent")):
        failures.append(
            "workspace/opencode.jsonc: default_agent must be a non-empty string"
        )
    if not isinstance(config.get("permissions"), list):
        failures.append("workspace/opencode.jsonc: permissions must be a list")
    if "mcpServers" in config:
        failures.append(
            "workspace/opencode.jsonc: use the V2 mcp.servers shape, not top-level mcpServers"
        )
    mcp = config.get("mcp")
    if not isinstance(mcp, dict):
        failures.append("workspace/opencode.jsonc: mcp must be an object")
        return
    if "enabled" in mcp:
        failures.append(
            "workspace/opencode.jsonc: mcp must not use the V1 enabled field; use disabled: true per server"
        )


def check_surface(failures: list[str]) -> None:
    if not (REPO_ROOT / "scripts" / "Install-Workspace.ps1").is_file():
        failures.append("scripts/Install-Workspace.ps1 is missing")
    if not (REPO_ROOT / "docs" / "plugin-publishing.md").is_file():
        failures.append("docs/plugin-publishing.md is missing")
    surface = (REPO_ROOT / "README.md", REPO_ROOT / "docs" / "layout.md")
    if not any(
        path.is_file() and PIN_LOCK in path.read_text(encoding="utf-8")
        for path in surface
    ):
        failures.append(f"README.md or docs/layout.md must reference {PIN_LOCK}")


def check_tracked_bytecode(failures: list[str]) -> None:
    """Fail when git tracks Python bytecode: a compiled file is a build product, and a tracked one goes stale."""
    if not (REPO_ROOT / ".git").exists():
        return
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files", "-z"],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except FileNotFoundError:
        failures.append("the bytecode check needs git on PATH")
        return
    if result.returncode != 0:
        failures.append(f"git ls-files failed: {result.stderr.strip() or 'no output'}")
        return
    for path in result.stdout.split("\0"):
        if path and BYTECODE.search(path):
            failures.append(
                f"{path} is tracked: run git rm --cached on it; __pycache__ and *.pyc belong in .gitignore"
            )


def check_t3_manifests(failures: list[str], contract_path: Path | None = None) -> None:
    """Keep the T3 snapshot policy, defaults, and reviewed server contract aligned."""
    allowlist = load_json(REPO_ROOT / "t3" / "allowlist.json", failures)
    defaults = load_json(REPO_ROOT / "t3" / "defaults.json", failures)
    fixture = load_json(REPO_ROOT / "scripts" / "fixtures" / "t3" / "server-settings-keys.json", failures)
    if not all(isinstance(item, dict) for item in (allowlist, defaults, fixture)):
        return
    top = allowlist.get("top")
    excluded = allowlist.get("excluded")
    fixture_keys = fixture.get("keys")
    if not isinstance(top, dict) or not isinstance(excluded, dict) or not isinstance(fixture_keys, list):
        failures.append("T3 allowlist and server settings fixture need top, excluded, and keys objects")
        return
    classified = set(top) | set(excluded)
    if set(top) & set(excluded):
        failures.append("T3 allowlist classifies a server setting as both allowed and excluded")
    if set(fixture_keys) != classified:
        missing = sorted(set(fixture_keys) - classified)
        extra = sorted(classified - set(fixture_keys))
        failures.append(f"T3 server settings keys differ from the allowlist (unclassified={missing}, unknown-classification={extra})")
    if fixture.get("verifiedAgainst") != allowlist.get("verifiedAgainst", {}).get("t3"):
        failures.append("T3 server settings fixture and allowlist versions differ")
    if defaults.get("verifiedAgainst") != allowlist.get("verifiedAgainst"):
        failures.append("T3 defaults and allowlist versions differ")
    enabled_defaults = allowlist.get("driverEnabledDefaults")
    expected_drivers = {"claudeAgent", "codex", "pi", "opencode", "antigravity", "acpRegistry"}
    if not isinstance(enabled_defaults, dict) or set(enabled_defaults) != expected_drivers or not all(type(value) is bool for value in enabled_defaults.values()):
        failures.append("T3 allowlist driver enabled defaults do not cover the reviewed drivers")
    drivers = allowlist.get("drivers")
    if not isinstance(drivers, dict) or set(drivers) != expected_drivers:
        failures.append("T3 driver policy does not cover the reviewed drivers")
        drivers = {}
    for driver, policy in drivers.items():
        if not isinstance(policy, dict) or not isinstance(policy.get("allowed"), list) or not isinstance(policy.get("excluded"), list):
            failures.append(f"T3 driver policy {driver} needs allowed and excluded lists")
            continue
        if set(policy["allowed"]) & set(policy["excluded"]):
            failures.append(f"T3 driver policy {driver} classifies a config key as allowed and excluded")
        if driver == "acpRegistry":
            values = policy.get("values")
            if not isinstance(values, dict) or values.get("agentId") != ["github-copilot-cli"]:
                failures.append("T3 ACP registry policy must name the reviewed scalar agent id")
    envelope = allowlist.get("providerEnvelope")
    if not isinstance(envelope, dict) or not isinstance(envelope.get("allowed"), list) or not isinstance(envelope.get("excluded"), dict):
        failures.append("T3 provider envelope needs allowed and excluded rules")
    elif set(envelope["allowed"]) & set(envelope["excluded"]):
        failures.append("T3 provider envelope classifies a field as allowed and excluded")
    commands = allowlist.get("commands")
    launch_args = allowlist.get("launchArgs")
    if not isinstance(commands, list) or not commands or not all(isinstance(item, str) for item in commands):
        failures.append("T3 command allowlist must be a non-empty string list")
    if not isinstance(launch_args, dict) or launch_args.get("allowedFlags") != ["--plugin-dir"] or not isinstance(launch_args.get("pathRoots"), list):
        failures.append("T3 launch argument policy needs the reviewed flag and path roots")
    for key, rule in top.items():
        if not isinstance(rule, dict) or rule.get("rule") not in {"bool", "enum", "object", "instances"}:
            failures.append(f"T3 allowlist top rule {key} has an unsupported shape")
            continue
        kind = rule["rule"]
        if kind == "enum" and (not isinstance(rule.get("values"), list) or not all(isinstance(value, str) for value in rule["values"])):
            failures.append(f"T3 allowlist enum {key} needs string values")
        if kind == "object":
            children = rule.get("keys")
            if not isinstance(children, dict) or not children:
                failures.append(f"T3 object rule {key} needs nested keys")
                continue
            for child_name, child_rule in children.items():
                if not isinstance(child_rule, dict) or child_rule.get("rule") not in {"bool", "nullable-int"}:
                    failures.append(f"T3 object rule {key}.{child_name} has an unsupported shape")
                elif child_rule.get("rule") == "nullable-int" and (type(child_rule.get("minimum")) is not int or type(child_rule.get("maximum")) is not int or child_rule["minimum"] < 1 or child_rule["maximum"] < child_rule["minimum"]):
                    failures.append(f"T3 object rule {key}.{child_name} needs valid integer bounds")
    default_instances = defaults.get("instances")
    if not isinstance(default_instances, dict):
        failures.append("T3 defaults need an instances object")
        return
    expected_ids = {"claude{Workspace}", "copilot{Workspace}", "pi{Workspace}"}
    if set(default_instances) != expected_ids:
        failures.append("T3 defaults must cover the three reviewed workspace provider templates")
    for instance_id, instance in default_instances.items():
        if not isinstance(instance, dict):
            failures.append(f"T3 defaults {instance_id} must be an object")
            continue
        if t3_contains_model_selection(instance):
            failures.append(f"T3 defaults {instance_id} includes a model selection")
        runtime = instance.get("runtime")
        if runtime not in {"claude", "copilot", "pi"} or "harness" in instance:
            failures.append(f"T3 defaults {instance_id} needs a reviewed runtime name")
        driver = instance.get("envelope", {}).get("driver") if isinstance(instance.get("envelope"), dict) else None
        for section_name in ("envelope", "config"):
            section = instance.get(section_name, {})
            if not isinstance(section, dict):
                failures.append(f"T3 defaults {instance_id}.{section_name} must be an object")
                continue
            for key in section:
                driver_policy = drivers.get(driver)
                allowed = envelope.get("allowed", []) if section_name == "envelope" and isinstance(envelope, dict) else driver_policy.get("allowed", []) if isinstance(driver_policy, dict) else []
                if key not in allowed:
                    failures.append(f"T3 defaults {instance_id}.{key} is not allowed")
        instance_envelope = instance.get("envelope")
        if isinstance(instance_envelope, dict) and (not isinstance(instance_envelope.get("driver"), str) or type(instance_envelope.get("enabled")) is not bool):
            failures.append(f"T3 defaults {instance_id}.envelope needs a driver and boolean enabled field")
    if "defaultModelSelection" in defaults or "textGenerationModelSelection" in defaults:
        failures.append("T3 defaults must not define model selections")
    app = defaults.get("app")
    if not isinstance(app, dict):
        failures.append("T3 defaults app section must be an object")
    else:
        for key, value in app.items():
            rule = top.get(key)
            if not isinstance(rule, dict) or rule.get("rule") == "exclude" or key == "providerInstances":
                failures.append(f"T3 app default {key} is not an allowed setting")
                continue
            kind = rule.get("rule")
            valid = (kind == "bool" and type(value) is bool) or (kind == "enum" and (value is None and rule.get("nullable") is True or isinstance(value, str) and value in rule.get("values", [])))
            if kind == "object" and isinstance(value, dict):
                valid = all(name in rule.get("keys", {}) and ((rule["keys"][name].get("rule") == "bool" and type(item) is bool) or (rule["keys"][name].get("rule") == "nullable-int" and (item is None or type(item) is int and rule["keys"][name]["minimum"] <= item <= rule["keys"][name]["maximum"]))) for name, item in value.items())
            if not valid:
                failures.append(f"T3 app default {key} does not match its allowlist type")
    if contract_path is not None:
        try:
            source = contract_path.read_text(encoding="utf-8")
            match = re.search(r"export const ServerSettings = Schema\.Struct\(\{([\s\S]*?)\n\}\);", source)
            if match is None:
                raise ValueError("ServerSettings schema not found")
            contract_keys = set(re.findall(r"(?m)^  ([A-Za-z][A-Za-z0-9]*):", match.group(1)))
            if contract_keys != set(fixture_keys):
                failures.append("explicit T3 contract source does not match the reviewed key fixture")
            schema_names = {
                "claudeAgent": "ClaudeSettings",
                "codex": "CodexSettings",
                "pi": "PiSettings",
                "opencode": "OpenCodeSettings",
                "antigravity": "AntigravitySettings",
                "acpRegistry": "AcpRegistrySettings",
            }
            for driver, schema_name in schema_names.items():
                schema_match = re.search(rf"export const {schema_name} =([\s\S]*?)(?=\nexport const |\Z)", source)
                if schema_match is None:
                    failures.append(f"explicit T3 contract source is missing {schema_name}")
                    continue
                enabled_match = re.search(r"enabled:\s*Schema\.Boolean\.pipe\([\s\S]{0,350}?withDecodingDefault\(Effect\.succeed\((true|false)\)", schema_match.group(1))
                expected_enabled = enabled_defaults.get(driver) if isinstance(enabled_defaults, dict) else None
                if enabled_match is None or (enabled_match.group(1) == "true") != expected_enabled:
                    failures.append(f"explicit T3 contract source changed {driver} enabled default")
            provider_match = re.search(r"providers:\s*Schema\.Struct\(\{([\s\S]*?)\n  \}\)\.pipe", source)
            if provider_match is not None:
                legacy_drivers = set(re.findall(r"(?m)^    ([A-Za-z][A-Za-z0-9]*):", provider_match.group(1)))
                if "acpRegistry" in legacy_drivers or not {"claudeAgent", "codex", "pi", "opencode", "antigravity"}.issubset(legacy_drivers):
                    failures.append("explicit T3 contract source changed the DEFAULT_SERVER_SETTINGS.providers driver map")
        except (OSError, UnicodeError, ValueError):
            failures.append("explicit T3 contract source could not be checked: invalid or unreadable source")


def t3_contains_model_selection(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            key in {"defaultModelSelection", "textGenerationModelSelection"}
            or t3_contains_model_selection(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(t3_contains_model_selection(child) for child in value)
    return False


def run_command(args: list[str], failures: list[str]) -> str | None:
    """Run a read-only command; record a failure and return None when it cannot answer."""
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=120, check=False
        )
    except FileNotFoundError:
        failures.append(f"online check needs {args[0]} on PATH")
        return None
    except subprocess.TimeoutExpired:
        failures.append(f"online check timed out: {' '.join(args[:2])}")
        return None
    if result.returncode != 0:
        failures.append(
            f"online check failed: {' '.join(args[:2])}: {result.stderr.strip() or 'no output'}"
        )
        return None
    return result.stdout


def check_online(pins: list[dict], failures: list[str]) -> None:
    """Ask GitHub whether the pinned branch still points at the pinned commit."""
    for pin in pins:
        ref = f"refs/heads/{pin['ref']}"
        output = run_command(["git", "ls-remote", pin["url"], ref], failures)
        if output is None:
            continue
        heads = {
            name: sha
            for sha, _, name in (line.partition("\t") for line in output.splitlines())
            if name
        }
        head = heads.get(ref)
        if head is None:
            failures.append(f"branch {pin['ref']} is not on {pin['url']}")
        elif head != pin["commit"]:
            failures.append(
                f"branch {pin['ref']} is at {head}, not the pinned {pin['commit']}: re-pin {PIN_LOCK}"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--online",
        action="store_true",
        help="also check the pinned branch with git ls-remote",
    )
    parser.add_argument("--lock", type=Path, help="check a lock's ownership record")
    parser.add_argument("--t3-contract", type=Path, help="optionally compare an explicit local T3 settings.ts source")
    args = parser.parse_args()

    failures: list[str] = []
    layers = load_json(REPO_ROOT / "layers.json", failures)
    pin_lock = (
        load_json(REPO_ROOT / PIN_LOCK, failures)
        if (REPO_ROOT / PIN_LOCK).exists()
        else None
    )
    config = load_jsonc(REPO_ROOT / "workspace" / "opencode.jsonc", failures)

    pins = check_layers(layers, failures)
    check_pin_lock(pin_lock, pins, failures)
    check_retired_lock(failures)
    if config:
        check_workspace_config(config, failures)
    check_surface(failures)
    check_settings_files(REPO_ROOT, failures)
    check_t3_manifests(failures, args.t3_contract)
    check_tracked_bytecode(failures)
    if args.online and pins:
        check_online(pins, failures)
    if args.lock is not None:
        check_lock_file(args.lock, failures)

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    mode = " (online)" if args.online else ""
    print(
        f"PASS: workspace manifests agree with the installer and the pstack pin{mode}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
