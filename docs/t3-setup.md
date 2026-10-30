# T3 setup

T3 can run OpenCode, Claude Code, the Copilot CLI, and Pi against the same workspace, and Codex receives the workspace's skills and instructions through its own instance. The four plugin harnesses find the plugin layers differently, so each needs its own setup.

## T3 instances

T3 keeps its provider instances in `%USERPROFILE%\.t3\userdata\settings.json`. T3 reloads that file while it runs, so an edit needs no restart.

The model picker and provider instance are separate choices. The picker selects a model; the instance supplies the provider command, arguments, and environment. The workspace installer does not create or remove T3 instances. Configure maxstack instances in T3 as described below, and manage them there.

For delegated work, the selected parent instance does not override an explicit provider target. Choose the maxstack instance for the parent and its delegates when you want the workspace layers. If a delegate explicitly targets a plain provider instance, that instance does not receive maxstack's instance arguments, even when the parent uses maxstack. If a delegate omits the provider target, it inherits according to the delegation contract. Model choice remains separate from provider choice.

A fresh thread clears conversation history. It still starts with the normal harness configuration and instructions. A plain provider instance omits the maxstack instance arguments or wrapper documented below, but that does not guarantee a clean session. Starting outside the workspace reduces workspace-specific instructions and skills. Global provider settings and instructions may still apply. OpenCode keeps a global compatibility skill root under the user's home directory that survives leaving the workspace; see [Global skills and clean sessions](#global-skills-and-clean-sessions). A fully isolated session needs a separate profile and global configuration, then validation; maxstack does not provide or verify an automatic clean mode.

Startup behavior depends on the runtime. Follow the runtime's discovery notes below. In particular, maxstack's Codex launch argument sets `stack.lock.json` as a project-root marker so Codex can discover workspace files from nested repositories. That setting does not prove that a plain Codex session is isolated or never loads `AGENTS.md`.

T3 reloads instance settings while it runs. A new agent session also starts with fresh conversation history. A reused OpenCode server may need a restart to load plugin changes; see the runtime instructions. These are separate actions.

| Current instance ID | Display label | Provider | Points at | Use |
| --- | --- | --- | --- | --- |
| `codex` | Codex | Codex | default launch configuration | Plain Codex |
| `codex_maxstack` | maxstack | Codex | workspace launch configuration described below | Codex with workspace skills |
| `claudeAgent` | Claude | Claude | no plugin folder | Plain Claude Code |
| `claudeSimpsonm09` | maxstack | Claude | launch args `--plugin-dir <workspace>\.claude\plugins` | Claude Code with the workspace plugins (legacy ID) |
| `copilot` | Copilot | Copilot | the registry `copilot.exe` | Plain Copilot CLI |
| `copilotSimpsonm09` | maxstack | Copilot | `commandPath` `<workspace>/.maxstack/bin/copilot.cmd` (macOS: `copilot.sh`) | Copilot CLI with the workspace plugins (legacy ID) |
| `pi` | Pi | Pi | disabled | Plain Pi |
| `piSimpsonm09` | maxstack | Pi | `binaryPath` `<workspace>/.maxstack/bin/pi.cmd` | Pi with the workspace packages and skills (legacy ID) |

The maxstack instances apply only to the workspace named in their paths. The default instances need no folder and no wrapper.

## Canonical provider IDs

Use these exact provider instance IDs for new maxstack instances. The human-readable label stays `maxstack` for every runtime. T3 can show repeated labels because the provider icon distinguishes the harness. Automation and project defaults select the exact instance ID, not its label.

| Harness | Canonical instance ID | Display label | Driver | Launch configuration |
| --- | --- | --- | --- | --- |
| Codex | `codex_maxstack` | `maxstack` | `codex` | Binary path and launch arguments from the Codex setup below |
| Claude Code | `claude_maxstack` | `maxstack` | `claudeAgent` | `--plugin-dir <workspace>/.claude/plugins` |
| Copilot CLI | `copilot_maxstack` | `maxstack` | `acpRegistry` | `commandPath` `<workspace>/.maxstack/bin/copilot.cmd` on Windows or `.sh` on macOS |
| Pi | `pi_maxstack` | `maxstack` | `pi` | `binaryPath` `<workspace>/.maxstack/bin/pi.cmd`; empty `launchArgs` |

The driver chooses how T3 starts a provider. Keep these driver IDs unchanged when you create the canonical provider IDs. The instance ID names the provider choice used by threads, sessions, events, bindings, and project defaults. The model picker selects a model independently. Selecting a provider instance supplies its launch configuration; selecting a model does not change that configuration.

Use `orchestrator_capabilities` to discover provider IDs and model IDs in the shared live provider/model catalog exposed to the composer and delegation. Confirm each canonical provider ID and the model you plan to use there. Provider IDs are user-defined routing keys. Existing threads, sessions, events, and bindings can refer to them. T3 has no verified rename operation for these IDs.

### Migrate project defaults safely

The canonical IDs are the target contract. They are not all present in the current T3 settings. `codex_maxstack` exists. Create and verify `claude_maxstack`, `copilot_maxstack`, and `pi_maxstack` in T3 before changing any project default.

1. Create or configure each canonical instance with the launch configuration in this guide, if the T3 settings UI for that driver supports the exact custom ID. Confirm the exact ID and the model you plan to use in `orchestrator_capabilities`, then verify that the instance starts the expected harness configuration.
2. Keep `claudeSimpsonm09`, `copilotSimpsonm09`, and `piSimpsonm09` available while you verify the new instances. Existing threads can still depend on those legacy IDs.
3. Update project defaults only after the matching canonical instance is verified. Preserve each project's selected model.
4. Keep the legacy instances for existing threads and bindings. Do not rewrite historical records.
5. To roll back a project, restore its previous default ID. Keep the canonical instances available until their threads and bindings no longer need them.

No provider-settings write API is exposed here. The T3 settings UI supports custom IDs for ACP instances. The UI's ability to create exact custom IDs for other drivers is unknown. If it does not support the canonical ID for a driver, keep that ID as a target and do not migrate that project's default. Do not edit a settings file as a substitute for a verified UI flow.

## T3 model sheet and instance lists

`t3.gatedInstances` lists ids allowed to receive delegated work with this workspace's layers and gate. `t3.readOnlyInstances` lists cheap helpers for reviews, research, and explanation on harnesses without our layers or gate. pstack refuses read-only instances for roles whose helpers can write files, commit, push, or open pull requests. These lists are per machine. maxstack writes both lists beside the model sheet under `.pstack`. Run `setup-pstack` inside T3 to write the model sheet there.

## OpenCode

Nothing to configure. OpenCode walks up from the session directory to the filesystem root and merges each `opencode.jsonc` and `.opencode` it finds. The workspace `opencode.jsonc` and `.opencode` apply to repositories and git worktrees under that workspace.

The installer lists the PStack entry in the workspace `opencode.jsonc`, as `./.opencode/plugins/pstack/opencode`. That path is relative to the config. OpenCode 2.0.30 loads the plugin list from both the documented `plugins` key and the deprecated `plugin` key, so the key the installer writes stays valid; renaming it is optional and not a bug fix. The `permissions` entries allow OpenCode's `external_directory` and `read` actions under the workspace's `.opencode` directory; the installer fills in the current Windows workspace path and its corresponding WSL path. OpenCode v2 documents this `permissions` array shape and its external-directory behavior in the [v2 permission reference](https://dev.opencode.ai/v2/docs/permissions/).

When a selected layer declares workspace instructions, the config also names `./AGENTS.md` or `./.maxstack/workspace-instructions.md` in its `instructions` list. The path is relative to `opencode.jsonc`, so it works from the Windows and WSL views. OpenCode stops walking up at a repository root, so maxstack writes this explicit entry for nested repositories. The [OpenCode v2 instructions page](https://dev.opencode.ai/v2/docs/instructions/) says v2 accepts this config field but does not currently resolve its files. Installer tests verify the entry, but loading the file into an OpenCode session is not verified.

### Models

OpenCode uses the providers you have connected in OpenCode itself, with `opencode auth` and its global config under your user profile. maxstack sets no model and no provider, and the workspace `opencode.jsonc` holds neither a `model` nor a `providers` entry. Pick a model in the T3 model picker. While an OpenCode Console OAuth login is stored, OpenCode lists only its own `opencode` and `opencode-go` providers and hides third-party providers, even when their keys are configured; connecting a provider with its own API key instead lets both appear (measured on OpenCode 2.0.27).

### Global skills and clean sessions

OpenCode reads global compatibility skill folders from the user's home directory. `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` move the config directory, and the XDG variables move the data, cache, and state directories, but the home directory stays the user's profile, so OpenCode 2.0.30 includes `%USERPROFILE%\.agents\skills` in default skill discovery, including outside the workspace. An OpenCode 2.0.30 smoke resolved 61 PStack skills, 41 skills from that folder, and two built-in skills: 104 entries with no duplicate IDs.

No documented setting or environment variable disables the global roots. `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` gate the `.claude` roots only. They are Claude Code switches, not a general external-skills switch, and they do not stop `%USERPROFILE%\.agents\skills`. The `skills` config key is additive, so it adds paths rather than replacing the built-in roots. A `permissions` entry with action `skill` and effect `deny` hides matching skills from the model and rejects loading them, but it does not unregister them, and denying every skill also hides the PStack skills.

`OPENCODE_TEST_HOME` redirects the home directory OpenCode uses without repurposing the real login, but it is test scaffolding, not documented product behavior. Do not treat it as a supported clean mode. A fully isolated OpenCode session needs a separate profile and global configuration that the product documents, then validation; maxstack does not provide or verify one.

### Server credentials

OpenCode keeps one private service credential across server restarts, so a discovered client reconnects without a password flag or an environment variable. A restart replays the stored credential and does not rotate it. Rotation is a separate documented action, `opencode service set password "<new>"`, which stops the daemon. The next start uses the new value, and paired browser sessions are signed out. Normal T3 clients do not need the credential, because discovery and `opencode api` authenticate on their own. The daemon binds `127.0.0.1` by default, so the credential stays local unless remote access is enabled. The `OPENCODE_SERVER_PASSWORD` environment variable applies to the foreground `opencode serve` and `opencode web` paths only. It does not change the daemon credential.

## Claude Code

Claude Code does not walk up for plugins. The installer therefore builds one folder of Claude plugins at the workspace root, `<workspace>\.claude\plugins`. Each child folder is one plugin. The `claudeSimpsonm09` instance points at that folder:

1. Generate the folder: `pwsh -File scripts/Install-Workspace.ps1 -Apply`.
2. Create or configure `claude_maxstack` in T3, if its settings UI supports that exact ID. Set its label to `maxstack` and its launch arguments to `--plugin-dir <workspace>\.claude\plugins`. Keep `claudeSimpsonm09` available until you verify the canonical instance.
3. After verifying the instance, set the fleet project's default provider ID to `claude_maxstack`. Keep the model selection unchanged.

Plain `claude` outside T3 takes the same flag, so `claude --plugin-dir <workspace>\.claude\plugins` gives the same plugins.

Claude Code reads `CLAUDE.md` from the session folder and its parent folders. When instructions are generated, maxstack writes a root `CLAUDE.md` that imports `AGENTS.md`. If a user root instruction file blocks generation, maxstack keeps it and writes the shared text under `.maxstack` instead.

The alternative is an instance environment entry, `CLAUDE_CODE_PLUGIN_DIRS`, with the child folders listed and separated by `;`. The installer does not generate that list; it is the same folders as the `--plugin-dir` route.

| Plugin | Folder | Source | Skills appear as |
| --- | --- | --- | --- |
| `pstack` | `.claude\plugins\pstack` | a copy of `plugins/pstack` from pstack-max, our fork of pstack-claude, at the commit in `pstack.lock.json` | `pstack:poteto-mode`, and the other `pstack:*` skills |
| `simpsonm09-org-ai-plugin` | `.claude\plugins\simpsonm09-org-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-org-ai-plugin` | `simpsonm09-org-ai-plugin:repo-standard`, and the other `simpsonm09-org-ai-plugin:*` skills |
| `simpsonm09-personal-ai-plugin` | `.claude\plugins\simpsonm09-personal-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-personal-ai-plugin` | `simpsonm09-personal-ai-plugin:dev-tools`, and the other `simpsonm09-personal-ai-plugin:*` skills |

The local folders are junctions to the installed OpenCode copies, so there is still one installed copy for both harnesses. One `Install-Workspace.ps1 -Apply` updates both. A junction needs no administrator rights. Each plugin's hooks run only in sessions that load it, and they resolve their files through the junction.

The pstack folder is a copy, not a junction. It is not a junction because the OpenCode copy holds only `opencode/` and `skills/`, and the Claude plugin needs the whole folder. The installer fetches the fork into `.claude\cache\pstack`, sparse to `plugins/pstack`, and checks out the pinned commit. The cache is reused offline once it holds the commit.

## Copilot

The Copilot provider does not take plugin folders from the instance's arguments. T3 ignores `commandArgs` for registry ACP agents. So the installer writes `.maxstack\bin\copilot.cmd` and `.maxstack\bin\copilot.sh` on Windows, and `.maxstack/bin/copilot.sh` on macOS and Linux. The `copilotSimpsonm09` instance starts the wrapper instead of `copilot`. The default `copilot` instance starts the registry `copilot.exe` on Windows and needs no wrapper.

1. Generate the wrapper: `pwsh -File scripts/Install-Workspace.ps1 -Apply`. It needs the Copilot CLI installed. If Copilot is not on `PATH`, the installer keeps the wrappers it already wrote, as they are, and warns; with none recorded, it skips them and says so. Install Copilot, then run it again.
2. Create or configure `copilot_maxstack` in T3, if its settings UI supports that exact ID. Set its label to `maxstack` and `config.commandPath` to `<workspace>/.maxstack/bin/copilot.cmd` on Windows or `<workspace>/.maxstack/bin/copilot.sh` on macOS. Keep `copilotSimpsonm09` available until you verify the canonical instance.
3. After verifying the instance, set the fleet project's default provider ID to `copilot_maxstack`. Keep the model selection unchanged.

The wrapper runs the Copilot CLI with one `--plugin-dir` for each layer that lists `copilot`, in layer order: pstack, then the org layer, then the personal layer. Each folder is the same `.claude\plugins` folder Claude Code uses. The wrapper then passes its own arguments through. Windows `copilot.cmd` records the executable's absolute path; macOS and Linux `copilot.sh` resolve `copilot` from `PATH` when launched.

### The ask switch

The wrapper sets `AGENT_ACCESS_COPILOT_ASK=allow` before it starts Copilot. This is needed because of how T3 handles approval.

The org gate answers a GitHub write that the access level permits with `ask`. Copilot then asks for approval. T3 talks to Copilot over ACP, and ACP auto-denies an `ask`, so without the variable the write would be denied. With the variable set to `allow`, the Copilot adapter turns that `ask` into `allow`. The denial reason and the rewrite stay the same.

The switch changes only that `ask`. Denials still apply, and the repository access level still applies. A call the gate denies is still denied.

A plain interactive `copilot` does not set the variable, so it keeps the prompt. The wrapper sets the variable only in its own process. Your shell and other programs do not see it.

The variable is set in the wrapper, not in the T3 instance, so other Copilot runs are not affected.

### What works on Copilot

On Windows, pstack's PreToolUse hook is a no-op stub under Copilot, so its file-read and subagent-model checks do not run there. The SessionStart context, the skills, and the org gate work on Copilot. When selected layers declare workspace instructions, the generated Copilot wrappers append an installer-owned `.maxstack/copilot-instructions` directory to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`; that directory contains a projected `AGENTS.md`, intended to let Copilot discover the selected-layer instructions from a nested repository. The wrappers preserve any existing comma-separated directory list, and planning refuses a projected instruction path containing a comma because the CLI variable has no escaping syntax, or an exclamation mark because cmd delayed expansion can remove it. Validation occurs before installer writes, even when Copilot is not installed. Hosted macOS CI checks wrapper generation and the no-login installer lifecycle. Offline fixtures verify environment and file projection only; the owner still needs to run the installer on the work Mac, start a fresh session through `copilot.sh`, sign in, and confirm that the T3 ACP provider launches the wrapper and Copilot loads the projected instructions. Actual T3 environment inheritance and live instruction consumption remain unverified. See [current delivery state](features/current-alignment.md).

## Pi (maxstack)

T3's native Pi provider runs `<binaryPath> --mode rpc <launchArgs>`. The installer writes a wrapper, `.maxstack\bin\pi.cmd`, and Pi's settings, `.pi\agent\settings.json`. The wrapper sets the agent folder to `.pi\agent`, so Pi loads the workspace layers and keeps its own login there. The `piSimpsonm09` instance starts the wrapper.

1. Install the Pi CLI, `@earendil-works/pi-coding-agent`, into `<workspace>/.maxstack/npm` so its executable lands in `.maxstack/npm/node_modules/.bin`, or make it available on `PATH`. The installer looks in the workspace first. Then generate the wrapper and settings with `pwsh -File scripts/Install-Workspace.ps1 -Apply`. The installer writes the absolute path of the Pi it finds into `pi.cmd`. If Pi is missing, the final summary reports the skipped wrappers; install Pi and rerun with `-PiCommand <path>`.
2. Sign in once, yourself. Run `<workspace>/.maxstack/bin/pi.cmd`, enter `/login` in Pi, and sign in to a provider. The login is written under `.pi/agent`, the folder T3's instance uses. Keep `.pi/agent/auth.json` out of git, and never paste it into a doc or a chat. An agent never logs in for you.
3. Create or configure `pi_maxstack` in T3, if its settings UI supports that exact ID. Set its label to `maxstack`, its driver to `pi`, `binaryPath` to `<workspace>/.maxstack/bin/pi.cmd`, and `launchArgs` to empty. Leave `customModels` empty and pick the model in T3's picker. maxstack sets no Pi model or provider. Keep `piSimpsonm09` available until you verify the canonical instance.

What Pi loads:

- Pi reads `AGENTS.md` and `CLAUDE.md` from the session folder and its parent folders. The generated workspace `AGENTS.md` therefore applies to repositories under the workspace. Pi gets the fallback file only if your own instructions reference it.

- `packages` lists each layer whose repository-root `package.json` has a `pi` key. For pinned PStack, this is the root of `.claude\cache\pstack`; for local PStack, it is the local checkout root. Both load its Pi extension (`/loop`) and package resources.
- `skills` lists each layer's installed skills folder under `.claude\plugins`, keeping them in sync with Claude Code.
- The org layer's Pi tool-call gate is on its `main` branch, and its `package.json` has a `pi` key, so the installer lists the org layer as a package. The installer refuses a `pi` key that names a file, or a `package.json`, that the installed copy does not carry. The org layer's `files` list must therefore include its `pi` folder and `package.json`.

The wrapper sets `AGENT_ACCESS_PI_ASK=allow`, as the Copilot wrapper does, and the org gate reads that variable. So the gate's `ask` becomes `allow` in T3 runs. Denials and the repository access level still apply.

Known limits:

- `PI_CODING_AGENT_DIR` does not isolate skills. Pi also loads `%USERPROFILE%\.agents\skills`, which the spike found held 40 skills on this machine. The wrapper does not redirect `USERPROFILE`, because that would also move the login.
- Pi reads `AGENTS.md` and `CLAUDE.md` from the session folder and its parents. A generated workspace `AGENTS.md` applies to repository sessions under the workspace. Pi gets the fallback file only when your own instructions reference it.

The Pi harness asks RPC `get_commands` for loaded commands and checks that `/loop` is registered with source `extension`. Its stand-in test reports this check as unverified because the stand-in cannot establish that Pi executed a real extension. Pi documents `get_commands` as listing loaded extension commands. Installer tests cover pinned and local package paths.

Not verified: the `piSimpsonm09` instance in a T3 session, any model turn, a login, an org gate decision under a real Pi session (the rpc probe lists no commands for the gate), and `pi.sh` run with the real Pi CLI. On macOS, nothing in this section has been run.

When the workspace wrapper selected its managed local Pi, `pi update --self` asks npm for the latest package in that
workspace's `.maxstack/npm` prefix and skips lifecycle scripts. On Windows, the command wrapper delegates validation
to an installer-owned Node helper in `.maxstack/bin`. The wrapper refuses if that package has disappeared,
if `MAXSTACK_PI_BIN` overrides the selection, or if any extra argument follows `--self`, including an empty argument.
If the wrapper selected an external or global Pi, it names that path and refuses without running npm. The wrapper
command always selects latest.

You can also audit the update with `pwsh -File scripts/Install-Workspace.ps1 -Workspace <workspace> -UpdatePi`, then
add `-Apply` to perform it. This installer path can pin a release with `-PiVersion <version>`, such as
`-UpdatePi -PiVersion 1.2.0 -Apply`. Both paths update only `.maxstack/npm`; an update does not require another
installer apply. The wrappers and `.pi\agent\settings.json` do not depend on the Pi version.

### Check Pi without a model

Run `just verify-pi` (or `node scripts/verify-pi-harness.mjs`). It starts the workspace's Pi in RPC mode, the mode T3 uses, against a stub model server on `127.0.0.1` and a scratch agent folder. It needs no model, GPU, or download, and it takes seconds. It asserts that Pi starts and exits 0, that a turn reaches the stub, that one installed skill from each Pi layer (pstack, org, personal) is in the system prompt, that the org gate denies a launcher call, that the denied command does not run, that the denial reaches the model as a tool result, and that the Pi agent folder and the wrapper folder did not change. It exits 0 only when every check passes, and names each failing check otherwise.

It writes nothing to the workspace. Its files live in a scratch folder under the temp directory, which it removes on every exit path. It reads the Pi settings and the wrapper, and it never reads an auth file.

It does not prove a real model's answer, the `piSimpsonm09` T3 session, a login, the other runtimes, or the gate's decision on any command except the launcher call.

The wrapper cannot take another agent folder, so the check reads the Pi binary the wrapper names and starts it with the wrapper's variables, changed as follows. The agent folder is scratch, not `.pi\agent`. The home folder is scratch, so `~\.pi` and `~\.agents` are not read. The environment is an allow-list, where the wrapper inherits everything. `PI_OFFLINE` and `PI_TELEMETRY` are set. The arguments add `--no-session` and select the stub with `--provider` and `--model`.

### Check Pi with a real local model

Pi reads any OpenAI-compatible endpoint from `.pi\agent\models.json`: a provider with its `baseUrl`, `"api": "openai-completions"`, and the model ids the server serves. The workspace file already has a provider for a local llama.cpp server, `llama-local`. maxstack sets no model. Pick one in the T3 model picker. The optional llama.cpp note in `simpsonm09-dev-setup` covers starting that server, and the note is being added separately. Any local server that speaks the OpenAI chat API works the same way, not only llama.cpp.

If T3 reports that the provider could not start a turn, read the server log for `Model not found: <provider>/<model>`. That message means the picker holds a model that the Pi agent folder does not define, such as a model from an earlier test provider. Pick a model that `models.json` still lists.

## Codex (maxstack)

The opt-in `codex` runtime installs selected layer skills and makes the workspace instructions available to Codex. Select it with `-Runtimes codex` or `maxstack.settings.json`.

The opt-in `cursor` runtime copies selected layer skills into `<Workspace>/.cursor/skills`. Install with `-Workspace` set to the active Cursor project root. Skills and T3 session loading have not been verified in a live Cursor session.

Create or configure the `codex_maxstack` provider instance in T3 Code. This workspace has that instance, but a fresh install may not. Use the ID `codex_maxstack` and label `maxstack` if the T3 settings UI supports that exact custom ID for Codex. Otherwise, keep `codex_maxstack` as the target and do not migrate a project default to it. Keep CODEX_HOME path and Shadow home path at their defaults:

1. Keep CODEX_HOME path and Shadow home path at their defaults. On Windows, use the package's native `codex.exe` as Binary path when T3 would start the npm `codex.cmd` shim through a shell. The fixed argument contains brackets and quotes that shell parsing can alter. The line uses single quotes inside double quotes because Windows PowerShell 5.1 drops double quotes nested inside single quotes when it starts a program.
2. Set Launch arguments to this fixed line. The installer prints it every time. It never changes.

   ```text
   -c "project_root_markers=['stack.lock.json']"
   ```

Codex normally uses the repository root as its project root. The marker makes the workspace the project root, so repositories under it can read its skills and `AGENTS.md`.

### The access gate line

When a selected layer ships the Codex gate hook and its OpenCode copy is installed, maxstack writes only the `PreToolUse` hook definition to `.codex/config.toml`. It records that file in `stack.lock.json`. It keeps an unowned file, and it keeps a hand-edited owned file. Remove and uninstall delete the file only while it still matches the recorded bytes. If an unowned `.codex/config.toml` already exists, add the hook there by hand.

After apply, do this once in the workspace folder:

1. Run `codex`.
2. Choose to trust the workspace folder.
3. Approve the hook in Codex's hook review, opened with `/hooks`.

Codex lists `/hooks` as its lifecycle hook review command in [the v0.162.1 slash-command source](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/slash_command.rs). Codex stores project trust and hook approval in the active user config. maxstack never reads or writes that config. Repeat the approval only when apply or `-Status` reports: `the Codex hook changed since the last apply: approve it again in Codex`. Status compares the hook's current hash from `codex app-server` `hooks/list` with the hash in the lock. It cannot see whether the user approved the hook.

The org layer blocks GitHub writes through the Codex `Bash` hook. By owner decision this applies in every repository. Codex does not report a command's working folder to this hook, so the gate cannot select a repository-specific access level.

The gate covers shell commands only, including unified exec. File edits, MCP tools, and hosted tools are outside it. It is a guardrail: Codex skips an unapproved hook, and a missing `node`, hook script, or a timeout lets the command through. The gate turns `ask` into deny. maxstack supports one gate hook and uses the first selected layer that ships one.

### What the gate covers on Codex

- The gate covers shell commands only, through the `Bash` tool, which also covers Codex unified exec. File edits, MCP tools, and hosted tools are outside it.
- Chained commands are decided by their first word, as on the other harnesses.
- On Codex the gate is a guardrail and not a hard boundary. Codex skips a hook that is untrusted, cannot start, or times out, and only the exit-0 JSON deny blocks on Windows. A worker or gate failure after the adapter starts is converted to that JSON deny. A missing `node`, a missing hook script, or a timeout lets the command through.
- A gate `ask` becomes a deny, because Codex PreToolUse cannot ask a person.

`T3CODE_CODEX_LAUNCH_ARGS` replaces the instance's launch arguments when it is set. With it set, the marker is gone and the session sees no workspace skills.

What Codex receives:

- Skills: each selected layer's skills, as folders under `.agents\skills`. The lock owns each folder.
- Instructions: the generated workspace root `AGENTS.md`, or an existing user `AGENTS.md` that maxstack kept. Codex reads it only when the launch arguments name `stack.lock.json`. If a root collision sends the shared text to `.maxstack/workspace-instructions.md`, Codex does not load that fallback automatically.
- The access gate: the org layer's PreToolUse hook from `.codex/config.toml`, when approved in Codex. MCP servers and custom agents are not delivered yet.

Verified in a corrected controlled fixture on 2026-10-22 with Codex CLI 0.163.0: the parent workspace contains `stack.lock.json` and a sentinel `AGENTS.md`, while a nested Git repository has no marker. `debug prompt-input` from the nested repository omits the parent sentinel by default and includes it with `-c project_root_markers=["stack.lock.json"]`. The rerunnable `just verify-codex-discovery <native-codex-path>` acceptance check repeats this local CLI test in a synthetic workspace and empty fixture-local `CODEX_HOME`; it prints only a validated version, status, fixed diagnostic category, and sentinel booleans. It needs no login and makes no model call. This establishes local Codex marker semantics only; it does not verify T3 launch arguments, hook invocation or trust, or model inheritance. Hook discovery and trust are measured separately with `codex app-server hooks/list`. A T3 Codex session and a live gated turn are not verified.

## Cursor and Antigravity

The opt-in `cursor` runtime copies selected layer skills into `.cursor\skills`. Cursor reads that folder and the generated root `AGENTS.md` when the workspace root is its active project. If a nested repository is the active project, set `-Workspace` to that repository and use the existing local source overrides for sibling layer checkouts. Cursor does not inherit the parent's generated files. If an unowned root `AGENTS.md` blocks generation, the installer keeps it and writes `.maxstack\workspace-instructions.md`; reference that fallback from your own instructions to load it. The fallback is not consumed automatically.

The opt-in `antigravity` runtime copies selected layer skills into `.agents\skills`, shared with Codex. Google documents this workspace location for the Antigravity app, CLI, and IDE. When a selected layer ships the Antigravity gate hook, the installer also writes an owned `.agents\hooks.json` whose command runs the adapter by absolute path. The installer does not configure Antigravity rules, plugins, models, or global settings. The live probe 2026-10-21 ran three T3 Antigravity sessions on Windows 11. They loaded skills from user-global `~/.gemini/config/skills`, but no workspace skills, workspace instructions, or gate hook. The denied probe write reached GitHub (HTTP 404). Keep Antigravity in `t3.readOnlyInstances` as a read-only helper. A standalone Antigravity app or CLI session in the workspace is untested. See [Antigravity skills](features/antigravity.md).

Cursor has no plugin delivery or layer agent delivery. When a selected layer ships the Cursor gate hook, the installer writes an owned `.cursor\hooks.json` whose command runs the adapter by absolute path. Its live skill load, gate hook, and T3 session remain unverified. The live probe 2026-10-21 stopped at the free plan limit: "Upgrade your plan to continue". Fed a documented `beforeShellExecution` payload by hand, the installed hook command returned `permission: deny` with the catalog denial reason.

In T3 Antigravity, neither workspace `.agents/hooks.json` nor the per-provider config folder's `hooks.json` loaded the hook. The session cwd was the trusted workspace, and `run_command` arguments matched the adapter. Fed by hand, the installed adapter denied correctly.

## Not set up

Cursor and Antigravity have T3 instances. Cursor remains unverified because of the plan limit; Antigravity is a read-only helper without workspace skills, instructions, or the gate.

## Checks

- The audit prints drift for each child and each wrapper without writing anything: `pwsh -File scripts/Install-Workspace.ps1`. It reports `missing`, `differs`, `matches`, or `stale`. A `stale` line also marks a folder under `.opencode\plugins` that no layer names. `-Apply` removes such a folder only when the previous `stack.lock.json` recorded it as a layer folder, or when it is the retired `pstack-opencode` port, and reports any other one as kept.
- The OpenCode check runs `opencode debug config` and `opencode debug agents` from the workspace: `pwsh -File scripts/verify-opencode-workspace.ps1`. OpenCode 2.x debug commands start or reuse its managed background service; the check makes no model call. Each command has a 60-second limit.
- The workspace verifier checks each runtime against `stack.lock.json`: `python scripts/verify-workspace-install.py`. For Copilot it checks each wrapper's hash, the ask switch, the plugin folders in order, and that the executable exists. For Pi it checks each wrapper's hash, the agent folder and ask switch, and that the settings list each recorded package and skills folder, and that each package has a `pi` key.
- A live probe from a scratch repository under `projects\repos`: `claude -p --model haiku --plugin-dir <workspace>\.claude\plugins --output-format stream-json --verbose "List the plugin skills you have whose names start with simpsonm09. Reply with just the names."` The init event lists the loaded plugins and skills.

## Why not `--settings`

An earlier design gave each T3 instance `--settings <file>`, which holds a marketplace and enabled plugins. T3 passes its own settings through the Claude Agent SDK when thinking summaries are on. Claude keeps only the last `--settings` flag it is given, so one of the two was always silently dropped. `--plugin-dir` is not used by T3, so it does not collide with T3's flags. Multiple `--plugin-dir` flags add up rather than replacing each other.

## Behaviour to know

- Claude Code reads each plugin folder when a session starts. Re-run the installer, restart the running OpenCode server, then start a new session.
- T3 can reuse an already-running OpenCode server across sessions. Restart that server after reinstalling OpenCode plugins or skills; a new T3 session alone does not reliably reload them.
- The Copilot CLI reads its plugin folders when it starts, so a new Copilot session after an install is enough.
- The first session already sees pstack. Nothing is fetched at session start, because the folder is already on disk.
- The Claude folder has no absolute path in it. A junction records its target internally, and the installer recreates it on each apply. The Copilot wrapper does hold absolute paths, because the Copilot executable and the folders are named there.

## Verified

- `--plugin-dir <parent>` loads each child folder, junctions included. The plugin reports as `<name>@inline`.
- `CLAUDE_CODE_PLUGIN_DIRS` loads the listed folders with no flag.
- `--plugin-dir` alongside `--settings '{"showThinkingSummaries":true}'` keeps the plugins and all their skills loaded.
- The org SessionStart hook runs through the junction, and `${CLAUDE_PLUGIN_ROOT}` resolves there.
- The org PreToolUse hook runs through the junction. A Bash command that mentions the GitHub token launcher is denied by it.
- OpenCode 2.0.26 loads the nested pstack entry named in `opencode.jsonc`, and the root org and personal entries, from an installed workspace. The check used a temporary workspace and an unavailable model, so it made no model call.
- The generated `copilot.cmd` runs its executable with the switch set and every plugin folder in order, and passes arguments through. This was first tested with a stand-in executable. It has since been verified live on Windows through the `copilotSimpsonm09` instance: the SessionStart context, the skills, and the org gate work.

Not yet verified: `copilot.sh` on macOS.

## Generated files and git

The workspace root is not a git repository. Add these paths to its `.gitignore` before initializing a repository there. The installer does not write `.gitignore`:

```gitignore
.agents/
.claude/cache/
.claude/plugins/
.maxstack/
.opencode/agents/
.opencode/plugins/
.pi/
opencode.jsonc*
stack.lock.json*
```

`.pi/` holds Pi's login in `.pi\agent\auth.json`, so ignore the whole folder.

This repository does not edit that file, because it sits outside the repository.
