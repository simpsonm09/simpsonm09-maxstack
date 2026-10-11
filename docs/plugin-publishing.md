# Plugin publishing

This repository does not own the PStack plugin. [`simpsonm09/pstack-claude`](https://github.com/simpsonm09/pstack-claude), branch `feat/opencode-runtime`, is the source of truth. Its `plugins/pstack` folder holds the plugin for three runtimes: Claude Code (`.claude-plugin`), GitHub Copilot CLI (`.github/plugin`), and OpenCode (`opencode/`, with the shared `skills/` tree beside it). `maxstack` pins one commit of that folder and assembles the bundle each runtime loads.

## Inputs

- `layers.json` is the ordered layer manifest. Each layer has a `name`, which is its plugin id, and a `kind` (`plugin` or `config`). Its `source` is either a local checkout, a URL string with a `path` under the workspace, or a git pin, an object with `url`, `path`, `commit`, and `ref`.
- A layer's `runtimes` map names the runtimes it installs for. Each key is optional, and each runtime needs its prerequisite: `copilot` and `pi` need `claude`, because the wrapper runs the Claude folder and Pi reads its skills there, and a local layer's `claude` needs its `opencode` copy, because the Claude folder links to it.
  - `claude: {}` installs `.claude\plugins\<name>`. A local layer links to its OpenCode copy. A git layer is a copy of its pinned folder. Each folder must carry `.claude-plugin/plugin.json` with the same name.
  - `opencode: { entry, agents, files }` installs `.opencode\plugins\<name>`. `entry` is the file OpenCode loads, `index.ts` by default. `agents` names a folder of profiles that are copied to `.opencode\agents`. `files` names the items to copy, as a layer's `layer.json` `files` list does for a local layer.
  - `copilot: {}` adds the layer's Claude folder to `.maxstack\bin\copilot.cmd` and `copilot.sh`, in layer order.
  - `pi: {}` lists the layer's skills folder in `.pi\agent\settings.json`. The layer is also a Pi package when its `package.json` has a `pi` key. A pinned layer's package is the root of its cache, because the key names paths from the repository root. A local layer's package is its installed Claude folder, so each path the key names must be in the layer's `files` list.
- `pstack.lock.json` is the one pin for the pstack plugin: the repository, the `path`, the `commit`, and the `ref` the commit came from. It must agree with the pstack layer's `source` in `layers.json`.
- `workspace/opencode.jsonc` is the config base. Layer fragments supply the MCP servers and extra permissions.
- The installer sets no model. It writes no `model` or `small_model` key into the workspace config, and it removes any `model:` line from each agent profile it copies. The user picks the model in the harness.

## Entries OpenCode loads

OpenCode loads a folder under `.opencode\plugins` on its own only when that folder's `index.ts` is at its root. An entry in a subfolder, such as the fork's `opencode/index.ts`, is not loaded that way. The installer therefore names such an entry in the `plugin` list of `opencode.jsonc`, as a folder path relative to the config file:

```jsonc
"plugin": ["./.opencode/plugins/pstack/opencode"]
```

The entry resolves its shared skills beside its own folder, so the installed folder keeps `opencode/` and `skills/` together. A root `index.ts` needs no entry in the list.

## Assembly

`scripts/Install-Workspace.ps1` runs in audit mode by default and changes nothing. With `-Apply` it:

1. Checks each local checkout exists. For a git source it fetches the pinned commit into `.claude\cache\<name>` and checks it out. The cache's origin is set to the layer's url on each sync, so a cache cloned from another remote is never fetched from. A pin the remote cannot supply stops the run here, before anything is written.
2. Validates each runtime block. A runtime without its prerequisite, an unknown runtime name, or an entry that is not a file under the folder stops the run.
3. Merges every config layer's `opencode.fragment.jsonc` and writes `opencode.jsonc`, with the `plugin` list for nested entries. A backup of the previous file is kept.
4. For each layer with an `opencode` runtime, copies the named items into `.opencode\plugins\<name>`, runs `npm install --ignore-scripts` in the entry's folder when that folder has a `package.json` and no SDK, then removes the `package-lock.json` or `npm-shrinkwrap.json` that npm wrote there (a file of either name that the layer ships stays as shipped; see [Ownership and status](install.md#ownership-and-status)), and copies each `agents/*.md` profile to `.opencode\agents` with any model line removed. It then checks that the entry exists.
5. Removes the folders under `.opencode\plugins` that no layer names and that the previous lock recorded. It always removes the folder of the retired `pstack-opencode` port. Any other unnamed folder is reported and kept.
6. Builds `.claude\plugins`. A local layer becomes a junction to its installed copy, so both harnesses share it. A git layer becomes a copy of its pinned folder. A child that no layer declares is removed.
7. Writes `.maxstack\bin\copilot.cmd` and `copilot.sh`. The executable is the first `copilot` application outside `.maxstack\bin`, found with `Get-Command` or the `-CopilotCommand` override. With no executable, both wrappers are skipped with a message, and any old wrapper is removed.
8. Checks each `pi` key's paths against the installed copy. Then it writes `.pi\agent\settings.json`, replacing only the `packages` and `skills` entries it wrote last time, and `.maxstack\bin\pi.cmd` and `pi.sh`, by the same rule as the Copilot wrappers, with `-PiCommand` as the override.
9. Writes `stack.lock.json` at the workspace root.

`--ignore-scripts` has no opt-out. A layer's own `preinstall`, `install`, and `postinstall` scripts never run, and neither does a `binding.gyp` native build, so a layer that needs one must ship what the script or build would produce. Each run that calls npm prints `npm ran with --ignore-scripts for layer '<name>'` for each layer that declares one of them, and names what did not run.

Audit mode computes each of these and reports `missing`, `differs`, `matches`, or `stale`. It writes nothing and reads no git source. An OpenCode folder differs when its entry, plugin path, or recorded state changed. A Claude child differs when it is missing, is not the expected link or copy, has a tree hash other than the one the last apply recorded, or its git commit has moved. A Copilot wrapper differs when its text is not what the installer would write.

## The recorded lock

`stack.lock.json` is the install-provenance record. `Install-Workspace.ps1` writes it at the workspace root, not in this repository. It records `generatedAt`, the SHA-256 of the written workspace config, the Copilot wrapper record, and one entry per layer with its `name`, `kind`, `path` (null for a git layer), `source` (the source block that [install.md](install.md#layer-sources) describes), and installed `commit`. Each layer has three runtime records, and a runtime the layer does not name has `enabled: false`.

- `claude`: a local layer has `enabled`, `plugin`, `kind: "junction"`, `child` (`.claude/plugins/<name>`), `target` (`.opencode/plugins/<name>`), and `treeSha256`. A git layer has `enabled`, `plugin`, `kind: "git"`, `child`, `repository`, `path`, `commit`, and `treeSha256`.
- `opencode`: `enabled`, `folder` (`.opencode/plugins/<name>`), `entry`, `loader` (`discovery` for a root `index.ts`, `config` for a nested entry), `plugin` (the path named in `opencode.jsonc`, or null), and `agents` (the profile names installed).
- `copilot`: `enabled` and `pluginDir` (`.claude/plugins/<name>`).

The top-level `copilot` record holds `enabled`, and when enabled, the `executable` file name, the `wrappers` relative paths, and the SHA-256 of each wrapper's text. When it is disabled, it holds the `reason`. The executable's absolute path is not recorded, because the lock holds no absolute path. It is written only into the wrapper.

`treeSha256` is the legacy claude hash: one line per entry, the relative path and SHA-256 of each file, sorted by UTF-8 bytes. It leaves out only a top-level `node_modules`, matched without regard to case, as earlier versions did. A link inside the tree is hashed by its target and never followed. The owned hashes in `owned` use a stricter rule and are described in [Ownership and status](install.md#ownership-and-status): `node_modules` and `.git` are left out at any depth, and names compare exactly. The lock holds only workspace-relative paths, so it holds no absolute path. The junction's target is an absolute path inside the filesystem, but the installer creates it on each apply and the lock does not record it.

## Generated files and git

The generated files live at the workspace root, which is not a git repository, so no repository in this set tracks them. The root `.gitignore` covers the installer output. The runtime folders need these entries there, `.claude/plugins/`, `.claude/cache/`, `.opencode/plugins/`, and `.maxstack/bin/`. See [T3 setup](t3-setup.md#generated-files-and-git).

## Validation

`.github/workflows/ci.yml` runs `scripts/verify-manifests.py` in the `validate` job. The script checks that `layers.json`, `pstack.lock.json`, and `workspace/opencode.jsonc` agree with each other and with the installer, without reaching the network. It checks each layer's runtime names and their prerequisites, that each OpenCode entry is a file the folder can hold, that the pstack source and its pin name the same commit, and that the retired `pstack-opencode.lock.json` is gone. `scripts/verify-manifests.test.mjs` runs the script on changed copies of the manifests, so each check has a case that fails.

`python scripts/verify-manifests.py --online` also runs `git ls-remote` to confirm the pinned branch still points at the pinned commit. Run it from a machine with network access. CI does not run `--online`.

`python scripts/verify-workspace-install.py` checks an installed workspace against `stack.lock.json`, and each path in its `owned` list against the disk. The ownership record itself, and the `-Status` report that reads it, are described in [Ownership and status](install.md#ownership-and-status). `python scripts/verify-manifests.py --lock <path>` checks the shape of a record without a workspace. For each runtime it checks the files on disk: the Claude folders, the OpenCode folders and entries, the nested entries the config names, the agent profiles with no model line, the pstack skills, and the Copilot wrappers against their recorded hashes, switch, plugin folders, and executable. It also reports any folder the lock does not record, and any leftover marketplace, settings, or retired port folder.

## Publishing a new bundle

1. Merge the plugin change in `simpsonm09/pstack-claude` and note the commit on `feat/opencode-runtime`.
2. Update `commit` in the pstack layer's `source` in `layers.json`, and `commit` in `pstack.lock.json`. Update `ref` too, if the branch moved. Run `python scripts/verify-manifests.py`.
3. Run `pwsh -File scripts/Install-Workspace.ps1 -Apply`.
4. Restart the running OpenCode server, then start a new T3 session. T3 can reuse an OpenCode server across sessions, so a new session alone does not reliably reload plugins or skills. Claude Code reads `.claude/plugins` when it starts, and Copilot reads its plugin folders when it starts. Then run `pwsh -File scripts/verify-opencode-workspace.ps1` and `python scripts/verify-workspace-install.py`.

Merge a layer's manifest changes in its own repository before a `claude` or `copilot` runtime that names it lands here. The Copilot runtime needs the layer's `.github/plugin/plugin.json` in the installed folder, so a layer's `files` list, or its `layer.json`, must name `.github/plugin` as well. Until a layer's `.claude-plugin/plugin.json` is on the checkout the installer reads, both audit and `-Apply` stop with a clear error. The checks run before any file is written, so a failure leaves the workspace unchanged.
