# Local task runner. Recipes mirror .github/workflows/ci.yml and the
# repo-standard local-run commands.
set windows-shell := ["pwsh", "-NoLogo", "-Command"]

python := if os_family() == "windows" { "python" } else { "python3" }

default:
    @just --list

# Install the pinned tools.
install:
    mise install

# Run every linter over changed files.
lint:
    mise exec -- flint run

# Run every linter over every tracked file.
lint-full:
    mise exec -- flint run --full

# Auto-fix lint issues.
lint-fix:
    mise exec -- flint run --fix

# Run the aislop score gate at the version CI pins.
aislop:
    npx --yes aislop@0.16.1 ci

# Scan the filesystem with Trivy.
security:
    trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL .

# Validate the workspace manifests the installer consumes.
validate:
    {{python}} scripts/verify-manifests.py

# Validate the manifests and check the Claude pin against GitHub. Needs gh and network.
validate-online:
    {{python}} scripts/verify-manifests.py --online

# Run the node test suite under scripts/. The installer tests need PowerShell 7 and git; a missing program skips its test.
test-node:
    node --test --test-concurrency=4 scripts/*.test.mjs

# Run one shard of the node test suite. CI runs four shards on separate Windows runners.
test-node-shard index total:
    node --test --test-concurrency=4 --test-shard={{index}}/{{total}} scripts/*.test.mjs

# The installer suite stays in test-node, because it drives Install-Workspace.ps1 under PowerShell 7.

# Run the checks that need no Windows: the manifest verifier and the Node tests that run on any OS.
test:
    {{python}} scripts/verify-manifests.py
    node --test scripts/ordinal-guard.test.mjs scripts/generate-layers.test.mjs scripts/verify-manifests.test.mjs scripts/verify-pi-harness.test.mjs

# The focused POSIX portability set. Hosted macOS and Linux jobs are informational.
test-posix:
    node --test scripts/ordinal-guard.test.mjs
    node --test scripts/Install-Paths.test.mjs
    node --test scripts/Install-Links.test.mjs
    node --test scripts/verify-manifests.test.mjs
    node --test scripts/Install-Workspace.macos.test.mjs

# Keep the existing macOS recipe name for local callers.
test-macos:
    just test-posix

# Run the lint, test, and AI-slop gates.
verify: lint test aislop

# Run the same checks CI runs.
check: lint validate

# Check that the agent tool set covers the service owners. Workspace-local: it
# reads the simpsonm09-dev-setup and org plugin checkouts, which CI does not have.
check-agent-tools:
    node scripts/check-agent-tools.mjs

# Project layer sources into a dedicated runtime bundle. Arguments: runtime, output directory,
# layer roots separated by ';' (name=path allowed), then optionally --check. Each value is quoted
# for the shell the recipe runs in: PowerShell on Windows doubles an apostrophe, POSIX sh uses quote().
generate-layers runtime out layers check="":
    node scripts/generate-layers.mjs --runtime {{ if os_family() == "windows" { "'" + replace(runtime, "'", "''") + "'" } else { quote(runtime) } }} --out {{ if os_family() == "windows" { "'" + replace(out, "'", "''") + "'" } else { quote(out) } }} --layers {{ if os_family() == "windows" { "'" + replace(layers, "'", "''") + "'" } else { quote(layers) } }} {{ if check == "" { "" } else if os_family() == "windows" { "'" + replace(check, "'", "''") + "'" } else { quote(check) } }}

# Run the model-free Pi smoke check against the resolved workspace: a stub model on loopback, no GPU, no
# download. It reads the workspace's Pi settings and wrapper and writes nothing to the workspace.
verify-pi:
    node scripts/verify-pi-harness.mjs

# Check local Codex project-root marker behavior without a model request. Pass the native Codex executable.
verify-codex-discovery codex:
    node scripts/verify-codex-discovery.mjs --codex {{ if os_family() == "windows" { "'" + replace(codex, "'", "''") + "'" } else { quote(codex) } }}

# Run the Biome complexity gate over the repository.
complexity:
    mise exec -- biome lint .

# Prune remote-tracking refs and delete local branches merged into main.
prune:
    node scripts/prune.mjs
