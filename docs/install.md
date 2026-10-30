# Install and reload

> **Requires PowerShell 7 or later (`pwsh`).** `scripts/Install-Workspace.ps1` declares `#requires -Version 7.0`. Windows PowerShell 5.1 (`powershell.exe`) stops at once with that requirement and does not run the installer. Every installer command in this document is written as `pwsh -File`.

## Workspace discovery

## Platforms

Windows is supported. The `test-macos` and `test-linux` CI jobs run the same fixture lifecycle for Claude, OpenCode, Copilot, Pi, Codex, Cursor, and Antigravity outside the required `test-node` aggregate. Neither uses `continue-on-error`, so a failure makes the workflow run fail. They verify installer output, strict status, runtime removal, and uninstall on hosted macOS and Linux; they do not exercise installed CLIs or their hooks. The Windows installer suite also runs the lifecycle fixture in `test-node-shard`. The Codex, Cursor, and Antigravity fixture declarations are opt-in test data; the shipped layers currently declare Claude, OpenCode, Copilot, and Pi only. macOS and Linux installs write only POSIX wrappers (`copilot.sh`, and `pi.sh` when Pi is selected); their lock records own those files and never record `.cmd` wrappers. Windows keeps writing and recording both `.cmd` and `.sh` wrappers. Claude plugin folders use directory symlinks on macOS and Linux and junctions on Windows when shared with OpenCode, with link-safe ownership, hashing, status, replacement, and removal. Windows lock records keep the `junction` kind; POSIX records `symlink`.

PowerShell 7 is preinstalled on GitHub's hosted macOS runner. On a Mac without `pwsh`, install it with Microsoft's package or, if Homebrew is already installed, run `brew install powershell`. The Homebrew formula is community maintained.

The installer resolves its target in this order: `-Workspace`, `MAXSTACK_WORKSPACE`, the nearest folder from the current directory upward that holds a `maxstack.settings.json` or `stack.lock.json` file, then the script's own `projects\repos\<repo>\scripts` or `projects\worktrees\<repo>\scripts` location. If none names a workspace, it stops and lists these four choices. It prints the resolved absolute path and origin on the first line of a successful run.

An explicit or environment target must already exist as a directory. An empty value, a missing folder, or a non-filesystem current location is an error, and none of them falls through to another source. Discovery never creates a folder, so `-Status` and `-Update -Check` cannot create one either. Relative explicit and environment paths resolve from the current directory. A marker must be a file, and only its name is checked. A junction or symbolic link keeps the path you gave, so the lock names the link; the folder it names is checked like any other folder. A `stack.lock.json` that is a symbolic link or a junction is refused by `-Remove` and `-Uninstall`, which would otherwise act through it in another folder. Replace it with a regular file first. A folder inside `.git`, `.claude\cache`, `projects\repos`, or `projects\worktrees` is never a workspace.

Device prefixes (`\\?\` and `\\.\`), UNC paths (`\\server\share`), 8.3 short names, and paths with control characters are refused by their text before any filesystem lookup. Control, format, and separator characters in a message are shown as `\uXXXX`, and a long value is cut with `...`. The full rules and an example are in [Workspace settings](features/settings.md#workspace-discovery).

## New workspace

You need PowerShell 7, Git, Node.js and npm. The first apply needs network access to fetch the pinned PStack source and install npm dependencies for layers that have a `package.json`. Each such layer can add about 140 MB under `.opencode/plugins/<layer>/node_modules`; npm runs with `--ignore-scripts`.

Choose an empty workspace folder and clone the two local layers to the paths declared in `layers.json`. The installer fetches PStack itself at the recorded commit from [pstack-max, our fork of pstack-claude](https://github.com/simpsonm09/pstack-max).

```powershell
$Workspace = '<absolute workspace path>'
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Workspace 'projects/repos') | Out-Null
git clone https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin.git (Join-Path $Workspace 'projects/repos/simpsonm09-org-ai-plugin')
git clone https://github.com/simpsonm09-org/simpsonm09-personal-ai-plugin.git (Join-Path $Workspace 'projects/repos/simpsonm09-personal-ai-plugin')
npm install --prefix (Join-Path $Workspace '.maxstack/npm') '@earendil-works/pi-coding-agent'
$PiCommand = Join-Path $Workspace '.maxstack/npm/node_modules/.bin/pi.cmd'

pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Apply
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Runtimes all -PiCommand $PiCommand -Apply
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Status -Strict
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Apply
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Remove -Runtimes pi -Apply
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Runtimes pi -PiCommand $PiCommand -Apply
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Uninstall
pwsh -File scripts/Install-Workspace.ps1 -Workspace $Workspace -Uninstall -Apply
```

If Pi is not installed, the apply still installs the selected layers and settings, but reports that its wrappers were skipped. Install Pi, then rerun the Pi apply with `-PiCommand <path>`; the flag chooses the executable the wrappers run. The `-Status -Strict` step should exit 0 only when every selected output matches.

After install, create the T3 instances from the instructions in [T3 setup](t3-setup.md): [OpenCode](t3-setup.md#opencode), [Claude](t3-setup.md#claude-code), [Copilot](t3-setup.md#copilot), [Pi](t3-setup.md#pi-maxstack), and [Codex](t3-setup.md#codex-maxstack). Use the actual `$Workspace` path in each instance. Pi needs a Pi CLI installed in the workspace or available by `-PiCommand`; use `/login` once in Pi. Restart the OpenCode server after each install before starting a new T3 session.

Add the generated paths to the workspace `.gitignore`; the installer does not edit that file:

```gitignore
.agents/
AGENTS.md
.codex/
.claude/cache/
.claude/plugins/
CLAUDE.md
.maxstack/
.opencode/agents/
.opencode/plugins/
.pi/
.pstack/
opencode.jsonc*
stack.lock.json*
```

## Model

maxstack sets no model. The workspace `opencode.jsonc` has no `model` or `small_model` key, and the installed agent profiles have no `model:` line, so each agent runs the model the session uses. You pick that model in the harness: the T3 Code model picker for a thread or project, or your own OpenCode, Claude Code, or Copilot settings. The PStack Claude plugin's per-role models are set with its own `/setup-pstack` command.

## Hosts

T3 Code hosts the agent sessions. It runs four plugin providers against the same workspace, and a fifth, Codex, that gets the workspace skills and instructions:

- The OpenCode provider can reuse an already-running `opencode serve` across sessions. OpenCode reads the workspace `opencode.jsonc` and `.opencode` directory from the session directory upward.
- The Claude provider runs Claude Code with `--plugin-dir` pointing at `<workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).
- The Copilot provider runs `<workspace>\.maxstack\bin\copilot.cmd`, which starts the Copilot CLI with the same plugin folders. See [T3 setup](t3-setup.md#copilot).
- The Pi provider runs `<workspace>\.maxstack\bin\pi.cmd`, which starts Pi with the agent folder `<workspace>\.pi\agent`. See [T3 setup](t3-setup.md#pi-maxstack).
- The Codex provider reads the workspace skills and instructions when its launch arguments name the marker `stack.lock.json`. See [T3 setup](t3-setup.md#codex-maxstack).

Ubuntu WSL can also run the OpenCode CLI. It reads the same workspace files through the drive mount corresponding to the Windows workspace path.

## Runtime and layer selection

An optional [`maxstack.settings.json`](features/settings.md) beside `stack.lock.json` can declare runtime and layer selections. Its names add to the recorded selection. Omitted names stay selected until removed with `-Remove`. On a new workspace, a dimension named in the settings file selects exactly those names. `-Remove` warns about each removed name the file still lists, since the next apply selects it again. See [Workspace settings](features/settings.md) for its schema and reserved fields.

The workspace installs only the runtimes and layers it selects. `-Runtimes` names runtimes: `claude`, `opencode`, `copilot`, `pi`, `codex`, `cursor`, `antigravity`, or `all`. `-Layers` names layers by their names in `layers.json`, or `all`. Both take comma-separated values, which `pwsh -File` passes as one token:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Runtimes claude,copilot -Apply
pwsh -File scripts/Install-Workspace.ps1 -Runtimes pi -Apply
pwsh -File scripts/Install-Workspace.ps1 -Layers pstack -Apply
```

The selection is recorded in `stack.lock.json`, with each list sorted:

```json
"selection": {
  "runtimes": ["claude", "copilot"],
  "layers": ["pstack", "simpsonm09-org-ai-plugin", "simpsonm09-personal-ai-plugin"]
}
```

The rules:

- A plain `-Apply`, with no flags, reuses the recorded selection. It does not select a layer or runtime that `layers.json` gained after the selection was recorded. On a new workspace, no settings selection means all runtimes and layers; a dimension named in `maxstack.settings.json` selects exactly its listed names.
- A flag adds its names to the recorded selection, and never removes one. Naming a runtime or layer that is already selected prints `Already selected ...` and changes nothing. Removing one is `-Remove`, described in [Removing and uninstalling](#removing-and-uninstalling).
- A `-Runtimes` or `-Layers` name matches a runtime or layer name ignoring ASCII letter case, so `PSTACK` selects `pstack`. A name that holds a format or control character, such as a zero width space, is refused, and the refusal shows the character escaped, such as `​`. Other letters are not folded, so a name that only looks like a layer, such as one written with a ligature, is unknown.
- `all` expands to every supported runtime and every layer that `layers.json` names at the time of the run. The lock records the expanded names, not the word `all`, so a runtime or layer added later is not selected until a flag names it.
- An unnamed dimension keeps its recorded value. A new workspace with no settings selection and no flags selects every runtime and every layer, so a plain `-Apply` installs what it did before. A new workspace with `-Runtimes` selects exactly the runtimes named, and every layer unless `-Layers` names some.
- A layer or runtime that `layers.json` names but the selection leaves out is reported on every apply, audit, and status, with the flag that adds it, for example `-Layers <name>`. `-Status` also lists it as `not selected`. It is not installed until a flag names it.
- A recorded name that `layers.json` no longer names, such as a layer removed from it, is dropped from the selection with a warning. The next apply removes the folders that layer installed, the same way it removes a layer that stopped installing a runtime.
- A lock with no `selection` predates the field. It reads as `claude`, `opencode`, `copilot`, and `pi`, with every layer, and the next apply writes the field.
- `codex`, `cursor`, and `antigravity` are opt-in. A plain `-Apply`, a new workspace with no runtime named, and a lock with no `selection` select `claude`, `opencode`, `copilot`, and `pi`. Name an opt-in runtime with `-Runtimes`, in the settings file's `runtimes` map, or with `-Runtimes all`.
- `cursor` copies each selected layer's skills to `<Workspace>/.cursor/skills/<skill>`, and writes `<Workspace>/.cursor/hooks.json` when a selected layer ships the Cursor gate hook. Set `-Workspace` to the active Cursor project root. If you open a nested repository as the project, install at that repository root. The installer does not assume that a parent workspace's files load in a nested repository. Cursor skills use flat folder names, so duplicate names across selected layers are refused before workspace writes.
- `copilot` and `pi` need `claude`. Their wrapper or settings name the Claude plugin folders, so selecting either without `claude`, by name or in the recorded selection, is an error.
- An unknown name on the command line is an error that lists the valid names, and nothing is written.
- A layer installs only the selected runtimes it declares in `layers.json`, plus the selected `codex`, `cursor`, and `antigravity` skill projections. A selected layer that declares none of those is reported and installs nothing.

What each runtime writes:

- `claude`: `.claude\plugins`. A local layer is a junction to its OpenCode copy when `opencode` is selected too. Without `opencode` there is no copy to link to, so the layer's items are copied into the Claude folder instead.
- `opencode`: `opencode.jsonc`, `.opencode\plugins`, and the agent profiles.
- `copilot`: `.maxstack\bin\copilot.cmd` and `copilot.sh`.
- `pi`: `.maxstack\bin\pi.cmd` and `pi.sh`, and `.pi\agent\settings.json`.
- `codex`: `.agents\skills` and, when a selected layer has a Codex gate hook, `.codex\config.toml`.
- `cursor`: `.cursor\skills`, one folder per skill, and, when a selected layer has the Cursor gate hook, `.cursor\hooks.json`.
- `antigravity`: `.agents\skills` and, when a selected layer has the Antigravity gate hook, `.agents\hooks.json`.
- `codex`: `.agents\skills\<name>\`, one copy of each skill of each selected layer, in layer order. A skill is a folder with a `SKILL.md` whose frontmatter `name` is the folder name and whose `description` is set. Two layers cannot name a skill the same, even by case, and a skill that sets a `model` is refused. When a selected layer ships the Codex gate hook and its OpenCode copy is installed, maxstack also owns `.codex/config.toml` with the `PreToolUse` definition. Existing unowned files are kept. Edited owned files are kept; remove and uninstall delete only unchanged files. The lock records the hook hash for the Codex status check. The installer never reads or writes `CODEX_HOME`, user config, `auth.json`, or a model. The T3 instance uses the fixed marker argument `-c 'project_root_markers=["stack.lock.json"]'`.

Cursor and Antigravity gate hooks follow the same ownership rule. When a selected layer ships `hooks/cursor-hooks.json` or `hooks/antigravity-hooks.json`, the installer writes `.cursor\hooks.json` or `.agents\hooks.json` and rewrites each `command` to run the adapter by its absolute path. The command runs the adapter from the installed OpenCode copy when OpenCode is selected, otherwise from the Claude plugin folder when Claude is, and otherwise from the layer folder, so a selection without OpenCode still gets a working hook. Existing unowned files are kept and named for hand installation, edited owned files are kept, and remove or uninstall delete only unchanged files. A live Cursor or Antigravity session has not been verified.

## Workspace instructions

Any selected layer can declare `"workspaceInstructions": "path/to/file.md"` in its `layer.json`. The path is relative to the layer folder. The file must be regular UTF-8 Markdown, at most 4096 bytes, and cannot be a link or escape the layer folder. Layers without the field add nothing. maxstack joins declared files in layer order, with a generated header and a source marker before each file. The combined file is limited to 8192 bytes. A refusal names the layer. An oversized composition reports its measured size and each layer's contribution.

When no unowned root file that this run would write blocks the output, maxstack writes the composition to `AGENTS.md` and, only when Claude is selected, writes a generated `CLAUDE.md` containing `@AGENTS.md`. Thus `AGENTS.md` is a candidate output for every nonempty runtime selection, while `CLAUDE.md` is a candidate only when Claude is selected. Both files are owned in `stack.lock.json`. OpenCode receives a relative `instructions` entry for `./AGENTS.md` when selected.

If a candidate output exists and is not recorded as maxstack-owned, maxstack keeps it byte for byte and writes the composition to `.maxstack/workspace-instructions.md`. Only candidate outputs can collide: `AGENTS.md` for every nonempty runtime selection and `CLAUDE.md` only when Claude is selected. It does not create a non-candidate root file. It prints a line naming each kept root file and the fallback path. OpenCode points at the fallback file when selected. Add a reference to that fallback in your own instructions if you need it loaded by another harness.

An edited generated file is reported and kept. Apply does not overwrite it. `-Status` reports it as modified. `-Remove` and `-Uninstall` delete only unchanged generated files and keep edited ones in the lock for a later retry. When no selected layer declares instructions, no new file or OpenCode entry is produced. Previously generated files are removed through the same ownership rules.

The optional `t3.gatedInstances` and `t3.readOnlyInstances` lists write `.pstack/pstack-t3-instances.json`. Gated entries record the selected layer names and whether their sources include the gate hook. Read-only entries are cheap helpers for reviews, research, and explanation on harnesses without our layers or gate. pstack refuses them for roles whose helpers can write files, commit, push, or open pull requests. The ids are per-machine settings and maxstack supplies no defaults. The file and a created `.pstack` folder are recorded in `stack.lock.json`. An edited file is kept, and an existing file not recorded as maxstack-owned is kept without being read or overwritten. `-Remove`, `-Uninstall`, and empty lists delete only an unchanged file that maxstack recorded. The installer never touches the model sheet or other files in `.pstack`.

The pinned pstack cache under `.claude\cache` is the source every runtime copies from, so each layer that installs anything writes it, whichever runtime it serves. The lock records each runtime a layer does not install as `enabled: false`. For `copilot` and `pi` the reason is `not selected`.

The lock is replaced whole. The installer writes the new text to `stack.lock.json.new` beside it and then replaces the lock, so an interrupted run cannot leave a partial lock. The lock it replaced is kept as `stack.lock.json.bak`.

An empty, `null`, or truncated `stack.lock.json` stops every command before anything is written. The message says how to recover. Restore the lock from `stack.lock.json.bak` if that file reads, or repair it by hand. Deleting the lock is the last resort, and it has a cost: the selection resets to all runtimes and layers, and the `createdDirs` and `createdFiles` record is lost, so a later uninstall could not tell what the installer created. Keep `stack.lock.json.bak` either way.

An unselected runtime's files are left alone. An apply does not write, remove, or report them as drift. `-Status` names any that exist as `not selected`, and `-Strict` does not count them. `-Status` takes no selection flags, because it reports the recorded selection before owned path status rows.

## Install and reload

PStack is not checked out in the workspace. The installer fetches the `plugins/pstack` folder of the fork at the commit in `pstack.lock.json`, into `.claude\cache\pstack`, and checks that commit out. A cache already at the commit is reused without a network call. The org and personal layers are read from their checkouts under `projects\repos`.

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

After an install, restart the running OpenCode server, then start a new session in T3. T3 can reuse a long-lived server across sessions, and that server does not reliably reload plugins or skills after reinstall. Claude Code reads its `.claude\plugins` folder when a session starts. Copilot reads its plugin folders when it starts.

Check the installed workspace:

```powershell
pwsh -File scripts/verify-opencode-workspace.ps1
python scripts/verify-workspace-install.py
```

`verify-opencode-workspace.ps1` runs `opencode debug config` and `opencode debug agents` from the workspace. OpenCode 2.x debug commands start or reuse its managed background service; this check makes no model call. Each command has a 60-second limit; a call that runs past it fails the check and names the command. Plugin loading needs a model call, so `scripts/verify-workspace-skill.ps1 -Model <provider/model>` runs a bounded OpenCode session that loads a skill. It has a 180-second limit, and it needs a model because the workspace names none. `scripts/verify-workspace-skill.sh` takes the model as its second argument and the limit as its third.

`verify-workspace-install.py` checks each runtime the lock records: the Claude folders, the OpenCode folders and their entries, the agent profiles, the `plugin` entries in `opencode.jsonc`, and the Copilot wrappers against their recorded hashes.

## Claude Code

The same install also builds `.claude/plugins` at the workspace root: one child folder per Claude plugin. The org and personal folders are directory links to the installed OpenCode copies, using junctions on Windows and symbolic links on macOS. Pstack is a copy of its pinned folder in the fork. Without the `opencode` runtime there is no OpenCode copy, so a local folder is a copy of its items instead. Claude Code reads the folder when a session starts, so a new session is enough. A T3 Claude provider instance passes `--plugin-dir <workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).

## Codex

With `codex` or `antigravity` selected, the installer copies each selected layer's skills into `.agents\skills`. The two runtimes share each copied folder, and the lock records the selected consumers. Antigravity documents this workspace skill location for its app, CLI, and IDE. maxstack writes `.agents\hooks.json` when a selected layer ships the Antigravity gate hook, and does not configure Antigravity rules, plugins, models, or global settings. Neither skill loading nor the gate hook has been verified through a live T3 Antigravity session. Codex reads skills and workspace `AGENTS.md` only when the T3 Codex instance's launch arguments name the marker `stack.lock.json`. When a selected layer ships a Codex gate hook and its OpenCode copy is installed, the installer writes `.codex/config.toml` and prints a one-time trust step. See [Antigravity skills](features/antigravity.md) and [T3 setup](t3-setup.md#codex-maxstack) for the supported surfaces and Codex setup.

## Copilot CLI

`Install-Workspace.ps1` writes two wrappers into `.maxstack\bin`: `copilot.cmd` for Windows and `copilot.sh` for POSIX shells. Each runs the Copilot CLI with one `--plugin-dir` for each layer that lists the `copilot` runtime, in layer order, then passes its arguments through. The plugin folders are the `.claude\plugins` folders above; no second copy is made.

The installer finds the Copilot executable with `Get-Command copilot`. It never uses a match inside `.maxstack\bin`. The `.cmd` names that executable by its absolute path, so a later move of Copilot needs an apply. If Copilot is not found on this run, the installer keeps the two wrappers the lock records, as they are on disk, and warns that they were kept. It never removes them only because Copilot is missing: a wrapper goes only when no layer declares `copilot`, or when the runtime is removed with `-Remove`, and the lock records it with its hash. With no recorded wrappers, it skips both with a message. Either way it still installs everything else. Install Copilot, then run the installer with `-Apply` again. The wrappers run the Claude plugin folders, so `copilot` needs `claude` selected.

To test the wrapper without an install, pass a different executable: `-CopilotCommand <path>`.

## Pi

`Install-Workspace.ps1` writes `.maxstack\bin\pi.cmd` and `pi.sh`, and `.pi\agent\settings.json`. The wrappers set `PI_CODING_AGENT_DIR` to `.pi\agent`. At install time, `-PiCommand <path>` chooses the Pi CLI to wrap, beside `-CopilotCommand <path>` for Copilot. Without it, the installer checks the workspace Pi copy, `.maxstack\npm\node_modules\.bin\pi.cmd` (`pi` on POSIX), then the first `pi` on `PATH` outside `.maxstack\bin`. `MAXSTACK_PI_BIN` is read by the wrapper at run time; the installer does not read it. `pi.cmd` runs the Pi found at install time, and `pi.sh` runs the workspace copy when that was selected; with a PATH Pi, `pi.sh` resolves PATH at run time. The wrappers bake absolute paths to the agent folder and executable. After the workspace or Pi moves, rerun the installer. If Pi is missing, the installer prints a final incomplete-runtime summary; default exit remains 0, and `-Strict` exits 1. A wrapper is removed only when the lock records it, its hash matches, and no layer declares `pi`. Settings hold `packages` and `skills` lists; the installer owns only the entries it wrote under those keys. User values such as `defaultProvider` or `defaultModel` stay, and maxstack writes no model or provider. A layer is a Pi package when its root `package.json` has a `pi` key. For a local source, Pi uses that repository-root package; skills still point to the installed Claude plugin folders. Pi lists those folders, so `pi` needs `claude` selected. See [T3 setup](t3-setup.md#pi-maxstack).

### Update Pi

When the selected Pi is the workspace managed copy under `.maxstack/npm`, the generated wrapper handles
`pi update --self` by asking npm for `@earendil-works/pi-coding-agent@latest` with lifecycle scripts disabled. On
Windows, `pi.cmd` dispatches this command to the installer-owned Node helper in `.maxstack/bin`; Node validates the
complete argument vector before starting npm. It
refuses the command if the managed package has been removed, `MAXSTACK_PI_BIN` overrides the selected Pi, or any extra
argument (including an empty argument) follows `--self`. When the selected Pi is external or global, the wrapper names
its path and refuses the update without running npm. Run the installer from the maxstack checkout to audit an update or
pin a version:

  ```powershell
  pwsh -File scripts/Install-Workspace.ps1 -Workspace <workspace> -UpdatePi
  pwsh -File scripts/Install-Workspace.ps1 -Workspace <workspace> -UpdatePi -Apply
  ```

The first command audits the update. The second applies it. Pin a version with `-PiVersion <version>`, for example
`-UpdatePi -PiVersion 1.2.0 -Apply`. The update changes only `.maxstack/npm`. npm may warn that some packages have
install scripts that are not covered. This is expected because scripts are not run. Plain `npm update --prefix
<workspace>/.maxstack/npm` respects the saved dependency range. An exact version stays on that version. The documented
initial npm install normally saves a caret range. An exact pin means npm used `save-exact` when the dependency was
saved, or the range was set explicitly. Updating Pi does not require another installer apply. Its wrapper paths and
`.pi\agent\settings.json` do not depend on the Pi version.

The wrapper always selects `latest`; use `-PiVersion <version>` with `Install-Workspace.ps1 -UpdatePi -Apply` when you
need a pinned installer update.

## Audit and apply

Audit mode is the default. It prints one `Drift:` line for each thing the installer would change, and writes nothing:

```powershell
pwsh -File scripts/Install-Workspace.ps1
```

`-Apply` makes the changes. Each runtime is written in this order: the config, the OpenCode folders and agent profiles, the Claude folders, then the Copilot wrappers. A git source is fetched before anything is written, so a commit the fork cannot supply stops the run with the workspace unchanged.

Audit and `-Status` compare OpenCode plugin folders with the planned tree, so a changed layer source reports the same drift in both modes.

A layer that stops naming a runtime leaves its folder behind. `-Apply` removes an OpenCode folder that no layer names only when the previous `stack.lock.json` recorded it, so the installer made it. It also removes the folder of the retired `pstack-opencode` port on every apply. Any other unnamed folder is reported as stale and kept. The same cleanup applies to `.claude\plugins`: `-Apply` removes a child that no layer declares, and audit reports it as stale.

## Layer sources

A layer installs from one source. `layers.json` gives each layer its default source: `pstack` is a git pin with a commit, and the org and personal layers are local checkouts. `-Source` changes one layer's source for a run, and the lock records the change. Each `-Source` entry is `name=spec`, and the entries may be repeated or comma-separated:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Source pstack=simpsonm09/pstack-max@feat/opencode-runtime -Apply
pwsh -File scripts/Install-Workspace.ps1 -Source simpsonm09-personal-ai-plugin=local:<absolute path> -Apply
pwsh -File scripts/Install-Workspace.ps1 -Source pstack=default -Apply
```

The spec forms:

| Form | Example | Meaning |
| --- | --- | --- |
| `owner/repo@ref` | `simpsonm09/pstack-max@feat/opencode-runtime` | GitHub, at `https://github.com/<owner>/<repo>.git`. |
| `https://host/path.git@ref` | `https://example.com/team/layer.git@v2` | Any host, over HTTPS only. |
| `local:<absolute path>` | `local:<absolute path>` | A working tree. It is never fetched, and uncommitted changes install as they are. The layer's own folder inside the repository still applies, so `pstack` reads `plugins/pstack` in its checkout. |
| `name=default`, or `name=` | `pstack=default` | Drops the override, and the layer returns to its `layers.json` source. |

The ref in a git spec is a branch, a tag, or a full commit. It is checked as a git ref name. A spec is refused before anything is written when it has a space or a control character, starts with a dash, holds `..`, uses a scheme other than `https`, or carries a user name in its URL. A `local:` path must be absolute, must exist, and cannot be the workspace, a folder that contains the workspace, or a folder the installer writes (`.claude`, `.opencode`, `.pi`, or `.maxstack`). Each junction and symbolic link on the path is followed before that check. A device path is refused by its text, in any form: a `\\?\` prefix, a `\\.\` prefix, and a UNC path are refused before any folder is read. A `local:` folder is a git checkout only when it is the top level of its repository. A folder inside another repository records no commit. A `-Source` value cannot hold a comma, since a comma separates entries, and a folder with an `@ref`, such as `C:\x@main`, is refused with `did you mean local:C:\x?`.

The optional `maxstack.settings.json` can declare `layers.<name>.source`. Source precedence is command-line flags, then the settings declaration, then a recorded override, then the `layers.json` default. Omitting a source keeps a recorded override, and the run says so. Set `source` to `default` to drop that override. The settings source takes the `-Source` grammar. A relative local source is resolved from the workspace root only. It rejects `..` components, drive-relative and root-relative paths, protected output paths, a maxstack checkout, and links that resolve outside the workspace. An absolute local source follows the regular `-Source` rules and emits a machine-path warning.

A read-only audit skips a layer whose declared source is unavailable, and says so, with no fallback to the recorded override or the `layers.json` default. `-Status` and `-Update -Check` report a declared source and use the recorded one; only an apply uses the declaration. A declared git ref is not resolved by `-Status`. A real apply stops before any write when a declared source is unavailable, and it names the repair. A real `-Uninstall` never reads the settings file and proceeds from the lock's ownership records alone. A real `-Remove` reads it only to warn about names it still lists. A dry `-Remove` reports an unavailable declared source with the same skip line an audit prints. A dry `-Uninstall` reads no settings file: it removes what the lock recorded, prints `Settings: -Uninstall does not read maxstack.settings.json; it removes what the lock recorded.`, and names no skipped layer.

Seed a settings file from the lock's recorded selection and source overrides. The dry run prints the JSON and writes nothing:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -InitSettings
pwsh -File scripts/Install-Workspace.ps1 -InitSettings -Apply
```

`-InitSettings` requires an existing `stack.lock.json`. For a first workspace, copy `workspace/maxstack.settings.json` into the workspace, or run `-Apply` first to create the lock. The refusal is intentional because no selection or source can be derived without the lock.

The apply form writes only `maxstack.settings.json`, only when it does not already exist, and does not run a workspace apply or resolve a source. It refuses an existing file, directory, or link. Legacy source strings and schema 1 or 2 locks remain readable.

A `local:` path that is a drive root or a share root is refused, since a layer cannot be a whole drive or share. The refusal names the reason. A device path is not a long-path form that the installer reads: `\\?\C:\x` is refused by its text, as `\\?\UNC\server\share` is, so give the plain drive path `C:\x`.

`-LayerSource name=path` is the alias of `-Source name=local:path`, and it works for every layer, pinned ones included.

The rules:

- Sources resolve before anything is written. A source that cannot be read exits non-zero with the reason, and the install stays as it was.
- Git does not prompt for a credential, and runs no askpass program. Every git command runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, and `core.askPass` set to the empty string, which overrides a global or system askpass. Its child also loses `GIT_ASKPASS`, `SSH_ASKPASS`, and `SSH_ASKPASS_REQUIRE`, so a remote that needs a login over https fails at once. An ssh remote is refused before ssh starts, since `protocol.allow=never` allows only https, so no ssh prompt runs. A credential helper that the user's own config names still runs, since the guard does not turn helpers off. A remote whose refs do not arrive within 60 seconds is stopped, and the error says so.
- A plain apply reuses a recorded override, so an override holds until `-Source name=default` drops it.
- Git writes happen only in the layer's own cache folder, and reading a remote's refs writes nothing. The cache's origin is reset to the resolved URL on each sync. No layer's install scripts run: npm runs with `--ignore-scripts`, with no opt-out. An apply that runs npm names each layer whose `preinstall`, `install`, or `postinstall` script, or whose `binding.gyp`, did not run. See [plugin-publishing.md](plugin-publishing.md#assembly).
- A tree's own filter drivers are off for every git command the installer runs on it, and a local status turns off every filter that any scope defines (see the status rule below). A clean, smudge, or process command is a program that git runs while it reads a file, so the guard reads the filter drivers that the tree's repository config and its per-worktree config define, with the `include.path` entries that those files name. It turns each one off, and it marks each one not required. The settings reach git only through the environment of the git process (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, and `GIT_CONFIG_VALUE_<n>`), so no argument list grows with the tree, and the installer's own environment is never changed.
- A git command that names no tree, such as a ref lookup or a clone, runs in a fresh empty folder outside any repository, with that folder's parent as the ceiling git does not search above. So the config of the folder the installer starts from is never read, and the folder is removed when the command ends.
- Each git child loses the variables that git reads a repository, a worktree, a config, a program, or a transport policy from: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`, `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_ASKPASS`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_ALLOW_PROTOCOL`, and `GIT_PROTOCOL_FROM_USER`, along with any `GIT_CONFIG_*` entry the installer holds. `GIT_ALLOW_PROTOCOL` would otherwise override the `protocol.allow=never` the guard sets. The names match without regard to case. Only the child's environment changes, so the installer's own environment is as the user set it, and `GIT_CONFIG_NOSYSTEM` is left as the user set it too. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are left as the user set them, so a relocated config is read by the guard and by a status alike, and its credential helper still applies. The user's global config is read from `GIT_CONFIG_GLOBAL` when the user set it, and from `HOME` otherwise.
- A layer's cache keeps the user's global and system filters, such as git-lfs, by design, so a cache holds their content, not pointer files. A cache sync turns off only the filters the tree's own config and includes define, so a filter that the user's config defines runs there.
- A status of a local tree (an audit, `-Status`, or `-Update`) turns off every filter that any config scope defines, the user's global and system config included, so a filter that the tree's attributes name, such as a `.git/info/attributes` line for git-lfs, cannot run or write into the tree. The tree's attributes are still read, so an `eol` or `text` setting compares correctly: an unchanged CRLF file in an `eol=crlf` tree reads `clean`, and an edited one reads `uncommitted changes`. A tree whose attributes name a filter is compared as raw content, so an LFS tree whose committed files are pointers can read `uncommitted changes` while its working copy holds the content. A submodule is not read, since the status passes `--ignore-submodules=all`, so a change inside a submodule is not part of the dirty state.
- A tree the guard cannot pass is `unreadable: <reason>` in the source block, as a missing folder is reported. Its layer runs no git command, and an apply refuses it. The reasons are a filter driver name with a control character, which git cannot take as a setting; a filter driver name that is not valid UTF-8, since git's output is read strictly and a replaced byte would name a different filter, reported as `a filter driver name is not valid UTF-8`; more than 100 filter drivers, since each takes four settings; a name longer than 4096 characters, or names that together need more than 30000 characters of child environment (the Windows block is capped at 32767), reported as `filter name too long`; and a read of the config or of the status that git cut off, which has no end and so cannot be counted. A tree whose config cannot be read is refused in the same way: a folder with a `.git` entry that git stops on, such as a config with a parse error, reads `unreadable: config cannot be read`, with git's message after it. A folder with no `.git` entry, or one that git reports as not a repository, is not a checkout and names no filter.
- A folder that git refuses because another user owns it reads `unreadable: git refused the folder: it is owned by another user; add it to safe.directory or fix its ownership`, and an apply names that fix. A global or system config that git cannot parse refuses every guarded command: the reason is `git could not read its configuration, so the filter guard cannot be passed:` with git's own message after it, and an apply names the config file.
- The git versions the installer needs: git 2.31 or later, without which every guarded command is refused, since the settings are read from the environment (a git that is older prints nothing for the probe, and the reason says it is too old); and git 2.44 or later for the changed-file counts of `-Update`, which read the cache with `--no-lazy-fetch` (without it the counts read `unknown`).
- `-Source` applies to an apply or an audit. `-Status`, `-Remove`, and `-Uninstall` read the recorded sources and take no `-Source`.

The lock records each layer's source as an object. A git source records its URL, its ref, the full commit it resolved to, and `override`:

```json
"source": { "kind": "git", "url": "https://github.com/simpsonm09/pstack-max.git", "ref": "feat/opencode-runtime", "commit": "<40 hex characters>", "override": true }
```

A local source records HEAD and the dirty flag of its checkout. It never records a commit it cannot read, so a folder that is not a git checkout has `commit` and `dirty` set to `null`:

```json
"source": { "kind": "local", "url": null, "ref": null, "commit": "<40 hex characters>", "dirty": true, "override": true, "path": "<absolute path>" }
```

`override` is `true` for anything that differs from the `layers.json` default. A recorded override is checked each time the lock is read, with the same rules as a `-Source` spec: an https url, a safe ref, a full commit, and an absolute local path. In a plain apply, a value that fails stops the run before git or the install runs, and the message names the layer, the field, and the repair (`-Source <name>=default -Apply`). Any other run warns, names the same layer and field, ignores the recorded override for that run, and uses the `layers.json` source. A local override records its absolute path, since `-Update` reads the checkout again. That is the one lock value with an absolute path, and it appears only in an override record. A lock from before this record holds the source as a string, and it still verifies.

`-Status` and an audit print the layer sources that are not at their committed pin, above the state rows:

```text
Layer sources not at their committed pin:
  pstack: override, git <url> ref feat/opencode-runtime at <commit>
  simpsonm09-org-ai-plugin: local, default projects/repos/simpsonm09-org-ai-plugin (not a git checkout)
```

Every override, every local source, and every branch or tag override is listed. A git layer pinned by commit in `layers.json` is not.

### Updating the sources

`-Update` re-resolves each selected layer's recorded source. A branch or tag override moves to its current commit, and the layer records that commit. A commit pin stays as it is, and so does a `layers.json` pin. A local source is read again. The recorded selection applies, so `-Update` takes no `-Runtimes`, `-Layers`, or `-Source`, and it cannot be combined with `-Remove`, `-Uninstall`, or `-Status`.

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Update -Check
pwsh -File scripts/Install-Workspace.ps1 -Update -Check -Strict
pwsh -File scripts/Install-Workspace.ps1 -Update -Apply
```

Without `-Apply`, `-Update` prints the report and writes nothing. That is already a dry run, so `-Check` only names the report: `-Update` alone prints the same report, and `-Check` is accepted only with `-Update` and never with `-Apply`. For each selected layer it prints the old and new commit, the number of files that would change under the layer's folder, and each owned path an apply would rewrite. A commit the cache does not hold is reported as `needs fetch`, and its changed files are known after an apply fetches it. The check reads the cache with `--no-lazy-fetch`, so it never fetches an object into the cache. That flag needs git 2.44 or later. On an older git the report says `changed files unknown` rather than fetch. The count runs with rename detection off, so a partial clone that lacks a blob still gives a count, and a count git cannot read is reported as `changed files unknown`.

- `-Update -Check` writes nothing: not the tree, the lock, or the cache. It exits 0.
- `-Update -Check -Strict` exits 1 when anything would change.
- `-Update -Apply` applies the change like an apply, and `-Strict` is refused with it.
- `-Update` never changes `layers.json`. When a `layers.json` branch has moved past its pin, the report prints a one-line hint of the change to make by hand.
- `-Update` needs a lock that names a selection. A workspace without one is refused, and the message says to run an apply first.

`MAXSTACK_TEST_GITHUB_ROOT` is a test-only seam. The test suite sets it so that the `owner/repo` shorthand reads a local bare repository instead of GitHub. The installer honours it only when `MAXSTACK_TEST_MODE` is `1` and the folder is under the temp folder. Otherwise the shorthand names github.com. Each use prints a warning, and a real run never sets either variable.

## Ownership and status

`-Apply` writes an ownership record into `stack.lock.json`: the `owned` list, with `ownedSchema: 2`. It names each path the apply wrote, sorted by path, kind, and key. Each record also names the `runtime` it belongs to, or `null` for the claude cache, and the `layers` it was installed for, sorted, so `-Remove` can pick the records of what it removes:

- `opencode.jsonc`, `.maxstack\bin\copilot.*`, `.maxstack\bin\pi.*`, and each agent profile in `.opencode\agents`: a `file` with its SHA-256.
- `.claude\plugins\<layer>`: a `link` with its `target` for a local layer with `opencode` selected, or a `dir` for a pinned copy or a local copy of its items.
- `.claude\cache\<layer>`: a `dir` for each pinned layer.
- `.opencode\plugins\<layer>`: a `dir`.
- `.pi\agent\settings.json`: one `json-entries` record for `packages` and one for `skills`. Each holds only the entries the installer added, and none when it added none. An entry the user already listed is the user's, so it is not recorded, and a second copy the user wrote beside an installer entry stays the user's.
- `opencode.jsonc.bak` and `.pi\agent\settings.json.bak`, and their numbered copies `.bak.N`: a `file` record each, once an apply has written it, with a `role`. An apply copies a file before it replaces it when the file exists, differs from the new text, and holds something other than the installer's last write. The name and role of the copy follow what the lock knows:
  - `X.bak`, role `original`: the file the install first replaced. An apply never overwrites it. When a removal restored the file and stopped before its lock write, the file still holds the original bytes, so the next apply writes them back as `X.bak`, role `original`, and the file it replaces is kept as usual. When a lock is missing and an `X.bak` already exists that the installer did not write, the live file is copied to `X.bak.N` with role `original`, and the existing `X.bak` is recorded with role `user`.
  - `X.bak.N`, role `edited`: a hand edit, or a change to a file the installer created. When an earlier backup already holds the same bytes, no copy is written, and the apply says where those bytes are kept.
  - Role `user`: a backup the installer did not write. No removal restores or deletes it.
  A lock from before roles names no role. Its plain `X.bak` is the original, and a numbered copy has no role and is never restored.

The `claude` layer record keeps the link kind as `junction` on Windows and `symlink` on macOS. A prior Windows `junction` record remains readable. The top-level `owned` record stays `kind: link` on both platforms, so existing Windows ownership records are unchanged. Link targets are compared with the platform path rules. Hashing lists a link and its target without walking through it, and removal deletes the link itself only when it still points at the recorded target.

A `json-entries` record for a key the installer created in a settings file that already existed carries `createdKey: true`. The top-level `createdDirs` lists each directory an apply created, and `createdFiles` each file it created: `opencode.jsonc` and `.pi\agent\settings.json` when the apply created them, and not when they already existed. Both are sorted, and both lists name only what was not there before the first apply. The `pi` section records `settingsSha256`, the SHA-256 the last apply wrote to the Pi settings, so a backup can be put back only while the file still holds it.

A `dir` record is the hash of what the installer wrote. An owned folder is wholly the installer's: each apply removes whatever the layer does not install, printing each removal, and replaces each item with a fresh copy. The hash covers each file's relative path and SHA-256, and each link by its target, and it leaves out `node_modules` and `.git` at any depth. The record holds no absolute path and does not list the lock itself. Re-applying with nothing to change leaves the lock the same except `generatedAt`.

The rule for files the installer generates, stated once. An ownership record covers exactly what the installer wrote, so a file the installer generates in an owned folder is removed unless the layer ships it. Today those are the `package-lock.json` and `npm-shrinkwrap.json` that `npm install` writes beside a layer's `package.json`. An apply removes each one after npm runs, unless the layer's items ship a file of that name in that place. A shipped file is put back after npm, byte for byte, because npm may rewrite it while it installs. The put-back writes only when the bytes differ, so a shipped file that is read-only stays read-only: the attribute is cleared for the rewrite and set again after it. `node_modules` is outside the tree hash, as described under [Excluded folders](#excluded-folders). Any other file that appears in an owned folder changes the hash, so the folder is reported `modified` until the next apply removes the file. When something other than the installer changes a folder during an apply, the apply stops with `holds different content from what the install wrote` and writes no record for it.

```json
"ownedSchema": 2,
"owned": [
  { "path": ".maxstack/bin/copilot.cmd", "kind": "file", "sha256": "…", "runtime": "copilot", "layers": [] },
  { "path": ".claude/cache/pstack", "kind": "dir", "sha256": "…", "runtime": null, "layers": ["pstack"] },
  { "path": ".pi/agent/settings.json", "kind": "json-entries", "key": "packages", "entries": ["../../.claude/cache/pstack"], "runtime": "pi", "layers": ["pstack"] }
]
```

`-Status` compares the record with the disk and with what an apply would write. It writes nothing. It prints one line per path, then a summary:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Status
pwsh -File scripts/Install-Workspace.ps1 -Status -Strict
```

| State | Meaning |
| --- | --- |
| `matching` | It matches the record, and an apply would leave it as it is. |
| `drifted` | It matches the record, but an apply would write something else, such as a layer whose source changed. |
| `modified` | It differs from the recorded hash, target, or entry, usually because of a hand edit. |
| `missing` | The record names it and the disk does not hold it. A Pi entry shows alone when it is missing from its list. |
| `untracked` | A file in `.maxstack\bin` that no record names. |
| `not selected` | A file of a runtime the selection leaves out, or a layer or runtime that `layers.json` names and the selection leaves out, shown with the flag that adds it. Apply leaves files alone, and `-Strict` does not count these. |

`-Status` prints the selection first, then judges only the selected runtimes. The summary counts `not selected` paths after the other states.

`-Strict` exits 1 when any path is not `matching` or `not selected`. A workspace whose lock has no `owned` list prints `no ownership record; run -Apply once to create it`, and exits 0, or 1 with `-Strict`.

Limits of the record:

- Owned folders must not hold user files. `.opencode\plugins\<layer>`, `.claude\plugins\<layer>`, and `.claude\cache\<layer>` belong to the installer: an apply removes any file a user adds to them, and status reports such a file as `modified` until then. Keep your own files elsewhere.
- For a pinned layer, status reads only the local cache. Each path or entry that depends on a pinned commit the cache is not at reports as `drifted`, once, until an apply syncs the cache. An apply also removes untracked files from the cache.
- A backup the next apply would write is not reported until it exists.
- Apply does not remove the agent profiles of a layer that stopped installing them, nor the cache of a removed pinned layer. Those files drop out of the record at the next apply.
- A lock from before the record has no `owned` list, so status reports no record until one apply. That apply takes the entries its `pi` section lists as the installer's, and the claude `treeSha256` values keep the legacy rule, so they do not report `differs` after the upgrade.
- A lock at `ownedSchema: 1` names no runtime or layer for its records, so `-Remove` refuses it until one `-Apply` writes version 2. `-Uninstall` still works from it when it has an `owned` list, because it names each path directly. Its plain `X.bak` is restored as the original while the config still holds the installer's text, and a config with no backup is taken as the installer's, since that lock records no created config. An upgrade apply over such a lock records that config as created in the same way, so the upgraded lock removes it on uninstall.

## Removing and uninstalling

The installer owns only the workspace outputs recorded in `stack.lock.json`. T3 provider instances are configured separately and remain in T3 when you remove a runtime or uninstall the workspace bundle. Uninstall also leaves global provider configuration, authentication, installed binaries, and system plugins alone. It does not promise to remove every plugin from the machine. The T3 settings snapshot is a recorded workspace output; removal preserves it, and uninstall deletes it only while its ownership hash still matches. See [T3 settings snapshot](features/t3-settings.md).

Use `-Remove` with `-Runtimes` or `-Layers` to remove selected recorded outputs and apply the remaining selection. Use `-Uninstall` to remove all recorded workspace outputs. Both use ownership checks and may skip edited or unowned paths; see the rules below and [the T3 setup guide](t3-setup.md) for provider-instance ownership. Neither operation manages the live T3 settings file or global provider configuration.

`-Remove` removes the runtimes or layers it names. `-Uninstall` removes everything the lock records, then the lock files. Both print a plan and write nothing until `-Apply` is given:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Remove -Runtimes pi
pwsh -File scripts/Install-Workspace.ps1 -Remove -Runtimes pi -Apply
pwsh -File scripts/Install-Workspace.ps1 -Remove -Layers simpsonm09-personal-ai-plugin -Apply
pwsh -File scripts/Install-Workspace.ps1 -Uninstall -Apply
```

The rules:

- `-Remove` needs `-Runtimes` or `-Layers`, and `-Uninstall` takes neither. The two switches exclude each other, and neither takes `-Status`. `-Strict` exits 1 when a removal skips anything, in a dry run or an apply.
- `-Remove` needs a lock with `ownedSchema: 2` and an `owned` list, because it picks each record by its runtime and layers. `-Uninstall` needs only an `owned` list, so it also works from an `ownedSchema: 1` lock. A lock with no `owned` list is refused with `it has no owned list`, and a lock at another schema version with `its ownedSchema is N`. Each refusal says to run `Install-Workspace.ps1 -Apply once` and writes nothing. A workspace with no lock but some of the installer's outputs is refused the same way. A workspace with no lock and none of them has nothing to remove, and says so.
- `-Remove` takes each name out of the recorded selection. A name that is not selected removes nothing, and the run says so. It then applies the remaining selection, so a claude junction whose OpenCode copy was removed becomes a copy, and it deletes the records the remaining selection no longer produces.
- `-Remove` refuses a removal that leaves `copilot` or `pi` selected without `claude`, and one that leaves no runtime or no layer. Name each runtime that needs it in the same command, for example `-Remove -Runtimes claude,copilot,pi`, or use `-Uninstall`.
- `-Uninstall` deletes the lock files (`stack.lock.json`, `.bak`, and `.new`) only when nothing was skipped. Otherwise it prints `N items skipped; lock kept; rerun -Uninstall -Apply to retry.` and keeps the lock, with only the records still owed. It exits 0 in that case, and 1 with `-Strict`. `-Remove -Apply` prints the matching line, `N items skipped; lock kept; rerun -Remove -Apply to retry.` When a removal that finishes keeps files on disk, its final line names them, as `Uninstalled: the lock files are removed. Kept on disk, not restored or deleted: <paths>.` Without kept files it says that every recorded path was removed.
- Each run ends with a `Summary:` line that counts each state.
- A second run changes nothing and says `Nothing to remove`.

Each path is printed with one state:

| State | Meaning |
| --- | --- |
| `DELETE` | The record matches the disk, so the installer removes the path. A folder is first renamed to `<name>.maxstack-removing` beside it, then the renamed folder is deleted. |
| `RESTORE` | The installer replaced a file. Its original backup goes back in place, and the backup is removed. A backup whose file already holds its bytes is removed without a copy. |
| `GONE` | The path is already absent, so the record is complete and nothing is deleted. The record leaves the lock. `-Strict` does not count it. |
| `KEEP` | The record is finished, and what is left is not the installer's to delete, such as a folder that holds a user file, a settings file with keys the installer did not write, or a backup copy that is kept. |
| `SKIP` | The disk differs from the record, or the path is not safe to act on, or a folder is in use. Nothing is deleted, and the record stays in the lock. |

The deletion rules. Each one must hold for a path to be deleted:

1. A file is deleted only if its SHA-256 equals the record. A folder is deleted only if its tree hash equals the record, and a record with no hash is a `SKIP`. The tree hash covers each file's relative path and SHA-256, and each link by its target. It leaves out `node_modules` and `.git` at any depth (see [Excluded folders](#excluded-folders)). So a file added to an owned folder, or a changed file outside those two folders, makes the folder a `SKIP` as `modified by hand`.
2. A link is deleted as a link, and only while it points at the recorded target. The target is never read or changed. A junction inside a deleted folder is removed as a link the same way.
3. The Pi settings file loses only the entries the record names, each from the key it was written to, after a strict JSON parse. Every other key and entry stays. A key the installer created is removed once its list is empty. When the installer created the file, and only its empty `packages` and `skills` lists remain, the file is deleted. A file that is not strict JSON (comments, trailing commas, or not an object) is a `SKIP` and is left as it is.
4. A replaced file is put back from its original backup (role `original`, or a plain `X.bak` in a lock from before roles) only while the file still holds the text the last apply wrote, and the backup still holds the bytes its record names. The copy is written beside the file and replaced over it, so a failed restore leaves no copy behind. Otherwise the file is not restored. For the config, a changed config is a `SKIP` that keeps its original, or, for a plain `X.bak` from a lock before roles, a `KEEP` of the config that names the original in the summary. The Pi settings lose only the installer's entries, and the backup is a `KEEP`, or a `SKIP` when the settings are not strict JSON.
5. A folder the installer created is deleted only when it is empty, deepest first. A folder that existed before the install is kept with its user files, and a folder the installer did not record is never deleted.
6. A recorded path must resolve inside the workspace, and no folder on its way may be a junction. A path that fails this is a `SKIP`, with one of three reasons: `outside the workspace: the record does not name a workspace path`, `outside the workspace: the path resolves outside it`, or `outside the workspace: a folder on its path is a junction`. Nothing outside the workspace is read or changed.
7. A removal never touches a file the record does not name. The retired `pstack-opencode` folder, the pinned caches the record does not name, and the user's own files are left alone.
8. The lock is rewritten after each item that finishes, so an interrupted run leaves it listing only what is still owed. A run that stops after a delete, or after a restore, but before its lock write leaves that record in the lock. The rerun reports it as `GONE`: the path is absent, or, for a restored config, the config holds the bytes of its original backup, and the record completes as already restored. A retry finishes the rest.

Backups, in more detail. Only the role `original` copy is restored. Numbered `edited` copies and `user` copies are kept, and the summary names them. A changed original is kept, and a missing one is `GONE`. If the config is missing when the removal runs, its original is kept and the config's record is `GONE`. A removal never deletes a `user` copy.

Before each action, the path is resolved again, its junctions are checked again, and its hash is checked against the plan. A change since the plan is a `SKIP` with the reason `changed since the plan: rerun the command to plan it again`. A Pi settings write re-hashes the file just before it writes, and then writes through a temporary file.

A folder is recorded in the lock with its quarantine name, `<name>.maxstack-removing`, and then renamed to that name before it is deleted. A file held open by another process makes the rename fail, and the folder stays unchanged as a `SKIP` with `in use: could not be renamed`. If a file is held open during the delete, the quarantine stays, the item is a `SKIP` with `in use: part of it could not be deleted; it is quarantined as ...`, and a rerun deletes the quarantine. A rerun resumes a quarantine only when the lock names it for that folder and its tree still has the recorded hash. A plain apply does the same check first: when the journaled hash still matches, it deletes the quarantine before it writes the folder again, and it prints that once. Otherwise it keeps the quarantine and the journal, prints the folder and the reason once, and writes the folder again beside it. Any other folder with that name is a `SKIP` (`in the way`), and it is kept.

Leftover copies. An interrupted write or removal can leave `X.uninstall-restore`, `X.uninstall-replaced`, `X.maxstack-tmp`, or `X.maxstack-old` beside a recorded file `X`. Every apply and removal reports them. A copy whose bytes the lock records for `X`, for its backups, or as the text the installer last wrote is deleted. Any other copy is a `SKIP` with the reason `a leftover copy of X whose bytes the lock does not record, so it is kept`. It stays on disk, and a removal keeps the lock for it. An apply names a quarantine folder that an interrupted removal left, and a removal resumes it through its record.

A `SKIP` is a path the installer cannot account for as its own: a file edited by hand, a folder that changed, a folder in use, or a record that points outside the workspace. The skip names the path and the reason. Fix the cause, and rerun the same command. A file that was deleted by hand is reported as `GONE` by a removal, which drops its record. `-Status` reports it as `missing` until then.

### Excluded folders

`node_modules` and `.git` inside an owned folder are not part of its tree hash. A change under either one does not make the folder a `SKIP`, and a removal deletes each of them with the folder, because they are the installer's copy. Files a user put only in those two folders are deleted too. The plan prints each excluded folder it will delete with its file count and total size, for example `also deletes the excluded folders .claude/cache/pstack/.git (35 files, 36139 bytes)`. A junction under an excluded folder is removed as a link, and its target is kept. A junction under an excluded folder that leads outside the workspace makes the whole owned folder a `SKIP`, with the reason `refused: a junction under ... leads outside the workspace`.

After a partial uninstall the lock still describes the selection, so `verify-workspace-install.py` reports the removed paths as missing until the rerun finishes.

## A legacy global install

The workspace bundle is the only PStack install. If an older global install is ever found, remove it by hand, on Windows under `%USERPROFILE%` and on WSL under `$HOME`. `scripts/verify-workspace-install.py` reports what remains. It checks these paths:

- `.agents/skills` holds no PStack skill (`poteto-mode` or a `principle-*` folder). Other tools, such as the Cursor CLI, install their own skills there, and those are left alone.
- `.config/opencode/AGENTS.md` is absent.
- `.config/opencode/agents/pstack-*.md` are absent.

An old `.config/opencode/opencode.jsonc` may still hold the `model` and `default_agent` lines from that install. Delete the ones it wrote. A model you chose yourself stays.
