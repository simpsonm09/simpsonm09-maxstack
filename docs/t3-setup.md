# T3 setup

T3 can run OpenCode, Claude Code, the Copilot CLI, and Pi against the same workspace. The four harnesses find the plugin layers differently, so each needs its own setup.

## T3 instances

T3 keeps its provider instances in `%USERPROFILE%\.t3\userdata\settings.json`. T3 reloads that file while it runs, so an edit needs no restart.

| Instance id | Display name | Provider | Points at | Use |
| --- | --- | --- | --- | --- |
| `claudeAgent` | Claude (default) | Claude | no plugin folder | Plain Claude Code |
| `claudeSimpsonm09` | Claude (maxstack) | Claude | launch args `--plugin-dir D:\dev\simpsonm09\.claude\plugins` | Claude Code with the workspace plugins |
| `copilot` | Copilot (default) | Copilot | the registry `copilot.exe` | Plain Copilot CLI |
| `copilotSimpsonm09` | Copilot (maxstack) | Copilot | `commandPath` `D:/dev/simpsonm09/.maxstack/bin/copilot.cmd` (macOS: `copilot.sh`) | Copilot CLI with the workspace plugins |
| `piSimpsonm09` | Pi (maxstack) | Pi | `binaryPath` `D:/dev/simpsonm09/.maxstack/bin/pi.cmd` | Pi with the workspace packages and skills |

The maxstack instances apply only to the simpsonm09 workspace. The default instances need no folder and no wrapper.

## OpenCode

Nothing to configure. OpenCode walks up from the session directory to the filesystem root and merges each `opencode.jsonc` and `.opencode` it finds. So `D:\dev\simpsonm09\opencode.jsonc` and `D:\dev\simpsonm09\.opencode` apply to every repository and git worktree under the workspace. This was verified with OpenCode 2.0.24.

The installer lists the PStack entry in the workspace `opencode.jsonc`, as `./.opencode/plugins/pstack/opencode`. The path is relative to that file, so it holds no machine-specific root and works from any session directory under the workspace.

### Models

Use an `opencode-go/*` model. `opencode/*` models report insufficient funds. No default model is set for OpenCode or Claude, so pick one in the T3 model picker.

## Claude Code

Claude Code does not walk up for plugins. The installer therefore builds one folder of Claude plugins at the workspace root, `D:\dev\simpsonm09\.claude\plugins`. Each child folder is one plugin. The `claudeSimpsonm09` instance points at that folder:

1. Generate the folder: `pwsh -File scripts/Install-Workspace.ps1 -Apply`.
2. In T3, select the `claudeSimpsonm09` instance, Claude (maxstack). Its launch arguments are `--plugin-dir D:\dev\simpsonm09\.claude\plugins`. To set it up again, add a Claude provider instance with those launch arguments.
3. Fleet projects select that instance through the project's default model.

Plain `claude` outside T3 takes the same flag, so `claude --plugin-dir D:\dev\simpsonm09\.claude\plugins` gives the same plugins.

The alternative is an instance environment entry, `CLAUDE_CODE_PLUGIN_DIRS`, with the child folders listed and separated by `;`. The installer does not generate that list; it is the same folders as the `--plugin-dir` route.

| Plugin | Folder | Source | Skills appear as |
| --- | --- | --- | --- |
| `pstack` | `.claude\plugins\pstack` | a copy of `plugins/pstack` from `simpsonm09/pstack-claude`, at the commit in `pstack.lock.json` | `pstack:poteto-mode`, and the other `pstack:*` skills |
| `simpsonm09-org-ai-plugin` | `.claude\plugins\simpsonm09-org-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-org-ai-plugin` | `simpsonm09-org-ai-plugin:repo-standard`, and the other `simpsonm09-org-ai-plugin:*` skills |
| `simpsonm09-personal-ai-plugin` | `.claude\plugins\simpsonm09-personal-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-personal-ai-plugin` | `simpsonm09-personal-ai-plugin:dev-tools`, and the other `simpsonm09-personal-ai-plugin:*` skills |

The local folders are junctions to the installed OpenCode copies, so there is still one installed copy for both harnesses. One `Install-Workspace.ps1 -Apply` updates both. A junction needs no administrator rights. Each plugin's hooks run only in sessions that load it, and they resolve their files through the junction.

The pstack folder is a copy, not a junction. It is not a junction because the OpenCode copy holds only `opencode/` and `skills/`, and the Claude plugin needs the whole folder. The installer fetches the fork into `.claude\cache\pstack`, sparse to `plugins/pstack`, and checks out the pinned commit. The cache is reused offline once it holds the commit.

## Copilot

The Copilot provider does not take plugin folders from the instance's arguments. T3 ignores `commandArgs` for registry ACP agents. So the installer writes a wrapper, `.maxstack\bin\copilot.cmd`, and the `copilotSimpsonm09` instance starts the wrapper instead of `copilot`. The default `copilot` instance starts the registry `copilot.exe` and needs no wrapper.

1. Generate the wrapper: `pwsh -File scripts/Install-Workspace.ps1 -Apply`. It needs the Copilot CLI installed. If Copilot is not on `PATH`, the installer skips the wrapper and says so. Install Copilot, then run it again.
2. In T3, select the `copilotSimpsonm09` instance, Copilot (maxstack). Its `config.commandPath` is `D:/dev/simpsonm09/.maxstack/bin/copilot.cmd`. To set it up again, copy the registry `copilot` instance and set the copy's `config.commandPath` to `<workspace>/.maxstack/bin/copilot.cmd`. On macOS, use `copilot.sh` in the same folder.
3. Fleet projects select that instance through the project's default model.

The wrapper runs the Copilot CLI with one `--plugin-dir` for each layer that lists `copilot`, in layer order: pstack, then the org layer, then the personal layer. Each folder is the same `.claude\plugins` folder Claude Code uses. The wrapper then passes its own arguments through. The installer writes the Copilot executable's absolute path into the wrapper. If you move or reinstall Copilot, run the installer again.

### The ask switch

The wrapper sets `AGENT_ACCESS_COPILOT_ASK=allow` before it starts Copilot. This is needed because of how T3 handles approval.

The org gate answers a GitHub write that the access level permits with `ask`. Copilot then asks for approval. T3 talks to Copilot over ACP, and ACP auto-denies an `ask`, so without the variable the write would be denied. With the variable set to `allow`, the Copilot adapter turns that `ask` into `allow`. The denial reason and the rewrite stay the same.

The switch changes only that `ask`. Denials still apply, and the repository access level still applies. A call the gate denies is still denied.

A plain interactive `copilot` does not set the variable, so it keeps the prompt. The wrapper sets the variable only in its own process. Your shell and other programs do not see it.

The variable is set in the wrapper, not in the T3 instance, so other Copilot runs are not affected.

### What works on Copilot

On Windows, pstack's PreToolUse hook is a no-op stub under Copilot, so its file-read and subagent-model checks do not run there. The SessionStart context, the skills, and the org gate work on Copilot. The macOS `copilot.sh` is untested.

## Pi (maxstack)

T3's native Pi provider runs `<binaryPath> --mode rpc <launchArgs>`. The installer writes a wrapper, `.maxstack\bin\pi.cmd`, and Pi's settings, `.pi\agent\settings.json`. The wrapper sets the agent folder to `.pi\agent`, so Pi loads the workspace layers and keeps its own login there. The `piSimpsonm09` instance starts the wrapper.

1. Install the Pi CLI, `@earendil-works/pi-coding-agent`, either into the workspace at `D:\dev\simpsonm09\.maxstack\npm` so that its `pi.cmd` lands in `.maxstack\npm\node_modules\.bin`, or on `PATH`. The installer looks in the workspace first. Then generate the wrapper and the settings: `pwsh -File scripts/Install-Workspace.ps1 -Apply`. The installer writes the absolute path of the Pi it finds into `pi.cmd`. If it finds no Pi, it keeps the wrappers the lock already records, as they are, and warns; with none recorded, it skips the wrapper with a message and still writes the settings. Install Pi, then run the installer again.
2. Sign in once, yourself. Run `D:\dev\simpsonm09\.maxstack\bin\pi.cmd`, enter `/login` in Pi, and sign in to a provider. The login is written under `D:\dev\simpsonm09\.pi\agent`, the folder T3's instance uses. Keep `.pi\agent\auth.json` out of git, and never paste it into a doc or a chat. An agent never logs in for you.
3. In T3, select the `piSimpsonm09` instance, Pi (maxstack). Its driver is `pi`, its `binaryPath` is `D:/dev/simpsonm09/.maxstack/bin/pi.cmd`, and its `launchArgs` are empty. Leave `customModels` empty, and pick the model in T3's picker. maxstack sets no Pi model or provider. To set it up again, add a Pi provider instance with those values.

What Pi loads:

- `packages` lists each layer whose `package.json` has a `pi` key. The pstack package is the root of its pinned cache, `.claude\cache\pstack`, because its `pi` key names paths from the repository root. It loads the pstack extension (`/loop`) and its skills.
- `skills` lists each layer's installed skills folder. The org and personal skills load this way today.
- The org layer's Pi tool-call gate is on its `main` branch, and its `package.json` has a `pi` key, so the installer lists the org layer as a package. The installer refuses a `pi` key that names a file, or a `package.json`, that the installed copy does not carry. The org layer's `files` list must therefore include its `pi` folder and `package.json`.

The wrapper sets `AGENT_ACCESS_PI_ASK=allow`, as the Copilot wrapper does, and the org gate reads that variable. So the gate's `ask` becomes `allow` in T3 runs. Denials and the repository access level still apply.

Known limits:

- `PI_CODING_AGENT_DIR` does not isolate skills. Pi also loads `%USERPROFILE%\.agents\skills`, which the spike found held 40 skills on this machine. The wrapper does not redirect `USERPROFILE`, because that would also move the login.
- Pi reads `AGENTS.md` and `CLAUDE.md` from the session folder and its parents. Pi needs an `AGENTS.md` at the workspace root only if one already exists there. The installer does not create one.

Verified: with the generated `pi.cmd` and the pinned pstack commit in a temporary workspace, `get_commands` in `rpc` mode lists 68 skills (pstack 58, org 6, personal 4) and the pstack `loop` extension, with no model call. The installer tests cover the wrappers, the settings merge, and the verifier.

Not verified: the `piSimpsonm09` instance in a T3 session, any model turn, a login, an org gate decision under a real Pi session (the rpc probe lists no commands for the gate), and `pi.sh` run with the real Pi CLI. On macOS, nothing in this section has been run.

## Not set up

Cursor, Codex, and Antigravity are not set up for this workspace, because their quota is not available. They have no instance or wrapper here.

## Checks

- The audit prints drift for each child and each wrapper without writing anything: `pwsh -File scripts/Install-Workspace.ps1`. It reports `missing`, `differs`, `matches`, or `stale`. A `stale` line also marks a folder under `.opencode\plugins` that no layer names. `-Apply` removes such a folder only when the previous `stack.lock.json` recorded it as a layer folder, or when it is the retired `pstack-opencode` port, and reports any other one as kept.
- The OpenCode check runs from the workspace and starts no server: `pwsh -File scripts/verify-opencode-workspace.ps1`. It runs `opencode debug config` and `opencode debug agents`, each with a 60-second limit.
- The workspace verifier checks each runtime against `stack.lock.json`: `python scripts/verify-workspace-install.py`. For Copilot it checks each wrapper's hash, the ask switch, the plugin folders in order, and that the executable exists. For Pi it checks each wrapper's hash, the agent folder and ask switch, and that the settings list each recorded package and skills folder, and that each package has a `pi` key.
- A live probe from a scratch repository under `projects\repos`: `claude -p --model haiku --plugin-dir D:\dev\simpsonm09\.claude\plugins --output-format stream-json --verbose "List the plugin skills you have whose names start with simpsonm09. Reply with just the names."` The init event lists the loaded plugins and skills.

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

The workspace root is not a git repository. Its `.gitignore` (`D:\dev\simpsonm09\.gitignore`) is defence in depth in case anyone runs `git init` there. It already ignores `.opencode/plugins/`, `opencode.jsonc`, and `stack.lock.json`. Add these lines for the generated runtime folders:

```gitignore
.claude/plugins/
.claude/cache/
.maxstack/bin/
.pi/
```

`.pi/` holds Pi's login in `.pi\agent\auth.json`, so ignore the whole folder.

This repository does not edit that file, because it sits outside the repository.
