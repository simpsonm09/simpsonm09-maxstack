# Parity matrix: maxstack master template across 7 harnesses

This document states which AI behaviors are the same across the seven harnesses, which differ, and which cannot work. It is the reference for the master template plan in [master-template.md](master-template.md). It was first written on 2026-10-09 from a read of the repositories plus the live checks named in the evidence rules, so cells marked `unverified` are open work and not claims. Update a cell only with evidence, and change its status in the same commit.

## 1. Scope and method

Harnesses (columns): Claude Code, GitHub Copilot CLI (Copilot), OpenCode, Pi, Cursor, Codex, Antigravity.

Rows (behaviors): 18. Listed in section 2.

Cell statuses:

- `same`: the harness gives the behavior with the same contract as Claude Code, the reference harness.
- `differs: <how>`: the harness gives the behavior with a different contract. The text says how.
- `cannot: <why>`: the behavior cannot work on that harness with the mechanisms documented.
- `not built yet`: maxstack or pstack has no delivery for that harness today. Platform capability is not judged.
- `unverified`: no recorded run and no document settles it. Documentation alone does not make a cell verified.

Evidence rules:

- A verified claim names a document section that records a run, or a dated live probe recorded here (BRIEF-LIVE, LIVE-1020, or LIVE-1021).
- A design claim (what a document says will happen) is tagged as design. It is not a verified cell.
- Code reads are tagged as code. No run was made in this audit.

Pins:

- maxstack pins pstack at commit `671d84b7eb799c2c38ec39b11deac54a45d524fb` on branch `main` [MS-LAY]. The pstack-max worktree HEAD is the same commit [FORK].
- The `pstack-max` checkout at `pstack-max` is on `main` at the pinned commit `671d84b7eb799c2c38ec39b11deac54a45d524fb`. Where the pin and upstream `main` differ, the row says so (see G7).

Installed runtimes: the installer writes four runtimes by default (claude, opencode, copilot, pi) [MS-LAY, MS-INST]. Codex, Cursor, and Antigravity are opt-in. Codex installs skills and instructions only; its Launch argument selects the workspace project root, and its gate definition lives in owned `.codex/config.toml` (rows 2.1, 2.2, and 2.8). Cursor copies skills only into the explicit workspace root's `.cursor/skills`, and its gate definition lives in owned `.cursor/hooks.json` when a selected layer ships one. Antigravity shares the Codex skill projection under `.agents/skills`, and its gate definition lives in owned `.agents/hooks.json` when a selected layer ships one. Install at the active project root when a nested repository needs its own skill files.

Harness versions named in the sources: Copilot CLI 1.0.93 and 1.0.89 [ORG, PSC-MAP-CP]; OpenCode 2.0.24, 2.0.26, and 2.0.30 [MS-T3]; Pi 1.0 [PSC-PI].

Source key (short IDs used in cells):

| ID | Path, relative to the repository named first |
| --- | --- |
| MS-MT | simpsonm09-maxstack/docs/master-template.md |
| MS-T3 | simpsonm09-maxstack/docs/t3-setup.md |
| MS-INST | simpsonm09-maxstack/docs/install.md |
| MS-PUB | simpsonm09-maxstack/docs/plugin-publishing.md |
| MS-MCP | simpsonm09-maxstack/docs/mcp.md |
| MS-LAY | simpsonm09-maxstack/layers.json and pstack.lock.json |
| MS-CXG | simpsonm09-maxstack/scripts/codex-hook-status.mjs and docs/t3-setup.md (Codex (maxstack)) |
| PSC-PI | pstack-claude/docs/pi-equivalence.md |
| PSC-HK | pstack-claude/plugins/pstack/hooks/hooks.json (main) |
| PSC-CPH | pstack-claude/plugins/pstack/hooks/copilot-hooks.json (main) |
| PSC-CXH | pstack-claude/plugins/pstack/hooks/codex-hooks.json (main; same file on pstack-max) |
| PSC-PRE | pstack-claude/plugins/pstack/hooks/pre-tool-use.sh and pre-tool-use.awk (main) |
| PSC-RM | pstack-claude/plugins/pstack/README.md |
| PSC-MAP-CP | pstack-claude/plugins/pstack/skills/poteto-mode/references/copilot-tools.md (main) |
| PSC-MAP-CX | pstack-claude/plugins/pstack/skills/poteto-mode/references/codex-tools.md (main) |
| PSC-MAP-PI | pstack-claude/plugins/pstack/skills/poteto-mode/references/pi-tools.md (main) |
| FORK | pstack-max@main:plugins/pstack (branch main, pin) |
| FORK-CPH | FORK/hooks/copilot-hooks.json (bash and powershell command keys) |
| FORK-WIN | FORK/hooks/pre-tool-use-windows.ps1 |
| FORK-OC | FORK/opencode/ (index.ts, load.ts, routing.ts, agents/*.md) |
| FORK-MAP-OC | FORK/skills/poteto-mode/references/opencode-tools.md (fork only) |
| FORK-CXM | FORK/.codex-plugin/plugin.json |
| ORG | simpsonm09-org-ai-plugin/README.md |
| ORG-AGENTS | simpsonm09-org-ai-plugin/AGENTS.md |
| PER | simpsonm09-personal-ai-plugin/README.md |
| RS-AS | simpsonm09-repo-standard/docs/agents-and-skills.md |
| RS-AG | simpsonm09-repo-standard/docs/features/agent-access.md |
| BRIEF-LIVE | Live checks made against Pi 1.1.0 with a local mock model on 2026-10-09 (not a document in the repos): on Pi the gate blocks and rewrites via tool_call; denied commands are blocked in print, rpc and child agents; an unanswered confirm resolves false after 3 s in rpc; the wrapper sets AGENT_ACCESS_PI_ASK=allow. |
| LIVE-1020 | Live probe inside T3 on 2026-10-20: Claude, Codex, and Pi passed the same five checks described in LIVE-1021. Copilot was not run because of monthly quota; its earlier evidence remains separate. |
| LIVE-1021 | Live probe made inside T3 on 2026-10-21, Windows 11 (not a document in the repos): one turn per harness that lists skills, quotes the workspace instructions, runs an allowed `gh repo view`, runs `gh label create` on simpsonm09-org/simpsonm09-gate-probe-missing (a repository missing from the fleet catalog, which the gate must deny), and starts a subagent. OpenCode (the T3 OpenCode instance, opencode/deepseek-v4.1-flash-free): all five passed, with 107 skills visible and the write denied with the reason `agent-access: denied: the destination simpsonm09-org/simpsonm09-gate-probe-missing denies admin at level "none"`. Cursor (the T3 `cursorAcp` instance, Auto): not run, the free plan limit answered "Upgrade your plan to continue"; fed a documented `beforeShellExecution` payload by hand, the installed `.cursor/hooks.json` command answers `{"permission":"deny",...}` with the same reason. Antigravity (the T3 `antigravity` instance, gemini-3.8-flash-low, three sessions): skills visible come from the user-global `~/.gemini/config/skills`, not the workspace; no workspace instructions loaded; the gate hook never ran and the probe write reached GitHub (HTTP 404); the hook was loaded neither from workspace `.agents/hooks.json` nor from T3's per-provider Antigravity config folder `hooks.json`; fed by hand, the installed adapter denies correctly. |

This matrix does not maintain a skill count or a source-key denominator. The offline acceptance fixture records a bounded set of non-common keys and detects keys that lack a status. It does not inventory every key in the pinned source.

## Skill frontmatter projection and interpretation

The generator validates the skill name and description, rejects `model`, and copies source `SKILL.md` bytes unchanged. The five generator projections are covered by `scripts/skill-frontmatter-parity.test.mjs`. The Codex and Antigravity copies share `.agents/skills` and are covered by the named fixtures in `scripts/Install-Codex.test.mjs`. These checks prove maxstack's output bytes and paths. They do not prove that a harness reads or acts on a key.

| Harness | Skill path | Projection evidence |
| --- | --- | --- |
| Claude Code | `.claude/plugins/<layer>/skills/<skill>/SKILL.md` | `scripts/skill-frontmatter-parity.test.mjs` |
| Copilot CLI | `.claude/plugins/<layer>/skills/<skill>/SKILL.md` | `scripts/skill-frontmatter-parity.test.mjs` |
| OpenCode | `.opencode/skills/<skill>/SKILL.md` | `scripts/skill-frontmatter-parity.test.mjs` |
| Pi | `.pi/agent/skills/<skill>/SKILL.md` | `scripts/skill-frontmatter-parity.test.mjs` |
| Cursor | `.cursor/skills/<skill>/SKILL.md` | `scripts/skill-frontmatter-parity.test.mjs` |
| Codex | `.agents/skills/<skill>/SKILL.md` | `scripts/Install-Codex.test.mjs`, named Codex copy fixture |
| Antigravity | `.agents/skills/<skill>/SKILL.md` | `scripts/Install-Codex.test.mjs`, named Antigravity copy fixture |

The next table tracks interpretation separately from byte preservation. `unknown` means no evidence is recorded. `ignored` is used only where a cited harness check establishes that behavior.

| Non-common key | Claude | Copilot | OpenCode | Pi | Cursor | Codex | Antigravity | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `license` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | No harness interpretation evidence recorded. |
| `compatibility` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | No harness interpretation evidence recorded. |
| `metadata` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | No harness interpretation evidence recorded. |
| `allowed-tools` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | No harness interpretation evidence recorded. |
| `user-invocable: false` | unknown | unknown | unknown | ignored | unknown | unknown | unknown | Pi: PSC-PI S07a. No interpretation evidence recorded for the other harnesses. |
| `paths` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | No harness interpretation evidence recorded. |
| `future-key` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | Synthetic regression sentinel; no harness interpretation evidence recorded. |

The synthetic fixture lists its keys directly and fails with an actionable message if a key lacks a status entry. Its key list is test input, not a report of the pinned PStack inventory.

## 2. Matrix

Each cell is a status and a short reason, then the evidence IDs from section 1. Claude Code is the reference.

Summary grid (status only; the detail below holds the reason and evidence). Generated from the detail bullets and checked against them.

| Row | Claude | Copilot | OpenCode | Pi | Cursor | Codex | Antigravity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Skills load | same | differs | differs | differs | differs | differs | differs |
| AGENTS.md and CLAUDE.md instructions | differs | differs | differs | differs | differs | differs | differs |
| Plugin or package install path | same | differs | differs | differs | not built yet | not built yet | not built yet |
| Subagents | same | differs | differs | differs | differs | unverified | differs |
| Ask the user a question | same | differs | differs | differs | not built yet | differs | unverified |
| Scheduled wakeup and /loop | same | cannot | cannot | differs | not built yet | cannot | unverified |
| Session-start routing mandate | same | differs | differs | differs | not built yet | differs | cannot |
| Access gate denies the same commands | same | same | differs | same | differs | differs | cannot |
| Gate ask handling | differs | differs | differs | differs | differs | differs | cannot |
| pstack PreToolUse hooks | differs | cannot | cannot | not built yet | not built yet | not built yet | not built yet |
| MCP servers | not built yet | not built yet | differs | unverified | not built yet | not built yet | not built yet |
| Custom agent files and their format | same | differs | differs | differs | not built yet | not built yet | not built yet |
| Model selection and family names | same | differs | differs | differs | not built yet | differs | unverified |
| Transcripts location for reflect and recall | same | differs | differs | differs | not built yet | differs | unverified |
| Worktree creation | same | differs | differs | same | not built yet | differs | unverified |
| Works in headless or RPC mode | same | same | same | same | unverified | same | differs |
| Windows | same | differs | same | same | unverified | not built yet | differs |
| macOS | unverified | unverified | unverified | unverified | unverified | unverified | unverified |

Counts over 18 rows and 7 harnesses (126 cells): same 22, differs 58, cannot 8, not built yet 22, unverified 16.

The macOS row marks live harness behavior as unverified; it does not mean fixture coverage is absent. Hosted fixture coverage is recorded in rows 2.18-2.19.

### 2.1 Skills load (same SKILL.md; naming and prefix)

- Claude: **same**. Plugin skills load with a plugin prefix: `pstack:poteto-mode`, `simpsonm09-org-ai-plugin:repo-standard`. Evidence: MS-T3 (Claude Code table), RS-AS (Harnesses).
- Copilot: **differs**: same files, invoked by bare name through the `skill` tool. The user types `/pstack:<skill>`; a bare `/<skill>` reports unknown on CLI 1.0.89. The skill list in the prompt is cut by a character budget. How Copilot treats the `user-invocable` and `paths` keys is not recorded (G8d). Evidence: PSC-MAP-CP (Tool actions, Per-skill notes).
- OpenCode: **differs**: IDs are unprefixed (`poteto-mode`). The fork plugin registers `skills/` through `ctx.skill.transform`, so each skill and each `principle-*` loads by ID. A repo skill with the same ID collides (the prefix is what separates them on Claude). Verified by the live probe 2026-10-21: a T3 OpenCode session listed 107 skills, including `poteto-mode`, `repo-standard`, and `agent-vault`. Evidence: FORK-OC (index.ts, load.ts), FORK-MAP-OC (Tool actions), RS-AS (Skill rules), LIVE-1021.
- Pi: **differs**: bare names; `/skill:<name>` forces one. The `pstack:` prefix is dropped; only agent types keep it. `user-invocable: false` is ignored, so `principle-*` skills show in completion. Pi also loads `%USERPROFILE%\.agents\skills`. Evidence: PSC-PI (T11, T12, S07a), MS-T3 (Pi known limits, Verified).
- Cursor: **differs**: the opt-in `cursor` runtime copies each selected layer's skills into `.cursor/skills/<skill>`, with one lock record per folder. Cursor scans project skill folders recursively. When a nested repository is the active project, select that repository as `-Workspace`; maxstack does not assume parent workspace inheritance. Installer output and Node projection are covered by focused tests. The live probe 2026-10-21 did not run a Cursor turn: the free plan limit answered "Upgrade your plan to continue", so a live Cursor turn and T3 session remain unverified. Documented: [Cursor Agent Skills](https://cursor.com/docs/skills); T3 source: `CursorSkills.ts`.
- Codex: **differs**. The opt-in `codex` runtime copies each selected layer's skills into `.agents\skills\<name>`, a byte copy with one lock record per folder. Codex finds a skill by its folder name, and reads it from the project root down to the working directory. The project root is the git root by default, so the workspace skills reach a repository only when the T3 launch arguments name the marker `stack.lock.json`. Verified with codex-cli 0.162.1: `codex debug prompt-input` from a repository under a scratch workspace lists the three installed skills only with the marker. No login, no model call. The live probe 2026-10-20 passed the skills check inside T3 (LIVE-1020). The `.agents\skills` folder may also be read by other tools; this row does not claim that. Evidence: research-codex-surfaces.md (PROBE-1, PROBE-6, PROBE-15), CODEX-PROBE (this change, `codex debug prompt-input`), scripts/Install-Codex.ps1.
- Antigravity: **differs**: `-Runtimes antigravity` copies selected layer skills to `<workspace-root>/.agents/skills/<skill>/SKILL.md`, the documented workspace skill location for the Antigravity app, CLI, and IDE. It shares these folders with Codex. When a selected layer ships the Antigravity gate hook, the installer also writes an owned `.agents/hooks.json` that runs the adapter by absolute path. Antigravity rules, plugins, models, and global settings are not installed. Verified by the live probe 2026-10-21: in three T3 Antigravity sessions, the skills visible came from the user-global `~/.gemini/config/skills`, not the workspace; no session loaded the installed workspace skills. Evidence: [Antigravity skills](https://antigravity.google/docs/skills?tab=ide), LIVE-1021, features/antigravity.md.

### 2.2 AGENTS.md and CLAUDE.md instructions

- Claude: **differs**: maxstack writes a root `CLAUDE.md` import when Claude is selected and no root collision blocks it. The installer test verifies the generated import. Parent-folder loading is documented, not verified by a live run. Evidence: MS-INST (Workspace instructions), MS-T3 (Claude Code), PSC-MAP-CX (Instructions file).
- Copilot: **differs**: a repository session does not get the workspace file from its parent. The existing SessionStart context does not deliver this shared file. This gap is not verified by a live run. Evidence: MS-T3 (Copilot), PSC-MAP-CP (Instructions file).
- OpenCode: **differs**: maxstack adds a relative `instructions` entry for the generated workspace file. The installer test verifies the entry in normal and collision cases. Verified by the live probe 2026-10-21: the session quoted the workspace instructions. Evidence: MS-INST (Workspace instructions), MS-T3 (OpenCode), LIVE-1021.
- Pi: **differs**: reads `AGENTS.md` and `CLAUDE.md` from the session folder and parents. The installer test verifies generated files; parent-folder loading is documented, not verified by a live run. Evidence: PSC-PI (H05), MS-T3 (Pi), MS-INST (Workspace instructions).
- Cursor: **differs**: a repository session does not get the workspace file from its parent. This is not verified by a live run. Documented: [Cursor rules](https://cursor.com/docs/rules) and [Cursor CLI usage](https://docs.cursor.com/en/cli/using) (2026-10-13); live turn stopped by usage limit.
- Codex: **differs**. Codex reads `AGENTS.override.md` or `AGENTS.md` from the project root down to the working directory, capped at 32 KiB, and it does not read `CLAUDE.md`. With `project_root_markers = ["stack.lock.json"]` in the launch arguments, the probe read the generated workspace text from a nested repository. This is verified by a no-login `codex debug prompt-input` probe. Evidence: research-codex-surfaces.md (PROBE-1 to PROBE-6, DOC-1), CODEX-PROBE (this change).
- Antigravity: **differs**: a repository session does not get the workspace file from its parent. Verified by the live probe 2026-10-21: three T3 Antigravity sessions loaded no workspace instructions at all, with the session cwd in the workspace. Documented: [Antigravity rules](https://antigravity.google/docs/rules/) (2026-10-13); T3 driver cwd source. Evidence: LIVE-1021.

### 2.3 Plugin or package install path

- Claude: **same**. `--plugin-dir <workspace>\.claude\plugins`, one folder per plugin. Local layers are junctions to the OpenCode copy; pstack is a copy of its pinned folder. Verified: `--plugin-dir` loads each child folder, junctions included. Evidence: MS-T3 (Claude Code, Verified), MS-INST (Claude Code).
- Copilot: **differs**: the `copilot.cmd` wrapper passes one `--plugin-dir` per layer that lists copilot, in layer order, all pointing at `.claude\plugins`. T3 ignores commandArgs for registry ACP agents, so a wrapper is needed. Verified live through the `copilotSimpsonm09` instance. Evidence: MS-T3 (Copilot, Verified), MS-INST (Copilot CLI).
- OpenCode: **differs**: plugins are copied to `.opencode\plugins\<name>`. A nested entry (pstack's `opencode/index.ts`) is named in the `plugin` list of `opencode.jsonc`; a root `index.ts` is discovered. Verified: OpenCode 2.0.26 loads the nested pstack entry from an installed workspace. Evidence: MS-PUB (Entries OpenCode loads), MS-T3 (Verified).
- Pi: **differs**: packages go in the `packages` list of `.pi\agent\settings.json`; skills folders go in `skills`. The pstack package is the root of the pinned cache, `.claude\cache\pstack`. Verified: rpc lists the skills of the installed packages. Evidence: MS-T3 (Pi, What Pi loads, Verified), MS-PUB (`pi: {}`).
- Cursor: **not built yet**. Cursor skill folders are installed separately; Cursor plugin delivery is not built. Evidence: Cursor installer selection and the [skills guide](https://cursor.com/docs/skills).
- Codex: **not built yet** for the plugin. The opt-in `codex` runtime installs skills and instructions only. FORK-CXM (`.codex-plugin/plugin.json`) is not installed, and a Codex plugin install lives under `CODEX_HOME`, which maxstack does not write. Evidence: MS-T3 (Codex (maxstack)), MS-LAY, research-codex-surfaces.md (Plugins).
- Antigravity: **not built yet**. No installer support. Evidence: MS-MT (Runtimes).

### 2.4 Subagents (agent tool, parallel, worktree isolation)

- Claude: **same**. Native Agent tool; N calls in one turn run in parallel; `run_in_background`; `isolation: "worktree"`. Reference contract. Evidence: PSC-PI (T01, T04, T06 name the Claude mechanisms).
- Copilot: **differs**: the `task` tool takes `agent_type`, `model`, `mode` (`background` for background), and `reasoning_effort`. N `task` calls in one response run in parallel. No isolation parameter; writers get worktrees by `git worktree add` in the CLI, or by `create_session` in the app. Plugin agents load as `pstack:poteto-agent` and `pstack:comment-sicko`. Evidence: PSC-MAP-CP (Subagent policy, App and CLI).
- OpenCode: **differs**: the `subagent` tool takes an agent ID (`pstack-agent`, `pstack-reviewer`, `pstack-comment-sicko`), not a type. No per-call model. `background: true` for background. No SendMessage, list or stop equivalent is recorded ("No verified equivalent"). Worktrees are made by hand with `git worktree add`. Evidence: FORK-MAP-OC (Subagent policy, Tool actions).
- Pi: **differs**: the pstack extension supplies `agent`, `send_message`, `list_agents`, `stop_agent`, and background completion. Tests T01 to T09 are verified. Children load saved packages only, not the parent's `-e`. Claude's built-in `Explore` and `Plan` types do not exist. Evidence: PSC-PI (T01 to T09, T21), PSC-MAP-PI (Subagent policy).
- Cursor: **differs**: Cursor documents project and user subagents. maxstack has no agent delivery for Cursor, and T3 integration is unverified. Documented: [Cursor subagents](https://cursor.com/docs/subagents) (2026-10-13).
- Codex: **unverified**. The mapping is `spawn_agent`, `wait_agent`, `close_agent`; it needs `multi_agent = true` in `~/.codex/config.toml`; capacity errors stop spawning. No pstack agent types. Never run here. Evidence: PSC-MAP-CX (Tool actions, Subagent policy).
- Antigravity: **differs**: Antigravity documents workspace agents and subagents. maxstack has no agent delivery, and T3 integration is unverified. Documented: [Antigravity agents](https://antigravity.google/docs/cli/commands/agents/) (2026-10-13).

### 2.5 Ask the user a question

- Claude: **same**. `AskUserQuestion`. Reference. Evidence: PSC-MAP-CP (Tool actions, which names the Claude tool as the source).
- Copilot: **differs**: `ask_user` with a `choices` list, one question per call. Single-select only in the app; multi-select is emulated with sequential questions. Evidence: PSC-MAP-CP (Tool actions).
- OpenCode: **differs**: the `question` tool, when the client supports interactive questions; otherwise plain text. The tool name was not checked in a live session. Evidence: FORK-MAP-OC (header, Tool actions).
- Pi: **differs**: `ask_user_question`, same shape. In print or JSON mode, and in a child agent, it returns an error, so the model asks in plain text. Behavior in rpc with no answer is not recorded. Evidence: PSC-PI (T13), PSC-MAP-PI (Tool actions).
- Cursor: **not built yet**. No mapping. Evidence: MS-MT (Runtimes).
- Codex: **differs**: no structured question tool; the model asks in plain text. Evidence: PSC-MAP-CX (Tool actions).
- Antigravity: **unverified**. Nothing recorded. Evidence: none in the inputs.

### 2.6 Scheduled wakeup and /loop

- Claude: **same**. Native `ScheduleWakeup` and `loop`. Reference. Evidence: PSC-PI (T17, S03 name the Claude mechanisms).
- Copilot: **cannot**: the CLI has no wake-up tool and no loop skill; the step is re-run by hand. The app has `save_session_automation`. Evidence: PSC-MAP-CP (App and CLI, Driver and bundled skills).
- OpenCode: **cannot**: the mapping says "No equivalent. Re-check by hand." Evidence: FORK-MAP-OC (Tool actions).
- Pi: **differs**: `schedule_wakeup` and the `/loop` command are verified for a fixed interval and for self-paced use (S03, T17). In print or JSON mode, and in a child agent, scheduling returns an error because the process exits first. Evidence: PSC-PI (T17, S03), PSC-MAP-PI (Tool actions).
- Cursor: **not built yet**. Evidence: MS-MT (Runtimes).
- Codex: **cannot**: no wake-up tool or loop skill is mapped. A Codex scheduled task is the only alternative and is unverified. Evidence: PSC-MAP-CX (Driver and bundled skills).
- Antigravity: **unverified**. Nothing recorded. Evidence: none in the inputs.

### 2.7 Session-start routing mandate

- Claude: **same**. `SessionStart` (matcher `startup|resume|clear|compact`) runs `session-start.sh claude`. Reference. The pstack hook has no live run recorded; the org SessionStart hook was verified through the junction. Evidence: PSC-HK, MS-T3 (Verified).
- Copilot: **differs**: the `sessionStart` entry runs `session-start.sh copilot` on bash or `session-start-copilot.ps1` on PowerShell. The text names skills as `pstack:<skill>`; Copilot loads them by bare name. Verified live on Windows: SessionStart context reaches the session. Evidence: FORK-CPH, PSC-MAP-CP (Session routing hook), MS-T3 (Verified).
- OpenCode: **differs**: the plugin adds the routing text to every session through a `context` hook. It names the mapping file by absolute path; `routing: false` turns it off. The sheet is not loaded. No live run recorded. Evidence: FORK-OC (index.ts, routing.ts), FORK-MAP-OC (Session routing).
- Pi: **differs**: the extension adds the mandate and the sheet to the system prompt at every agent start, so it survives compaction. Child agents get the sheet but not the mandate. Verified in tests H01 and H04. Evidence: PSC-PI (H01, H04, X04), PSC-MAP-PI (Session routing).
- Cursor: **not built yet**. Evidence: MS-MT (Runtimes).
- Codex: **differs**: `SessionStart` only, in `codex-hooks.json`. It runs on startup, resume, clear and compact after the user trusts the hook through `/hooks`. Not run in this audit. Evidence: PSC-CXH, PSC-MAP-CX (Session routing hook).
- Antigravity: **cannot**: inside T3, Antigravity runs no hooks (live probe 2026-10-21, three sessions), so no session-start routing can be delivered. The hook was loaded neither from workspace `.agents/hooks.json` nor from T3's per-provider Antigravity config folder `hooks.json`. Evidence: MS-MT (artifact table, Hooks row), LIVE-1021.

### 2.8 Access gate denies the same commands (per adapter)

- Claude: **same**. `PreToolUse` on the Bash and PowerShell tools calls `decideShell` in gate.mjs; a deny exits 2. A PowerShell gh call is denied with a hint to use Bash. Verified: a Bash command naming the token launcher was denied through the junction. Parity is unit-tested against recorded HEAD outcomes. Evidence: ORG (The agent access gate; Differences from the previous gate), MS-T3 (Verified).
- Copilot: **same**. The same gate.mjs decides through `preToolUse` JSON (`permissionDecision: deny`). Verified live on Windows through the `copilotSimpsonm09` instance. Not measured live: the PowerShell rewrite form and the hook timeout. Evidence: ORG (GitHub Copilot CLI build, Known limits), MS-T3 (Verified).
- OpenCode: **differs**: the same decision, but the adapter rewrites a denied command in the `create.before` shell hook; it does not block the call. Verified by the live probe 2026-10-21: a T3 OpenCode session's `gh label create` on simpsonm09-org/simpsonm09-gate-probe-missing was denied with the rewrite `agent-access: denied: the destination simpsonm09-org/simpsonm09-gate-probe-missing denies admin at level "none"`. Parity is also checked against golden outcomes. Evidence: ORG (Repo facts, Differences), ORG-AGENTS (Repo facts), LIVE-1021.
- Pi: **same**. The `tool_call` handler blocks a denied bash call with the gate's reason. Verified live in print, rpc and child agents. The edit and write tools are not gated (see G10). Evidence: BRIEF-LIVE, ORG (Pi coding agent build, Known limits).
- Cursor: **differs**: the org layer's `hooks/cursor.mjs` answers `beforeShellExecution` from the same `decideShell`, mapping a deny to `permission: deny`. maxstack writes an owned `.cursor/hooks.json` whose command runs the adapter by absolute path, from the installed OpenCode copy when OpenCode is selected. The live probe 2026-10-21 did not run a Cursor session (the free plan limit). Fed the documented `beforeShellExecution` payload by hand, the installed hook command answers `{"permission":"deny",...}` with the gate's reason. A live Cursor session is still unverified. Evidence: ORG (The agent access gate), `scripts/Install-Workspace.hooks.test.mjs`, LIVE-1021.
- Codex: **differs**. The org layer's `hooks/lib/codex.mjs` reads the gate's answer from a `PreToolUse` hook for `Bash`, including unified exec. maxstack writes its definition to owned `.codex/config.toml`; Launch arguments contain only the fixed project-root marker. The user must trust the workspace and approve the hook once with `/hooks`. Status compares the current hook hash from `codex app-server` `hooks/list` with the lock, but cannot see approval state. By owner decision, the gate applies in every repository because Codex does not report a command's working folder. It is a guardrail: Codex skips an unapproved hook or one that cannot start or times out, and only the exit-0 JSON deny blocks on Windows. Hook trust discovery is verified with a temporary `CODEX_HOME`; the live probe 2026-10-20 passed the gate check inside T3 (LIVE-1020). Evidence: ORG (The agent access gate), MS-T3 (Codex (maxstack)), docs/t3-setup.md (The access gate line).
- Antigravity: **cannot**: inside T3, the gate hook never runs. The live probe 2026-10-21 (three sessions) sent a `gh label create` the fleet catalog denies, and the write reached GitHub (HTTP 404). The hook was loaded neither from workspace `.agents/hooks.json` nor from T3's per-provider Antigravity config folder. Fed the documented `PreToolUse` payload by hand, the installed `hooks/antigravity.mjs` answers `decision: deny` from the same `decideShell`. A standalone Antigravity app or CLI session in the workspace is untested. Evidence: ORG (The agent access gate), `scripts/Install-Workspace.hooks.test.mjs`, LIVE-1021.

### 2.9 Gate ask handling (prompt versus AGENT_ACCESS_*_ASK)

- Claude: **differs**: an `ask` (a gh write the level permits) prompts the person. The Bash tool gets a launcher rewrite; PowerShell gets a denial. No AGENT_ACCESS switch; the Claude path ignores one. Evidence: ORG (The agent access gate, GitHub Copilot CLI build).
- Copilot: **differs**: `ask` prompts unless the hook process has `AGENT_ACCESS_COPILOT_ASK=allow`. The `copilot.cmd` wrapper sets it, because ACP auto-denies an ask. A plain `copilot` keeps the prompt. Verified live through copilotSimpsonm09. Evidence: MS-T3 (The ask switch, Verified), ORG (GitHub Copilot CLI build).
- OpenCode: **differs**: no ask step in the adapter. An allowed gh command gets the App token at once, with no prompt. No switch exists. Evidence: ORG (Known limits: OpenCode gives these commands the App token without a prompt), RS-AG (Agent-side gates).
- Pi: **differs**: with `AGENT_ACCESS_PI_ASK=allow`, asks are rewritten with no prompt in rpc and no-UI sessions. A TUI session still prompts. In rpc an unanswered confirm resolves false after 3 s, which is why the wrapper sets the switch. Child asks are rewritten too. Verified: BRIEF-LIVE. Evidence: ORG (Pi coding agent build), MS-T3 (Pi).
- Cursor: **differs**: an allowed gh write is answered `permission: ask`, so Cursor asks the person. No `AGENT_ACCESS_*_ASK` switch exists for it. The live probe 2026-10-21 did not run a Cursor session (the free plan limit), and its hand-fed check covered a deny, not an ask. Evidence: ORG (The agent access gate), LIVE-1021.
- Codex: **differs**. The adapter converts a gate `ask` to a deny, because Codex PreToolUse cannot request human approval, and there is no allow-on-ask switch. Evidence: MS-CXG, ORG (The agent access gate).
- Antigravity: **cannot**: inside T3 the gate hook never runs (live probe 2026-10-21, three sessions), so no `ask` reaches the session. The adapter's `decision: ask` for an allowed gh write is known only from the adapter's code; no `AGENT_ACCESS_*_ASK` switch exists for it. Evidence: ORG (The agent access gate), LIVE-1021.

### 2.10 pstack PreToolUse hooks (file-read and subagent-model checks)

- Claude: **differs**: pstack has no PreToolUse hook on Claude. `hooks.json` has SessionStart only. The file-read approval and subagent-model deny exist only in the Copilot POSIX hook. Evidence: PSC-HK, PSC-PRE.
- Copilot: **cannot**: on Windows, `pre-tool-use-windows.ps1` is a stub that prints nothing and exits 0, so neither check runs. The POSIX `pre-tool-use.sh` implements both (approves plugin `view` and registered scripts; denies a `pstack:` task on an unsaved model), but it was not run on macOS. Evidence: FORK-WIN, PSC-PRE, PSC-MAP-CP (Plugin file access, Model names), MS-T3 (What works on Copilot).
- OpenCode: **cannot**: the plugin has no tool hook. The subagent-model check has nothing to check, because `subagent` takes no per-call model. Evidence: FORK-OC (index.ts), FORK-MAP-OC (Model names).
- Pi: **not built yet**. The extension has no file-read or subagent-model check. Aliases resolve through models.json only (T03). Evidence: PSC-PI (T03), PSC-MAP-PI (Model names).
- Cursor: **not built yet**. maxstack installs the org layer's gate hook, which covers shell commands only; the file-read approval and the subagent-model deny are not implemented for Cursor. Evidence: ORG (The agent access gate).
- Codex: **not built yet**. `codex-hooks.json` has SessionStart only. Evidence: PSC-CXH.
- Antigravity: **not built yet**. maxstack installs the org layer's gate hook, which covers shell commands only; the file-read approval and the subagent-model deny are not implemented for Antigravity. Evidence: ORG (The agent access gate).

### 2.11 MCP servers

- Claude: **not built yet**. maxstack writes no Claude MCP config, and no layer contributes a server. A neutral `mcp.json` is planned, not built. Evidence: MS-MCP (Default servers), MS-MT (Design item 1).
- Copilot: **not built yet**. No Copilot MCP writer. Evidence: MS-MCP, MS-MT.
- OpenCode: **differs**: the V2 shape `mcp.servers` with `disabled: true`, and no `enabled` field. The composed default set is empty. A per-project `opencode.json` turns a server on. Evidence: MS-MCP (intro, Turn one on per project).
- Pi: **unverified**. The mapping says MCP servers are listed with `pi mcp list`. maxstack writes no Pi MCP config and nothing was run. Evidence: PSC-PI (T18), PSC-MAP-PI (Tool actions).
- Cursor: **not built yet**. Cursor documents project and user MCP configuration, but maxstack has no Cursor MCP writer and T3 integration is unverified. Documented: [Cursor CLI usage](https://docs.cursor.com/en/cli/using) (2026-10-13); MS-MT (artifact table).
- Codex: **not built yet**. TOML conversion is planned, not built. Evidence: MS-MT (artifact table).
- Antigravity: **not built yet**. Antigravity documents workspace and user MCP configuration, but maxstack has no MCP writer and T3 integration is unverified. Documented: [Antigravity MCP](https://antigravity.google/docs/mcp) (2026-10-13); MS-MT (artifact table).

### 2.12 Custom agent files and their format

- Claude: **same**. `agents/poteto-agent.md` and `agents/comment-sicko.md` (frontmatter `name`, `description`); `effort-agents/effort-<level>.md` adds `effort:`. Reference. Evidence: FORK (agents/, effort-agents/), PSC-RM.
- Copilot: **differs**: the same markdown files are read as `task` agent types under `pstack:` names. Effort goes in `reasoning_effort`, so the `effort-*` types are not dispatched. Evidence: PSC-MAP-CP (Subagent policy).
- OpenCode: **differs**: profiles are `opencode/agents/pstack-agent.md`, `pstack-reviewer.md`, `pstack-comment-sicko.md`, with OpenCode frontmatter (`mode: subagent`, `permissions`). The installer copies them to `.opencode\agents` and strips any `model:` line. No effort agents. Evidence: FORK-OC (agents/), MS-INST (Ownership and status), MS-PUB (step 4).
- Pi: **differs**: the extension reads `agents/` and `effort-agents/` at run time. The body becomes the child's system prompt through `--append-system-prompt`; `effort:` becomes `--thinking`. No conversion step. Verified in tests A01, A02, A06. Evidence: PSC-PI (A01 to A06).
- Cursor: **not built yet**. Cursor documents Markdown subagent files, but maxstack has no agent delivery or conversion and T3 integration is unverified. Documented: [Cursor subagents](https://cursor.com/docs/subagents) (2026-10-13); MS-MT (Design item 2).
- Codex: **not built yet**. TOML conversion is planned. pstack has no Codex agent types; instructions go in `spawn_agent`. Evidence: MS-MT (Design item 2), PSC-MAP-CX (Subagent policy).
- Antigravity: **not built yet**. Antigravity documents workspace and user agents, but maxstack has no agent delivery and T3 integration is unverified. Documented: [Antigravity agents](https://antigravity.google/docs/cli/commands/agents/) (2026-10-13).

### 2.13 Model selection and family names

- Claude: **same**. The aliases `opus`, `fable`, `sonnet`, `haiku` are Claude's own. maxstack sets no model; the user picks one in the T3 picker. Evidence: MS-INST (Model), PSC-PI (X01a).
- Copilot: **differs**: family names do not resolve. Each role takes a model from `pstack-models.md`, passed as the `task` `model`. The list comes from the account's `task` model enum. The unsaved-model deny runs only on POSIX (see 2.10). Evidence: PSC-MAP-CP (Model names), FORK-WIN.
- OpenCode: **differs**: the installer strips `model:` lines and sets no model, so a subagent runs on the session model. The `subagent` tool has no per-call model. A `provider/model` line can be added to a profile by hand. The sheet does not reach OpenCode. Evidence: MS-INST (Model), FORK-MAP-OC (Model names), MS-PUB (step 4).
- Pi: **differs**: aliases resolve in the models.json column of the session's provider (`anthropic`, `openai`, `openai-codex`); a `pi models:` sheet line remaps any alias. Verified live only for the `openai` column on a ChatGPT sign-in. The `anthropic/*` and `openai-codex/*` IDs were never called live. Evidence: PSC-PI (X01a to X01c), PSC-MAP-PI (Model names).
- Cursor: **not built yet**. Evidence: MS-MT (Runtimes).
- Codex: **differs**: slugs such as `gpt-6-sol` are substituted by the user, and `/setup-pstack` writes the list. The slugs are not verified against Codex here. Evidence: PSC-MAP-CX (Model names).
- Antigravity: **unverified**. No model mapping recorded. Evidence: none in the inputs.

### 2.14 Transcripts location for reflect and recall

- Claude: **same**. `~/.claude/projects/<encoded-cwd>/`. Reference. Evidence: PSC-MAP-CP (Transcripts describes the Claude layout).
- Copilot: **differs**: `${COPILOT_HOME:-~/.copilot}/session-state/<id>/events.jsonl`, shared by all projects. Scope by the `cwd` in `workspace.yaml`. Evidence: PSC-MAP-CP (Transcripts).
- OpenCode: **differs**: no transcript directory is read. The mapping says export with `opencode session export` and do not read the database. The export command was not run. Evidence: FORK-MAP-OC (Tool actions).
- Pi: **differs**: `~/.pi/agent/sessions/--<cwd>--/` (or `$PI_CODING_AGENT_DIR`); follow `parentId` back from the last entry. The finder reads it and is verified (F01). Evidence: PSC-PI (F01), PSC-MAP-PI (Tool actions).
- Cursor: **not built yet**. Evidence: MS-MT (Runtimes).
- Codex: **differs**: the reflect finder reads only Claude's layout; `worktree-audit.mjs` scans `$CODEX_HOME/sessions`. Reflect on Codex needs a digest. Evidence: PSC-MAP-CX (reflect row, Vendored scripts).
- Antigravity: **unverified**. Nothing recorded. Evidence: none in the inputs.

### 2.15 Worktree creation

- Claude: **same**. Agent `isolation: "worktree"`. Reference. Evidence: PSC-PI (T06 mirrors the Claude rule).
- Copilot: **differs**: CLI, `git worktree add` per writer by hand; app, `create_session` per writer. Evidence: PSC-MAP-CP (App and CLI).
- OpenCode: **differs**: `git worktree add` through bash; the path is given in the prompt. Evidence: FORK-MAP-OC (Tool actions).
- Pi: **same**. The extension makes the worktree under `.claude/worktrees/` and keeps or removes it by the Claude rule: a change, an ignored file, or a commit keeps it. Verified in T06, including the reflog case. Evidence: PSC-PI (T06, F06).
- Cursor: **not built yet**. Evidence: MS-MT (Runtimes).
- Codex: **differs**: no isolation option in the mapping; each writing worker needs its own worktree by hand. Evidence: PSC-MAP-CX (Subagent policy).
- Antigravity: **unverified**. Nothing recorded. Evidence: none in the inputs.

### 2.16 Works in headless or RPC mode (T3-driven)

- Claude: **same**. The live probe 2026-10-20 inside T3 passed all five checks: skills, workspace instructions, an allowed read, a denied write, and a subagent reply. Evidence: LIVE-1020.
- Copilot: **same**. Verified live through the `copilotSimpsonm09` instance: SessionStart context, skills, and org gate. The PreToolUse stub from 2.10 still applies. Evidence: MS-T3 (Verified).
- OpenCode: **same**. Verified by the live probe 2026-10-21 through the T3 OpenCode instance (opencode/deepseek-v4.1-flash-free): the probe listed the skills, quoted the workspace instructions, ran an allowed `gh repo view`, was denied the `gh label create` write, and a subagent replied. Evidence: MS-T3 (OpenCode, Checks), MS-INST (Install and reload), LIVE-1021.
- Pi: **same**. The live probe 2026-10-20 inside T3 passed all five checks: skills, workspace instructions, an allowed read, a denied write, and a subagent reply. Evidence: LIVE-1020.
- Cursor: **unverified**. The T3 `cursorAcp` instance could not run the live probe 2026-10-21 because of the free plan limit. Evidence: LIVE-1021.
- Codex: **same**. The live probe 2026-10-20 inside T3 passed all five checks: skills, workspace instructions, an allowed read, a denied write, and a subagent reply. Evidence: LIVE-1020.
- Antigravity: **differs**. T3 runs Antigravity (the `antigravity` instance, gemini-3.8-flash-low); the live probe 2026-10-21 completed turns in three sessions, but they loaded no workspace skills, instructions, or gate. Use it as a read-only helper in `t3.readOnlyInstances`. Evidence: MS-T3 (Cursor and Antigravity), LIVE-1021.

### 2.17 Windows

The installer fixture lifecycle runs in the `test-node-shard` matrix and is required by `test-node`. It covers install, strict status, reapply, Copilot removal, and uninstall for the seven runtimes listed below; it does not verify live CLI or hook behavior.

- Claude: **same**. Junctions, `--plugin-dir` loading, and the Git Bash launcher were exercised on Windows. Evidence: MS-T3 (Verified), ORG (launcher).
- Copilot: **differs**: the wrapper, SessionStart and gate are verified live on Windows. The PowerShell rewrite is not measured live, and the PreToolUse checks are a stub (2.10). Evidence: MS-T3 (Verified), ORG (Known limits), FORK-WIN.
- OpenCode: **same**. OpenCode 2.0.24, 2.0.26, and 2.0.30 run from the Windows workspace. Caveats: `glob` with an absolute Windows path can return no matches, and OpenCode reads the user-level `%USERPROFILE%\.agents\skills` root (G6). Evidence: MS-T3 (OpenCode), FORK-MAP-OC (Tool actions).
- Pi: **same**. The `pi.cmd` wrapper and the rpc probe ran on Windows. Caveat: Pi also loads `%USERPROFILE%\.agents\skills` (G6). Evidence: MS-T3 (Pi, Verified).
- Cursor: **unverified**. The skills installer targets Windows, macOS, and Linux, but no live Cursor session was tested on Windows. Evidence: `scripts/Install-Cursor.ps1`, `scripts/Install-Workspace.cursor.test.mjs`.
- Codex: **not built yet**. `codex-hooks.json` has a `commandWindows` entry that was never run. Evidence: PSC-CXH.
- Antigravity: **differs**. The live probe 2026-10-21 ran three T3 sessions on Windows 11, but workspace skills, instructions, and the gate did not load. Standalone app and CLI behavior is untested. Evidence: LIVE-1021.

### 2.18 macOS

The `test-macos` CI job runs POSIX installer fixture lifecycles for all seven runtimes outside the required `test-node` aggregate. It is not configured with `continue-on-error`, so a failure makes the workflow run fail. These fixture checks do not verify live CLI or hook behavior.

- Claude: **unverified**. The fixture verifies the macOS installer lifecycle; real Mac CLI and hook behavior remain unverified. Evidence: `test-macos`, `scripts/Install-Workspace.macos.test.mjs`.
- Copilot: **unverified**. The fixture verifies executable `copilot.sh`, ordered plugin arguments, forwarding, status, and removal; real CLI and hook behavior remain unverified. Evidence: `test-macos`, `scripts/Install-Workspace.macos.test.mjs`.
- OpenCode: **unverified**. The fixture verifies copied plugin files and lifecycle; live OpenCode behavior is unverified. Evidence: `test-macos`, `scripts/Install-Workspace.macos.test.mjs`.
- Pi: **unverified**. The fixture verifies executable `pi.sh`, its agent directory and argument forwarding, plus lifecycle; live Pi behavior is unverified. Evidence: `test-macos`, `scripts/Install-Workspace.macos.test.mjs`.
- Cursor: **unverified**. The fixture verifies the `.cursor/skills` projection and lifecycle; live Cursor behavior is unverified. Evidence: `test-macos`, `scripts/Install-Workspace.macos.test.mjs`.
- Codex: **unverified**. The fixture verifies the `.agents/skills` projection and lifecycle; live Codex behavior is unverified. Evidence: `test-macos`, `scripts/Install-Workspace.macos.test.mjs`.
- Antigravity: **unverified**. The fixture verifies the shared `.agents/skills` projection and lifecycle; live Antigravity behavior is unverified. Evidence: `test-macos`, `scripts/Install-Workspace.macos.test.mjs`.

### 2.19 Linux

The `test-linux` CI job runs the same POSIX installer fixture lifecycle as macOS for all seven runtimes, outside the required `test-node` aggregate. It is not configured with `continue-on-error`, so a failure makes the workflow run fail. These fixture checks do not verify live CLI or hook behavior.

- Claude: **unverified**. The fixture verifies the Linux installer lifecycle; real Linux CLI and hook behavior remain unverified. Evidence: `test-linux`, `scripts/Install-Workspace.macos.test.mjs`.
- Copilot: **unverified**. The fixture verifies executable `copilot.sh`, ordered plugin arguments, forwarding, status, and removal; real CLI and hook behavior remain unverified. Evidence: `test-linux`, `scripts/Install-Workspace.macos.test.mjs`.
- OpenCode: **unverified**. The fixture verifies copied plugin files and lifecycle; live OpenCode behavior is unverified. Evidence: `test-linux`, `scripts/Install-Workspace.macos.test.mjs`.
- Pi: **unverified**. The fixture verifies executable `pi.sh`, its agent directory and argument forwarding, plus lifecycle; live Pi behavior is unverified. Evidence: `test-linux`, `scripts/Install-Workspace.macos.test.mjs`.
- Cursor: **unverified**. The fixture verifies the `.cursor/skills` projection and lifecycle; live Cursor behavior is unverified. Evidence: `test-linux`, `scripts/Install-Workspace.macos.test.mjs`.
- Codex: **unverified**. The fixture verifies the `.agents/skills` projection and lifecycle; live Codex behavior is unverified. Evidence: `test-linux`, `scripts/Install-Workspace.macos.test.mjs`.
- Antigravity: **unverified**. The fixture verifies the shared `.agents/skills` projection and lifecycle; live Antigravity behavior is unverified. Evidence: `test-linux`, `scripts/Install-Workspace.macos.test.mjs`.

## 3. Known intentional differences

Each item is a difference the docs call deliberate, or a limit the docs accept. Where the docs give no reason, the item says so.

1. Skill prefixes (rows 2.1, 2.12). Claude namespaces plugin skills; other harnesses have no namespace. The skill text names both forms where they differ (RS-AS, Harnesses and Skill rules). Reason: the namespace is Claude's own mechanism.
2. Copilot Windows PreToolUse is a stub (2.10). `pre-tool-use-windows.ps1` exits 0 on every path. Reason: Copilot denies a call whose hook exits non-zero, so the stub keeps the normal permission flow (FORK-WIN header). The cost is that the two checks do not run on Windows; that cost is a gap (G2), not a design.
3. OpenCode rewrites a denied command instead of blocking it (2.8). Reason not recorded in the inputs. The decisions match the golden outcomes (ORG, Differences).
4. OpenCode has no ask step (2.9). An allowed gh command gets the App token without a prompt. The docs state the behavior, not a reason: OpenCode gives these commands the token without a prompt (ORG, Known limits). The rationale is not recorded.
5. Ask switches change only an `ask`, never a denial (2.9). Reason: T3 talks to Copilot over ACP, which auto-denies an ask; the switch keeps the denial reason and the access level (MS-T3, The ask switch; ORG).
6. Pi TUI still prompts; only rpc and no-UI sessions are rewritten (2.9). Reason: the ORG text ties the prompt to a person at a TUI session. No further rationale is recorded.
7. The Claude path ignores AGENT_ACCESS_*_ASK (2.9). Reason not stated in the inputs. Inference: the Claude hook's prompt is answered by the person, and Claude Code does not auto-deny an ask the way ACP does (ORG; MS-T3, The ask switch).
8. Pi children load saved packages, not the parent's `-e` (2.4). Reason: a child is a fresh `pi --mode rpc` process; the installer uses saved settings so children get the gate (ORG, Child agents).
9. Pi child agents get the sheet but not the mandate (2.7). Reason: Claude Code subagents run no SessionStart hook either (PSC-MAP-PI, Session routing).
10. Pi refuses wake-ups in print and JSON mode and in child agents (2.6). Reason: Pi exits when the run ends, so a wake-up could never fire (PSC-MAP-PI, Tool actions).
11. No effort agent types on Copilot, OpenCode or Codex (2.12). Reason: Copilot passes `reasoning_effort`; OpenCode and Codex have no effort agents (PSC-MAP-CP, FORK-MAP-OC, PSC-MAP-CX).
12. OpenCode profiles are named `pstack-*` and carry no model line (2.12, 2.13). Reason: OpenCode takes the agent ID from the file name; the installer removes model lines so the user picks the model (FORK-MAP-OC, MS-INST, MS-PUB).
13. `pstack-agent` denies the `subagent` tool, and the two read-only profiles deny edits (2.4). Reason: prevents recursion and keeps reviewers read-only (FORK-OC agents/).
14. maxstack sets no model in any harness (2.13). Reason: the user picks in the harness, and the account decides what is reachable (MS-INST, Model; PSC-MAP-CP, Model names).
15. Copilot reads the sheet through the hook, not an include (2.2, 2.7). Reason: Copilot does not expand `@~/` includes (PSC-MAP-CP, Instructions file).
16. OpenCode has a `routing` option; Codex needs a trust step for hooks (2.7). Reasons: the plugin controls its own text (FORK-OC); Codex asks the user to trust a hook before it runs (PSC-MAP-CX, Session routing hook).
17. Transcript layouts differ by harness, and Copilot keeps all projects in one directory (2.14). Reason: each harness's storage design (PSC-MAP-CP, Transcripts).
18. The gate reads only the first command and does no segment analysis (2.8). Reason: ORG-AGENTS forbids adding segment analysis without an owner decision (ORG-AGENTS, Ground rules).
19. The gate is a guardrail, not a sandbox (2.8). Reason: stated in the repo-standard docs (RS-AS, What this does not do).
20. Org and personal layers contribute no MCP server (2.11). Reason: CLI-first design (MS-MCP, intro; ORG, MCP servers).
21. Repo-local agent profiles at `.opencode/agents/` are read by OpenCode only (2.12). Reason: they use OpenCode-only frontmatter (RS-AS, Repo-local files).

## 4. Gaps that need work (by impact)

Ranked by how much the plan's goals depend on the gap. Each gap names the evidence.

G1. The access gate is unproven in live Cursor and Antigravity sessions (rows 2.8, 2.9, 2.10). Codex has an adapter, an owned project hook definition, and a one-time trust step. Hook discovery and trust-state changes are measured with `hooks/list`; the live probe 2026-10-20 passed the gate check inside T3 (LIVE-1020). Cursor and Antigravity now have adapters and owned hook definitions: maxstack writes `.cursor/hooks.json` and `.agents/hooks.json` with the adapter's absolute path, and an install, status, change, removal, and uninstall are covered by `scripts/Install-Workspace.hooks.test.mjs`. No live session has run a denied command through either. Evidence: ORG (Contents), PSC-CXH, MS-MT (Phases), MS-CXG, scripts/Install-Workspace.hooks.test.mjs. Fix: record a blocked denied command in a Codex T3 session after hook approval, and run a denied command in a live Cursor and Antigravity session.

G2. Copilot PreToolUse is a no-op on Windows (row 2.10). The file-read approval and the subagent-model deny do not run on the machine this workspace uses. The POSIX port exists for bash only. Fix: port `pre-tool-use.awk` to PowerShell or Node and run the same fixtures on both. Evidence: FORK-WIN, PSC-PRE, MS-T3.

G3. Gate fail-open paths are unmeasured or silent. Claude: a hook killed at Claude Code's timeout is allowed; if `node` is not on the hook shell's PATH the call runs with no gate and no error. Copilot: the hook timeout behavior is not measured. Pi: the gate has no time budget of its own. Evidence: ORG (Known limits). Fix: measure the Copilot timeout; add a SessionStart check that `node` resolves; state the deny-on-timeout rule as a test.

G4. OpenCode passed the live probe 2026-10-21, and Pi passed the same probe on 2026-10-20. These checks cover skills, workspace instructions, an allowed read, a denied write, and a subagent reply. The ask-level check in section 5.2 remains open. Evidence: LIVE-1020, LIVE-1021.

G5. POSIX installer fixture lifecycles run in the macOS and Linux CI jobs for all seven runtimes (rows 2.18-2.19). Both jobs are outside the required `test-node` aggregate and have no `continue-on-error`, so a failure makes the workflow run fail. Branch protection requirements are not established by repository evidence. These fixtures do not establish live macOS CLI or hook behavior, which remains unverified and explicitly deferred. Evidence: `.github/workflows/ci.yml` (`test-macos`, `test-linux`), `justfile` (`test-macos`, `test-posix`), and `scripts/Install-Workspace.macos.test.mjs`.

G6. Pi and OpenCode resolve `%USERPROFILE%\.agents\skills` through default skill discovery, so the resolved skill set is not only the pinned one (rows 2.1, 2.17). The 2026-10-09 Pi spike found 40 skills. `PI_CODING_AGENT_DIR` does not isolate them, and redirecting `USERPROFILE` would move the login. An OpenCode 2.0.30 smoke found 41 skills there beside 61 PStack skills. The OpenCode config directory does not move that root, and the Claude Code skill flags do not gate it. Evidence: MS-T3 (Pi, Known limits; OpenCode, Global skills and clean sessions). Fix: test whether Pi's `skills` setting can exclude that path; the OpenCode root is an unresolved isolation limit, and accepting it as a risk is an owner decision.

G7. The Copilot hook files on pstack `main` do not match the contract the org README requires (row 2.8, 2.10). Main's `copilot-hooks.json` uses a single `command` key per entry and has no PowerShell entry. The fork (the pin) uses `bash` and `powershell` keys. If the pin moves back to main, the Copilot wiring changes shape; no install check recorded in MS-INST reads these hook keys, so the change would not show at install time. Evidence: PSC-CPH (main), FORK-CPH, ORG (GitHub Copilot CLI build). Fix: land the fork's hooks file upstream or pin only commits where the contract holds; add a test that reads the pinned file's keys.

G8. Stale or contradicting docs (several rows). (a) RS-AG says `gh.exe` and a full path to `gh` get no token. The org README "Differences from the previous gate" says they are now gated as `gh`. (b) ORG's Pi section says the rewrite of `event.input.command` and the `ui.confirm` signature are "not measured against a live Pi". BRIEF-LIVE says the rewrite works, and an unanswered confirm resolves false after 3 s. (c) MS-MT says all seven read AGENTS.md, and that Claude, Copilot and Cursor hooks fail open on timeout; Copilot's timeout is unmeasured, and Cursor and Antigravity are unverified. (d) The old MS-MT frontmatter rule claimed the generator strips or maps unsupported keys and called `user-invocable` and `paths` Claude-only. Source and byte-copy fixtures show that maxstack preserves metadata; harness interpretation remains unknown except for Pi's ignored `user-invocable: false` (PSC-PI S07a). Evidence: RS-AG (Known limits), ORG (Pi coding agent build), MS-MT (Research table; Hooks), PSC-PI (S07a, S07b), the frontmatter section above. Fix: correct each doc and keep projection tests separate from harness interpretation (G8d).

G9. Pi children do not inherit the parent's `-e` extension (rows 2.4, 2.8). A developer who tests with `-e` gets no gate in child agents. The install uses the saved `packages` list, so the installed path is safe. Evidence: ORG (Pi, Child agents), PSC-MAP-PI (Subagent policy). Fix: a test that fails when a child run lacks the gate.

G10. Pi's gate covers bash only. Edit and write are not gated, so an agent can change extension files. `pi -p` inside bash passes, because only the first word is read. Evidence: ORG (Pi, Known limits). Fix: decide whether edit and write to the org layer's files are denied by the gate; the gate's owner rule applies.

G11. OpenCode has no SendMessage, list or stop for subagents (row 2.4). A background subagent cannot be steered or stopped by the parent. Evidence: FORK-MAP-OC (Tool actions). Fix: confirm the OpenCode API; if none, document the limit in the pstack OpenCode mapping.

G12. Model paths are unverified (row 2.13). Pi's `anthropic` and `openai-codex` columns were never called live, and the anthropic column bills per token through Pi. Codex slugs are not verified. Family names do not resolve on Copilot or OpenCode. Evidence: PSC-PI (X01a to X01c), PSC-MAP-CX (Model names), PSC-MAP-PI (Model names). Fix: a live call per column before the table is relied on.

G13. Copilot edge cases (row 2.8, 2.9). A PowerShell gh call runs under Windows PowerShell 5.1, which passes a double quote inside single quotes wrong for a `.cmd` shim. `ask` in a cloud agent run is not measured. Evidence: ORG (Known limits, Copilot). Fix: test the PowerShell rewrite against the real `gh.exe`.

G14. No gate or wake-up path for T3-created worktrees (row 2.15). Whether T3 can run a hook or stamp step when it creates a worktree is open. Evidence: MS-MT (Open items). The gate covers worktrees through the git common directory (ORG), so the gap is in the stamp step, not in the gate.

G15. Repo-level reflect and recall do not read OpenCode or Codex sessions (row 2.14). Evidence: FORK-MAP-OC, PSC-MAP-CX. Fix: export or digest path for each.

G16. Duplicate pins (MS-MT Open items; MS-PUB step 2). The pstack commit sits in `layers.json`, `pstack.lock.json`, and `stack.lock.json`. A stale copy can drift silently. Evidence: MS-MT (Open items), MS-PUB (Publishing step 2). Fix: one pin, already planned for phase 0.

G17. Claude has no check for the sheet's subagent models (row 2.10). The Claude side enforces nothing; the model is whatever the caller sends. Evidence: PSC-HK. Fix: decide whether Claude needs the check; the Copilot check is the model.

G18. MCP delivery is missing for four harnesses (row 2.11). The composed set is empty, so nothing breaks today. The first layer that adds a server will need Claude, Copilot, Pi and Codex writers. Evidence: MS-MCP, MS-MT (artifact table). Fix: write the neutral `mcp.json` and the per-runtime writers when the first server lands.

G19. Repo-local subagents exist only on OpenCode (row 2.12). By design (RS-AS), but a repository that wants a subagent on Claude has no place for it. Evidence: RS-AS (Repo-local files). Fix: none now; record as a design limit.

## 5. Test strategy

The aim is that the matrix stays honest. Each `same` and each `verified` claim must be backed by an automated assertion or a dated manual record. The matrix should be generated from one data file, so a cell cannot change without a test change.

### 5.1 Rows the generator or CI can assert automatically

1. Matrix shape. Every row has all seven harness cells, each with one of the five status tokens, and each `differs` and `cannot` cell has text after the colon. Each cell cites at least one source ID, and every ID resolves to an existing file. This follows the pattern of `tests/pi-equivalence.test.mjs` in pstack.
2. Generated output. The markdown is generated from the data file. CI fails when the committed markdown differs from the generated text.
3. Pin agreement. `layers.json` and `pstack.lock.json` name the same commit (already in `scripts/verify-manifests.py`). Add: at the pinned commit, `hooks/copilot-hooks.json` has `bash` and `powershell` keys for each entry, and `.github/plugin/plugin.json` and `.codex-plugin/plugin.json` name hook files that exist (G7).
4. Stub detection. A test runs `pre-tool-use-windows.ps1` against a denied fixture and asserts the exit code and the empty output. A cell marked `same` for Copilot's Windows PreToolUse fails until a real port exists (G2).
5. Gate decisions across adapters. One fixture of commands by access level runs through the Claude adapter, the Copilot adapter, the OpenCode `gateShellEdit`, and the Pi adapter. Each must give the same capability decision and the same reason text. This extends the existing HEAD golden in `tests/parity.test.ts` to a cross-adapter table (rows 2.8).
6. Ask switch exactness. Each adapter treats `AGENT_ACCESS_*_ASK` as an ask rewrite only when the value is exactly `allow`. Test `Allow`, `1`, `true`, the empty string, and an unset variable. Test that a denial stays a denial with the switch set. Test that a Pi child inherits the variable and still denies (rows 2.9).
7. Fail-closed hook behavior. Simulate a missing `node` and a timeout; assert the Claude hook denies a write. Today the Claude path allows the call when `node` is missing (G3); the test fails until that changes.
8. Skill frontmatter. Generator and Codex fixtures assert byte preservation at the seven projection paths. The offline synthetic test requires every non-common fixture key to have an explicit interpretation status and evidence note. Keep unknown harness behavior marked `unknown`; do not infer support from copied bytes (G8d).
9. Session routing text. The mandate text names skills as `pstack:<skill>` for Claude, and the Copilot, OpenCode and Pi renderers name them in their own form. Assert the rendered text contains each harness's skill form and no other (rows 2.1, 2.7).
10. Agent profiles. Installed OpenCode profiles contain no `model:` line, and the workspace config has no `model` or `small_model` key. `verify-manifests.py` covers the config half; add the profile half to the workspace verifier (rows 2.12, 2.13).
11. MCP empty set. The composed `mcp.servers` is empty for every layer, and no `.mcp.json` or Copilot MCP file exists in the workspace. This fails the day a layer adds a server without a writer (G18).
12. Transcript readers. Fixture sessions for Claude (`projects/<encoded-cwd>`), Copilot (`events.jsonl` with `workspace.yaml`), and Pi (a tree with `parentId`, two branches). Assert each reader returns the same opening prompt for the same conversation (row 2.14). `find-transcript.mjs` already has a Pi case.
13. Installer lifecycle. Install then uninstall on a snapshot returns the same tree. Remove one runtime leaves the other runtimes byte-identical. Windows coverage runs in the required node test aggregate (row 2.17); the existing POSIX fixture lifecycle runs in `test-macos`, outside that aggregate (row 2.18; G5).
14. Model tables. models.json has the four family names for each provider column. `tests/pi/catalog.test.mjs` already checks the installed Pi catalog; extend the check to every column (row 2.13).
15. Live-evidence rule. A cell may move from `unverified` to `same` only with a dated record file in the repo: harness version, instance ID, command, observed result. The generator reads those records. Rows 2.16 and 2.17 cannot be `same` without one.
16. Docs drift. A lint over the docs flags the phrases "get no token" for `gh.exe` and "not measured against a live Pi" against the classifier's actual output and the verified-facts file (G8a, G8b).

### 5.2 Rows that need a manual live check

These need a real harness, a real model, or a real machine. Each run is recorded with the rule in 5.1.15.

1. T3 turn per installed instance: `claudeSimpsonm09`, `copilotSimpsonm09`, the OpenCode provider, and `piSimpsonm09`. One turn each that (a) lists pstack skills, (b) runs an allowed gh read, (c) runs a denied gh write, (d) runs a gh write at the `ask` level, and (e) starts one background subagent. Rows 2.1, 2.4, 2.8, 2.9, 2.16. This covers G4.
2. Copilot on Windows: a PowerShell gh call through the rewrite; a hook timeout (kill the hook past its timeout and observe); an `ask` with `AGENT_ACCESS_COPILOT_ASK` unset and set to `allow` in ACP. Rows 2.8, 2.9, 2.10 (G2, G3, G13).
3. Pi: a TUI `ask` prompt answered yes and no; an rpc `ask_user_question` with no answer; `schedule_wakeup` inside a T3 session; a child agent loaded through `-e` versus saved packages. Rows 2.4, 2.6, 2.8, 2.9 (G9).
4. OpenCode: the text the agent sees for a rewritten denied command; `routing: false` removing the mandate; a background `subagent` finishing with its report; the `question` tool name in a live session. Rows 2.5, 2.7, 2.8, 2.4 (G4, G11).
5. Codex: a T3 turn after the user trusts the workspace and approves the hook through `/hooks`, with one allowed shell command and one denied `gh` write, to show the deny blocks and no marker is written; the SessionStart output; a repo with AGENTS.md at the root and a parent folder with one. Rows 2.2, 2.7, 2.8, 2.16. The hook's hash and trust-state behavior are checked with `hooks/list` and a temporary `CODEX_HOME` (MS-CXG); the live deny is not.
6. Cursor: a scratch repo under a workspace folder with AGENTS.md above it; the rules location; any hook. Rows 2.1, 2.2, 2.8.
7. Antigravity: `.agents/` at the workspace root, opened against a repo inside it; whether AGENTS.md is read; hooks. Rows 2.1, 2.2, 2.7, 2.8.
8. macOS live behavior: run `copilot.sh` and `pi.sh` with the real CLIs and exercise their hooks. The hosted `test-macos` job already covers POSIX installer fixtures for all seven runtimes; those fixtures do not verify live CLI or hook behavior. Rows 2.17, 2.18.
9. Model names: diff `pi --list-models` against models.json; read Copilot's `task` model enum against the sheet; check Codex slugs on a ChatGPT account. Row 2.13 (G12).
10. Cost: one `anthropic/*` call through Pi to confirm the per-token billing warning and the extra-usage line the mapping describes (row 2.13, G12).
