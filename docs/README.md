# Documentation

Index for this repository.

## Guides

- [Pi update compatibility](release-notes/2026-10-21-pi-update-compatibility.md) describes the managed Pi wrapper's `update --self` behavior and safety checks.
- [Install and reload](install.md) covers the model rule, the runtime and layer selection, the runtimes, layer sources and their overrides, `-Update`, the ownership record, removing a runtime or layer, and uninstalling.
- [T3 settings snapshot](features/t3-settings.md) documents the explicit source, allowlisted workspace snapshot, and read-only drift report.
- [Workspace settings](features/settings.md) describes workspace discovery and the optional selection file's additive behavior. Discovery is implemented in `scripts/Install-WorkspaceDiscovery.ps1` and tested by `scripts/Install-WorkspaceDiscovery.test.mjs`.
- [Current alignment](features/current-alignment.md) records the verified delivery state and the remaining acceptance work against the end goal.
- [Antigravity skills](features/antigravity.md) documents the opt-in Antigravity runtime and its shared skill ownership.
- [Codex discovery check](features/codex-discovery-check.md) describes the local marker acceptance tool and its limits.
- [Layout](layout.md) describes every top-level path.
- [Repository relationships](relationship.md) names the repository ownership, the one cross-repo edge, and the workspace definition.
- [MCP servers](mcp.md) defines the workspace MCP servers and their default states.
- [MCP installation guide](mcp-installation-guide-v2.md) is the original source guide, kept for provenance.
- [Plugin publishing](plugin-publishing.md) describes how the installer assembles each runtime of each layer, and the one pstack pin.
- [T3 setup](t3-setup.md) covers running OpenCode, Claude Code, and the Copilot CLI from T3 against the workspace.
- [Master template](master-template.md) records the plan to maintain one master source and convert it for seven runtimes.
- [Neutral layer generator](neutral-layer-generator.md) defines the skill and OpenCode MCP projection, its output, ownership, and installer boundary.
- [Parity matrix](parity-matrix.md) records which AI behaviors are the same, different, or impossible in each of the seven runtimes, with evidence.
- [Setup plan](setup-plan.md) is the historical OpenCode setup plan. T3 Code hosts the sessions now.
- [Decisions](decisions.tsv) is the append-only decision trail.

## Release notes

- [Copilot workspace instructions](release-notes/2026-10-23-copilot-workspace-instructions.md) describes the offline wrapper projection and keeps live T3 ACP/Copilot consumption explicitly pending.
- [POSIX installer fixture coverage](release-notes/2026-10-23-posix-installer-fixture-coverage.md) records the existing macOS and Linux fixture lifecycle coverage and keeps live macOS CLI and hook behavior explicitly unverified.
- [Non-Claude instruction collision](release-notes/2026-10-23-non-claude-claude-instructions-collision.md) records that a user `CLAUDE.md` does not block generated `AGENTS.md` when Claude is not selected.
- [Skill metadata fixture](release-notes/2026-10-22-skill-metadata-fixture.md) records the bounded byte-preservation fixture and its documentation contract.
- [Codex discovery check](release-notes/2026-10-22-codex-discovery-check.md) records the portable, model-free marker acceptance tool.
