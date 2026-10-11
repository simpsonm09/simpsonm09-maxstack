# Master template

This document records the design for one maintained source of AI functionality that `maxstack` converts for seven runtimes and installs into a workspace. It is a plan. Nothing here is built yet except the four runtimes the installer already supports.

## Goal

Maintain skills, agents, hooks, MCP servers, and instructions once. Install them so that every repository and worktree under a workspace folder, opened by any supported harness, has all of them.

The runtimes are Claude Code, GitHub Copilot CLI, OpenCode, Pi, Antigravity, Cursor, and Codex. The first four install today. Codex, Cursor, and Antigravity have no installer support.

## What the research found

Each harness decides for itself where it looks for configuration. Most do not look above the repository.

| Artifact | Across the seven runtimes |
| --- | --- |
| `SKILL.md` | Portable. The common frontmatter is `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`. The neutral source may use more keys, such as `user-invocable` and `paths` (24 and 1 of PStack's 58 skills today). The generator strips or maps any key a runtime does not understand. Pi, for one, ignores `user-invocable`, so the principle skills only show up in its completion list. |
| `AGENTS.md` | Portable. All seven read it. |
| MCP | Mostly portable. Claude Code and Cursor share the `mcpServers` JSON shape. OpenCode and Codex (TOML) need a conversion. |
| Hooks | A script that exits 2 on deny works in Claude Code, Copilot, Cursor, and Codex. OpenCode and Pi need a TypeScript shim. Antigravity is unchecked. |
| Agents | Five formats: Claude Code and Cursor markdown, Copilot profiles, OpenCode markdown, Codex TOML. Conversion needed. |
| Plugin manifests | No shared format. Repackage per runtime. |

How a workspace folder reaches the repositories beneath it:

| Runtime | Delivery |
| --- | --- |
| Claude Code, Copilot, OpenCode, Pi | A launch wrapper, flag, or environment variable. `CLAUDE.md` and Pi's `AGENTS.md` also walk up from the repository. |
| Codex | User level or per repository. `CODEX_HOME` relocates the user layer. Files in a folder above the git root are not read. |
| Cursor | Per repository or user level. No configuration-directory variable is documented. |
| Antigravity | Reads `.agents/` at the workspace root. Whether that reaches repositories opened inside the folder is unverified. |

Three behaviors constrain the design:

- A skill in a parent folder is invisible to most harnesses, because skill discovery stops at the repository or worktree root.
- Copilot, OpenCode, and Cursor read both `.claude/skills` and `.agents/skills`, so a skill present in both appears twice. Each workspace needs one canonical location per harness.
- Claude Code, Copilot, and Cursor hooks fail open on timeout or crash. A hook is a guardrail and not a sandbox.

## Design

1. **Neutral source per layer.** The org and personal repositories stay the source. Each keeps one tree: `skills/`, `agents/` with neutral frontmatter, `mcp.json`, `hooks/` with the gate core and its adapters, and `AGENTS.md`. PStack stays a pinned git source.
2. **One generator in `maxstack`.** It turns each layer into every runtime's format: plugin manifests, Codex TOML agents, OpenCode configuration, and Cursor and Antigravity rules. It runs when the installer applies and writes only into the workspace.
3. **Generated files are not committed.** Only neutral source is committed. CI fails when the generator's output differs from what the installer would write.
4. **Three delivery paths.**
   - A wrapper for Claude Code, Copilot, OpenCode, Pi, and Codex (through `CODEX_HOME`).
   - Files at the workspace root for Antigravity, once verified.
   - A generated stamp in each repository and worktree for Cursor, and for any harness without a launch hook. The stamp is excluded through `.git/info/exclude`, so nothing is committed and `git status` stays clean. A worktree created later needs the stamp step too.
5. **PStack follows upstream.** The fork branch carries only what upstream lacks. The generator converts PStack's agents for other runtimes, so the fork keeps no per-runtime copies.
6. **A workspace selects layers.** A second workspace, such as `mds368`, lists its own layers and runtimes. It needs no new code.

## Installer lifecycle

The installer selects runtimes and layers, records what it wrote, and removes it with `-Remove` and `-Uninstall`. Both are dry runs until `-Apply`, and [install.md](install.md#removing-and-uninstalling) states their rules. It still declares itself Windows-only. On Windows, `update` is built as `-Update` and `-Update -Check`, with the rules in [install.md](install.md#updating-the-sources). The target is one entry point with these commands, the same on Windows and macOS:

| Command | Effect |
| --- | --- |
| `install` | Adds the selected runtimes and layers. Running it again changes nothing. Adding a runtime later is another `install`. |
| `update` | Re-resolves the pins, regenerates, and applies the drift for the recorded selection. `-Check` reports the drift and writes nothing. |
| `remove` | Removes one runtime or one layer, such as `-Runtimes copilot` or `-Layers personal`, and nothing else. |
| `uninstall` | Removes everything `maxstack` wrote, and the lock. |
| `status` | Today's audit: reports each path as matching, missing, drifted, or modified by hand. |

Selection:

- `-Runtimes claude,copilot` picks runtimes by name. `all` picks every supported runtime. `-Layers` picks layers the same way.
- The selection is recorded in the workspace lock, so `update` and `status` reuse it.
- Every command shows the plan first and writes only with `-Apply`, as the installer does now.

Ownership is what makes removal safe:

- The lock records every path the installer wrote: a file's hash, or a link's target.
- For a merged JSON file such as Pi's `settings.json`, the lock records only the keys and entries the installer added. Removal takes those out and leaves every other key.
- `remove` and `uninstall` delete a file only when its hash still matches the lock. A file changed by hand is reported and skipped.
- They delete a directory only when the installer created it and it is empty.
- Nothing outside the workspace is read or written. Nothing is global. A removed runtime leaves no wrapper, link, or generated file behind.

The proof is a round trip. A test snapshots a workspace, runs `install` then `uninstall`, and requires the tree to match the snapshot. Another runs `install`, `remove` for one runtime, and `update`, and requires the other runtimes' files to stay byte-identical.

macOS needs the installer to stop assuming Windows. PowerShell 7 runs on macOS, but the installer uses junctions. On POSIX it uses symbolic links and sets the executable bit on the shell wrappers. CI runs the lifecycle tests on Windows and macOS.

## Layer sources (implemented)

Implemented on Windows. The commands and the lock record are in [install.md](install.md#layer-sources). Before this was built, `-LayerSource name=path` could override only a local layer and refused PStack, so a change on a fork branch could not be tried without editing `layers.json`.

Every layer, including PStack, names where it installs from.

A layer source is one of:

| Form | Example | Notes |
| --- | --- | --- |
| Git, by owner and repository | `simpsonm09/pstack-claude@feat/opencode-runtime` | Resolves to `https://github.com/<owner>/<repo>.git`. The ref may be a branch, a tag, or a full commit. |
| Git, by URL | `https://github.com/michael-denyer/pstack-claude.git@main` | The same, for any host. |
| Local | `local:D:\dev\simpsonm09\projects\repos\pstack-claude` | A working tree. It is never fetched, and uncommitted changes are installed as they are. |

The committed `layers.json` holds each layer's default source with a full commit pin, so a plain install is reproducible. An override changes the source for one run without editing `layers.json`:

- `-Source pstack=simpsonm09/pstack-claude@feat/opencode-runtime` or `-Source personal=local:<path>`, repeatable, for any layer.
- The override and the commit it resolved to are recorded in the lock, flagged as an override.
- `status` and `update` print every override and every unpinned or local source, so a workspace never runs from a test source unnoticed.
- `update` re-resolves a branch or tag to its current commit and records it. A local source has no commit to resolve. `update` re-reads it.
- Dropping the override returns the layer to its committed default on the next `install` or `update`.

Reading from a repository we do not own is allowed, because upstream PStack is a legitimate source. Opening a pull request there is not, and the ownership rule in the repo-standard skill still applies.

## Parity

The master template promises the same behavior in every runtime where that is possible and a written reason where it is not. [parity-matrix.md](parity-matrix.md) holds that record: one row per behavior, one column per runtime, each cell `same`, `differs`, `cannot`, `not built yet`, or `unverified`, with the evidence behind it. The generator is to assert the rows it can check automatically, and the rest need a live check by hand.

## Constraints that carry over

- Pi runs with no third-party extensions. The org gate and PStack's own Pi extension are the only extensions.
- Claude subscription credentials are not routed through Pi. Claude stays on Claude Code.
- Nothing in the workspace config is global. The deathpie workspace is untouched.
- The access gate decision lives only in `gate.mjs`. Each runtime adapter gathers inputs and applies the answer.

## Phases

| Phase | Scope | Proof |
| --- | --- | --- |
| 0 | Generation of skills and OpenCode MCP, built standalone; instruction composition and the installer wiring still to do. One PStack pin. The duplicate skill trees go. The lifecycle: runtime and layer selection, layer sources and overrides, the ownership record, `update`, `remove`, `uninstall`, and macOS support. | The generated output for the four installed runtimes matches today's installs, and the install and uninstall round trip leaves the tree unchanged on Windows and macOS. |
| 1 | Agents and hooks conversion for those four runtimes. | The gate denies the same commands as today in each runtime. |
| 2 | Codex: a `codex` runtime key, a `CODEX_HOME` wrapper, a gate adapter. | A denied command is blocked in a Codex session. |
| 3 | Cursor and Antigravity: stamping and workspace-root files. | A skill and the gate work in each, quota permitting. |
| 4 | A second workspace. | `mds368` installs from its own layer list. |

Built, standalone: the [layer generator](neutral-layer-generator.md) byte-copies each layer's skills and projects OpenCode MCP for the four installed runtimes, and it refuses nonempty MCP for the others. Its proof is byte equality with the three real layers and a temporary installer overlay. Not built: instruction composition, live runtime discovery, installer wiring, one PStack pin, physical deduplication, and the remaining lifecycle work.

## Open items

- Antigravity hooks and whether `.agents/` at the workspace root reaches an opened repository.
- Whether T3 can run a hook or stamp step when it creates a worktree.
- Whether moving `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, or `PI_CODING_AGENT_DIR` moves credentials too. Test each before relocating.
- Duplicate pins: one PStack commit sits in `layers.json`, `pstack.lock.json`, and `stack.lock.json`. Phase 0 reduces it to one.
