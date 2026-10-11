#!/usr/bin/env python3
"""Verify the installed workspace bundle against stack.lock.json, and that no global install remains.

Each runtime the lock records is checked against the files on disk: the Claude plugin
folders, the OpenCode plugin folders and their agent profiles, the nested OpenCode
entries the config names, the Copilot wrappers, and the Pi wrappers and settings.
"""

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys

from verify_ownership import check_owned, layer_names, selected

REQUIRED_SKILLS = (
    "poteto-mode",
    "setup-pstack",
    "principle-laziness-protocol",
)
PSTACK = "pstack"
OBSOLETE_CLAUDE_FILES = (
    ".claude-plugin/marketplace.json",
    ".claude/workspace-settings.json",
)
RETIRED_OPENCODE_FOLDERS = ("pstack-opencode",)
COPILOT_WRAPPERS = ("copilot.cmd", "copilot.sh")
COPILOT_ASK_LINE = 'set "AGENT_ACCESS_COPILOT_ASK=allow"'
PI_WRAPPERS = ("pi.cmd", "pi.sh")
PI_ASK_LINE = 'set "AGENT_ACCESS_PI_ASK=allow"'
PI_SH_ASK_LINE = "export AGENT_ACCESS_PI_ASK=allow"
RUNTIMES = ("claude", "opencode", "copilot", "pi")


def default_workspace() -> str:
    wsl = pathlib.Path("/mnt/d/dev/simpsonm09")
    if os.name != "nt" and wsl.is_dir():
        return str(wsl)
    return "D:/dev/simpsonm09"


def is_link(path: pathlib.Path) -> bool:
    """A junction on Windows, or a symlink elsewhere."""
    if hasattr(os.path, "isjunction") and os.path.isjunction(path):
        return True
    return path.is_symlink()


def frontmatter(text: str) -> str:
    """The frontmatter block of a profile, or nothing when it has none."""
    match = re.match(r"---\r?\n.*?\r?\n---\r?\n", text, re.DOTALL)
    return match.group(0) if match else ""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def is_reparse_point(path: str) -> bool:
    """A junction or a symbolic link. The tree walk lists it and never reads what it points to."""
    return os.path.islink(path) or (
        hasattr(os.path, "isjunction") and os.path.isjunction(path)
    )


def link_target_text(path: str) -> str:
    """The target a link names, without the Windows API prefix, as Get-LinkTargetText writes it."""
    text = os.readlink(path)
    for prefix in ("\\\\?\\", "\\??\\"):
        text = text.removeprefix(prefix)
    return text.rstrip("\\")


def folder_excluded(relative: str, rule: str) -> bool:
    """Mirror Test-TreeFolderExcluded: the legacy rule names the top-level node_modules without
    regard to case; the owned rule names node_modules and .git at any depth, exactly."""
    if rule == "legacy":
        return "/" not in relative and relative.lower() == "node_modules"
    return relative.split("/")[-1] in ("node_modules", ".git")


def tree_entries(root: pathlib.Path, rule: str) -> list[tuple[str, str]]:
    """Mirror Get-TreeEntries: each entry as (relative path, value), where the value is the file's
    SHA-256, or link: and the target. A link is never followed."""
    root_text = os.path.normpath(str(root))
    entries = []
    pending = [root_text]
    while pending:
        directory = pending.pop()
        for entry in os.scandir(directory):
            relative = os.path.relpath(entry.path, root_text).replace("\\", "/")
            if is_reparse_point(entry.path):
                entries.append((relative, f"link:{link_target_text(entry.path)}"))
            elif entry.is_dir(follow_symlinks=False):
                if not folder_excluded(relative, rule):
                    pending.append(entry.path)
            else:
                entries.append(
                    (relative, sha256_hex(pathlib.Path(entry.path).read_bytes()))
                )
    return entries


def tree_hash(entries: list[tuple[str, str]]) -> str:
    """Mirror Get-TreeLinesSha256: one line per entry, sorted by UTF-8 bytes, then the SHA-256 of
    that text."""
    lines = [f"{relative}\t{value}" for relative, value in entries]
    text = "\n".join(sorted(lines, key=lambda line: line.encode("utf-8"))) + "\n"
    return sha256_hex(text.encode("utf-8"))


def tree_sha256(root: pathlib.Path) -> str:
    """The owned hash of a folder, as Get-TreeSha256 computes it."""
    return tree_hash(tree_entries(root, "owned"))


def tree_sha256_legacy(root: pathlib.Path) -> str:
    """The legacy hash of a claude child, as Get-LegacyTreeSha256 computes it."""
    return tree_hash(tree_entries(root, "legacy"))


def load_lock(workspace: pathlib.Path, failures: list[str]) -> dict | None:
    lock_path = workspace / "stack.lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"cannot read {lock_path}: {error}")
        return None
    layers = lock.get("layers", [])
    if not layers or any(
        any(runtime not in layer for runtime in RUNTIMES) for layer in layers
    ):
        failures.append(
            f"{lock_path} predates the runtime records; rerun Install-Workspace.ps1 -Apply"
        )
        return None
    return lock


def is_unselected_layer(lock: dict, name: str) -> bool:
    """A layer the lock names but the selection leaves out. Its folders are left alone, not judged."""
    return name in layer_names(lock) and name not in selected(lock)[1]


def check_claude(lock: dict, workspace: pathlib.Path, failures: list[str]) -> None:
    """Check the Claude plugin tree against the claude records in stack.lock.json."""
    for obsolete in OBSOLETE_CLAUDE_FILES:
        if (workspace / obsolete).exists():
            failures.append(
                f"obsolete generated file from the marketplace design: {workspace / obsolete}"
            )

    recorded = {}
    for layer in lock["layers"]:
        claude = layer["claude"]
        if claude.get("enabled"):
            recorded[claude["plugin"]] = claude

    plugins_dir = workspace / ".claude" / "plugins"
    if plugins_dir.is_dir():
        for entry in sorted(plugins_dir.iterdir()):
            if entry.name not in recorded and not is_unselected_layer(lock, entry.name):
                failures.append(
                    f"stale Claude plugin folder not in stack.lock.json: {entry}"
                )

    for name, claude in recorded.items():
        child = workspace / claude["child"]
        if not child.exists():
            failures.append(f"missing Claude plugin '{name}': {child}")
            continue
        if claude["kind"] == "junction":
            target = workspace / claude["target"]
            if not is_link(child) or os.path.normcase(
                os.path.realpath(child)
            ) != os.path.normcase(os.path.realpath(target)):
                failures.append(f"Claude plugin '{name}' is not a link to {target}")
        elif is_link(child):
            failures.append(
                f"Claude plugin '{name}' should be a copy of the pinned folder, not a link"
            )
        manifest = child / ".claude-plugin" / "plugin.json"
        if not manifest.is_file():
            failures.append(f"Claude plugin '{name}' has no manifest at {manifest}")
        elif json.loads(manifest.read_text(encoding="utf-8")).get("name") != name:
            failures.append(
                f"Claude plugin '{name}' does not match the name in {manifest}"
            )
        if tree_sha256_legacy(child) != str(claude.get("treeSha256", "")).upper():
            failures.append(
                f"Claude plugin '{name}' differs from the tree recorded in stack.lock.json"
            )

    print(f"claude: {len(recorded)} plugin folder(s) recorded in {plugins_dir}")


def check_opencode(lock: dict, workspace: pathlib.Path, failures: list[str]) -> None:
    """Check each OpenCode folder, its entry, its config reference, and its agent profiles."""
    config_path = workspace / "opencode.jsonc"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"cannot read {config_path}: {error}")
        config = {}
    configured = config.get("plugin", [])
    for key in ("model", "small_model"):
        if key in config:
            failures.append(
                f"{config_path} sets {key}; maxstack sets no model. Rerun Install-Workspace.ps1 -Apply"
            )

    recorded = set()
    planned_plugins = []
    for layer in lock["layers"]:
        opencode = layer["opencode"]
        if not opencode.get("enabled"):
            continue
        folder = workspace / opencode["folder"]
        recorded.add(folder.name)
        entry = folder / opencode["entry"]
        if not entry.is_file():
            failures.append(f"missing OpenCode entry for '{layer['name']}': {entry}")
        plugin = opencode.get("plugin")
        if opencode.get("loader") == "config":
            planned_plugins.append(plugin)
            if plugin not in configured:
                failures.append(
                    f"{config_path} does not name the OpenCode entry {plugin} for '{layer['name']}'"
                )
            if not (workspace / plugin.removeprefix("./")).is_dir():
                failures.append(
                    f"the OpenCode plugin path {plugin} for '{layer['name']}' is not a folder"
                )
        for agent in opencode.get("agents", []):
            profile = workspace / ".opencode" / "agents" / agent
            if not profile.is_file():
                failures.append(f"missing agent profile: {profile}")
            elif re.search(
                r"(?m)^model:", frontmatter(profile.read_text(encoding="utf-8"))
            ):
                failures.append(
                    f"agent profile {profile} sets a model; Install-Workspace.ps1 -Apply removes it"
                )

    if sorted(configured) != sorted(planned_plugins):
        failures.append(
            f"{config_path} lists plugin entries {configured}, but stack.lock.json records {planned_plugins}"
        )

    plugins_dir = workspace / ".opencode" / "plugins"
    if plugins_dir.is_dir():
        for entry in sorted(plugins_dir.iterdir()):
            if entry.name in RETIRED_OPENCODE_FOLDERS:
                failures.append(
                    f"retired OpenCode plugin folder is still present: {entry}"
                )
            elif entry.name not in recorded and not is_unselected_layer(
                lock, entry.name
            ):
                failures.append(
                    f"stale OpenCode plugin folder not in stack.lock.json: {entry}"
                )

    if PSTACK not in selected(lock)[1]:
        return
    skills = workspace / ".opencode" / "plugins" / PSTACK / "skills"
    if not skills.is_dir():
        failures.append(f"missing vendored skills: {skills}")
    else:
        ids = sorted(entry.name for entry in skills.iterdir() if entry.is_dir())
        for required in REQUIRED_SKILLS:
            if required not in ids:
                failures.append(f"missing skill: {required}")
        print(f"skills: {len(ids)}")


def configured(lock: dict, runtime: str) -> bool:
    """Whether any layer's runtime block turns the runtime on."""
    return any((layer.get(runtime) or {}).get("enabled") for layer in lock["layers"])


def check_shell_bit(path: pathlib.Path, failures: list[str]) -> None:
    """A .sh wrapper is spawned directly, so off Windows it needs the executable bit."""
    if os.name != "nt" and path.is_file() and not os.access(path, os.X_OK):
        failures.append(
            f"{path} is not executable; rerun Install-Workspace.ps1 -Apply, which sets the bit"
        )


def check_missing_wrapper(
    lock: dict,
    runtime: str,
    command: str,
    bin_dir: pathlib.Path,
    failures: list[str],
    local_bin: pathlib.Path | None = None,
) -> None:
    """A disabled wrapper is wrong when layers configure the runtime and its CLI is installed for the workspace or on PATH.

    The installer left the wrapper out because the CLI was missing at apply time, so the
    fix is to apply again. The workspace install under local_bin is searched first, then PATH
    outside .maxstack\bin, as the installer searches them.
    """
    if not configured(lock, runtime):
        return
    if local_bin is not None:
        local = local_bin / (f"{command}.cmd" if os.name == "nt" else command)
        if local.is_file():
            failures.append(
                f"the {command} CLI is installed under {local_bin}, and layers configure {runtime}, but stack.lock.json records no {runtime} wrapper; rerun Install-Workspace.ps1 -Apply"
            )
            return
    found = shutil.which(command)
    if found is None:
        return
    bin_prefix = os.path.normcase(os.path.abspath(bin_dir)) + os.sep
    if os.path.normcase(os.path.abspath(found)).startswith(bin_prefix):
        return
    failures.append(
        f"the {command} CLI is on PATH, and layers configure {runtime}, but stack.lock.json records no {runtime} wrapper; rerun Install-Workspace.ps1 -Apply"
    )


def check_copilot(lock: dict, workspace: pathlib.Path, failures: list[str]) -> None:
    """Check the Copilot wrappers against their recorded hashes, switch, folders, and executable."""
    bin_dir = workspace / ".maxstack" / "bin"
    copilot = lock.get("copilot") or {}
    if not copilot.get("enabled"):
        for name in COPILOT_WRAPPERS:
            if (bin_dir / name).exists():
                failures.append(
                    f"Copilot wrapper {bin_dir / name} is present, but stack.lock.json records copilot disabled"
                )
        check_missing_wrapper(lock, "copilot", "copilot", bin_dir, failures)
        return

    for name, key in (("copilot.cmd", "cmdSha256"), ("copilot.sh", "shSha256")):
        path = bin_dir / name
        if not path.is_file():
            failures.append(f"missing Copilot wrapper: {path}")
        elif sha256_hex(path.read_bytes()) != str(copilot.get(key, "")).upper():
            failures.append(
                f"Copilot wrapper {path} differs from the text recorded in stack.lock.json"
            )
        if name.endswith(".sh"):
            check_shell_bit(path, failures)

    cmd = bin_dir / "copilot.cmd"
    if cmd.is_file():
        text = cmd.read_text(encoding="utf-8")
        if COPILOT_ASK_LINE not in text:
            failures.append(f"{cmd} does not set the ask switch: {COPILOT_ASK_LINE}")
        # The wrapper runs its executable on one line, which also names the plugin folders.
        run_lines = [
            line.strip() for line in text.splitlines() if "--plugin-dir" in line
        ]
        if len(run_lines) != 1:
            failures.append(
                f"{cmd} must run the executable on one line, found {len(run_lines)}"
            )
            return
        executable = re.match(r'^(?:call )?"([^"]+)"', run_lines[0])
        if executable is None or not pathlib.Path(executable.group(1)).is_file():
            failures.append(f"{cmd} does not run an executable that exists")
        found = [
            pathlib.Path(folder)
            for folder in re.findall(r'--plugin-dir "([^"]+)"', run_lines[0])
        ]
        expected = [
            workspace / layer["copilot"]["pluginDir"]
            for layer in lock["layers"]
            if layer["copilot"].get("enabled")
        ]
        if found != expected:
            failures.append(
                f"{cmd} names plugin folders {found}, but stack.lock.json records {expected}"
            )


def same_path(text: str, expected: pathlib.Path) -> bool:
    return os.path.normcase(os.path.abspath(text)) == os.path.normcase(
        os.path.abspath(expected)
    )


def check_pi_wrappers(
    lock_pi: dict, bin_dir: pathlib.Path, agent_dir: pathlib.Path, failures: list[str]
) -> None:
    """Check the Pi wrappers against their hashes, the agent folder, and the ask switch."""
    if not lock_pi.get("enabled"):
        for name in PI_WRAPPERS:
            if (bin_dir / name).exists():
                failures.append(
                    f"Pi wrapper {bin_dir / name} is present, but stack.lock.json records pi disabled"
                )
        return

    for name, key in (("pi.cmd", "cmdSha256"), ("pi.sh", "shSha256")):
        path = bin_dir / name
        if not path.is_file():
            failures.append(f"missing Pi wrapper: {path}")
        elif sha256_hex(path.read_bytes()) != str(lock_pi.get(key, "")).upper():
            failures.append(
                f"Pi wrapper {path} differs from the text recorded in stack.lock.json"
            )
        if name.endswith(".sh"):
            check_shell_bit(path, failures)

    cmd = bin_dir / "pi.cmd"
    if cmd.is_file():
        text = cmd.read_text(encoding="utf-8")
        if PI_ASK_LINE not in text:
            failures.append(f"{cmd} does not set the ask switch: {PI_ASK_LINE}")
        agent = re.search(r'^set "PI_CODING_AGENT_DIR=(.+)"$', text, re.MULTILINE)
        if agent is None or not same_path(agent.group(1), agent_dir):
            failures.append(f"{cmd} does not set PI_CODING_AGENT_DIR to {agent_dir}")
        executable = re.search(r'^set "PI_BIN=(.+)"$', text, re.MULTILINE)
        if executable is None or not pathlib.Path(executable.group(1)).is_file():
            failures.append(f"{cmd} does not name a Pi CLI that exists")

    sh = bin_dir / "pi.sh"
    if sh.is_file():
        text = sh.read_text(encoding="utf-8")
        if PI_SH_ASK_LINE not in text:
            failures.append(f"{sh} does not set the ask switch: {PI_SH_ASK_LINE}")
        agent = re.search(
            r'^export PI_CODING_AGENT_DIR="([^"\n]*)"$', text, re.MULTILINE
        )
        if agent is None or not same_path(agent.group(1), agent_dir):
            failures.append(f"{sh} does not set PI_CODING_AGENT_DIR to {agent_dir}")


def read_json_object(path: pathlib.Path, failures: list[str]) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"cannot read {path}: {error}")
        return None
    if not isinstance(value, dict):
        failures.append(f"{path} is not a JSON object")
        return None
    return value


def check_pi_settings(
    lock_pi: dict, agent_dir: pathlib.Path, failures: list[str]
) -> None:
    """Check the Pi settings list each recorded package and skills folder."""
    settings_path = agent_dir / "settings.json"
    packages = lock_pi.get("packages", [])
    skills = lock_pi.get("skills", [])
    if not settings_path.is_file():
        if packages or skills:
            failures.append(f"missing Pi settings: {settings_path}")
        return
    settings = read_json_object(settings_path, failures)
    if settings is None:
        return
    for kind, entries in (("packages", packages), ("skills", skills)):
        for entry in entries:
            if entry not in settings.get(kind, []):
                failures.append(
                    f"{settings_path} does not list the Pi {kind} entry {entry}, which stack.lock.json records"
                )
    for entry in packages:
        target = agent_dir / entry
        manifest = target / "package.json"
        if not manifest.is_file():
            failures.append(f"Pi package {entry} has no package.json at {manifest}")
            continue
        package = read_json_object(manifest, failures)
        if package is not None and "pi" not in package:
            failures.append(f"Pi package {entry} has no pi key in {manifest}")
    for entry in skills:
        if not (agent_dir / entry).is_dir():
            failures.append(f"Pi skills folder {entry} is missing: {agent_dir / entry}")


def check_pi_layers(
    lock: dict, workspace: pathlib.Path, agent_dir: pathlib.Path, failures: list[str]
) -> None:
    """Each layer's package and skills folder is one of the entries the lock records for Pi."""
    lock_pi = lock.get("pi") or {}
    recorded_packages = set(lock_pi.get("packages", []))
    recorded_skills = set(lock_pi.get("skills", []))
    for layer in lock["layers"]:
        record = layer["pi"]
        if not record.get("enabled"):
            continue
        if record.get("package"):
            entry = pathlib.Path(
                os.path.relpath(workspace / record["package"], agent_dir)
            ).as_posix()
            if entry not in recorded_packages:
                failures.append(
                    f"layer '{layer['name']}' is a Pi package at {record['package']}, but stack.lock.json does not record it"
                )
        if record.get("skills"):
            entry = pathlib.Path(
                os.path.relpath(workspace / record["skills"], agent_dir)
            ).as_posix()
            if entry not in recorded_skills:
                failures.append(
                    f"layer '{layer['name']}' has Pi skills at {record['skills']}, but stack.lock.json does not record them"
                )


def check_pi(lock: dict, workspace: pathlib.Path, failures: list[str]) -> None:
    """Check the Pi wrappers, the workspace Pi settings, and each layer's Pi record."""
    lock_pi = lock.get("pi") or {}
    bin_dir = workspace / ".maxstack" / "bin"
    agent_dir = workspace / lock_pi.get("agentDir", ".pi/agent")
    if not lock_pi.get("enabled"):
        local_bin = workspace / ".maxstack" / "npm" / "node_modules" / ".bin"
        check_missing_wrapper(lock, "pi", "pi", bin_dir, failures, local_bin)
    check_pi_wrappers(lock_pi, bin_dir, agent_dir, failures)
    check_pi_settings(lock_pi, agent_dir, failures)
    check_pi_layers(lock, workspace, agent_dir, failures)


def check_owned_on_disk(
    lock: dict, workspace: pathlib.Path, failures: list[str]
) -> None:
    """Each owned record matches the disk: the file's hash, the folder's tree hash, the link's
    target, or the Pi entries the settings list. The shape is checked by check_owned first."""
    for record in lock.get("owned", []):
        path = workspace / record["path"]
        kind = record["kind"]
        if kind == "file":
            if not path.is_file():
                failures.append(f"missing owned file: {path}")
            elif sha256_hex(path.read_bytes()) != record["sha256"]:
                failures.append(
                    f"owned file {path} differs from the hash recorded in stack.lock.json"
                )
        elif kind == "dir":
            if not path.is_dir():
                failures.append(f"missing owned folder: {path}")
            elif tree_sha256(path) != record["sha256"]:
                failures.append(
                    f"owned folder {path} differs from the tree hash recorded in stack.lock.json"
                )
        elif kind == "link":
            target = workspace / record["target"]
            if not is_link(path) or os.path.normcase(
                os.path.realpath(path)
            ) != os.path.normcase(os.path.realpath(target)):
                failures.append(f"owned link {path} does not point at {target}")
        else:
            settings = read_json_object(path, failures)
            if settings is None:
                continue
            listed = settings.get(record["key"], [])
            for entry in record["entries"]:
                if entry not in listed:
                    failures.append(
                        f"{path} does not list the owned {record['key']} entry {json.dumps(entry)}"
                    )


def check_global(home: pathlib.Path, failures: list[str]) -> None:
    global_skills = home / ".agents" / "skills"
    # Other tools own this folder too (the Cursor CLI installs its skills here), so
    # only a PStack skill counts as a leftover global install.
    if (global_skills / "poteto-mode").exists() or any(
        global_skills.glob("principle-*")
    ):
        failures.append(f"global PStack skills are still present under {global_skills}")

    if (home / ".config" / "opencode" / "AGENTS.md").exists():
        failures.append("global AGENTS.md is still present")

    global_agents = home / ".config" / "opencode" / "agents"
    if global_agents.is_dir():
        left = sorted(
            entry.name
            for entry in global_agents.iterdir()
            if entry.name.startswith("pstack-")
        )
        if left:
            failures.append(
                f"global pstack agent profiles are still present: {', '.join(left)}"
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=default_workspace())
    parser.add_argument("--home", default=os.path.expanduser("~"))
    args = parser.parse_args()

    workspace = pathlib.Path(args.workspace)
    home = pathlib.Path(args.home)
    failures: list[str] = []

    lock = load_lock(workspace, failures)
    # A runtime the selection leaves out is not checked. A missing lock means every runtime is expected.
    runtimes = selected(lock)[0] if lock is not None else {"opencode"}
    if "opencode" in runtimes and not (workspace / "opencode.jsonc").is_file():
        failures.append(f"missing workspace config: {workspace / 'opencode.jsonc'}")
    if lock is not None:
        if "claude" in runtimes:
            check_claude(lock, workspace, failures)
        if "opencode" in runtimes:
            check_opencode(lock, workspace, failures)
        if "copilot" in runtimes:
            check_copilot(lock, workspace, failures)
        if "pi" in runtimes:
            check_pi(lock, workspace, failures)
        owned_failures = len(failures)
        check_owned(lock, failures)
        if len(failures) == owned_failures:
            check_owned_on_disk(lock, workspace, failures)

    check_global(home, failures)

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print("PASS: workspace bundle present and no global PStack install found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
