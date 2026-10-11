# Layout

- `AGENTS.md` sets working rules for changes to this repository.
- `layers.json` is the ordered layer manifest. Each layer is described once: its `name` (the plugin id), its `kind`, its `source`, and a `runtimes` map. The `pstack` layer's source is a git pin into the fork. The org and personal layers are local checkouts with a `path` and a git URL. A layer lists the runtimes it installs for: `claude`, `opencode`, and `copilot`.
- `.github/workflows/ci.yml` calls the shared `repo-standard` checks and runs the manifest validation. `mise.toml` pins the linters.
- `justfile` is the local task runner; its recipes mirror the CI checks.
- `pstack.lock.json` is the one pin for the pstack plugin: the fork, the `path` inside it, the commit, and the branch it came from. `scripts/verify-manifests.py --online` checks that the branch still points at the commit.
- `workspace/opencode.jsonc` is the workspace config base: default agent, permissions, and the MCP startup timeout. It sets no model. Layer fragments supply the MCP servers, and the installer names each nested OpenCode entry in the `plugin` list.
- `docs/mcp.md` defines the workspace MCP servers and their default states. `docs/mcp-installation-guide-v2.md` is the original source guide.
- `docs/plugin-publishing.md` describes how the installer assembles each runtime and records it in `stack.lock.json`, and how CI validates it.
- `docs/t3-setup.md` is the T3 setup: OpenCode needs nothing extra, Claude Code needs a provider instance whose launch arguments pass `--plugin-dir` to the generated `.claude\plugins` folder, Copilot needs a provider instance that starts the generated `copilot.cmd`, and Pi needs a provider instance that starts the generated `pi.cmd`.
- `docs/relationship.md` names how `maxstack`, the plugin layers, and `simpsonm09-dev-setup` fit together, and defines the workspace by behavior.
- `scripts/Install-LayerSources.ps1` holds the layer-source rules that `Install-Workspace.ps1` dot-sources: the `-Source` specs, how each layer's source resolves, the source record in the lock, and the `-Update` report.
- `scripts/Install-Workspace.ps1` reads `layers.json` and, for each layer, builds the runtimes it lists: the Claude plugin folders in `.claude\plugins`, the OpenCode plugin folders in `.opencode\plugins` with their agent profiles in `.opencode\agents`, the Copilot and Pi wrappers in `.maxstack\bin`, and the Pi settings in `.pi\agent`. It merges the config fragments into `opencode.jsonc` and records the result in `stack.lock.json`.
- `scripts/check-agent-tools.mjs` checks that the agent tool set in `simpsonm09-dev-setup` covers the service owners the org integration registry names. It is workspace-local and reads the sibling checkouts, so CI does not run it.
- `scripts/Invoke-OpenCode.ps1` is the bounded OpenCode call the verifiers share: a time limit, a process-tree kill, and a message that names the command.
- `scripts/verify-*` verify the installed workspace bundle. `scripts/verify-opencode-workspace.ps1` checks what a fresh OpenCode process resolves from the workspace, with no server. `scripts/verify-workspace-skill.ps1` runs a bounded OpenCode session that loads a skill. `scripts/verify-workspace-install.py` also checks the generated Claude, OpenCode, Copilot, and Pi files against `stack.lock.json`.
- `docs/decisions.tsv` is the append-only decision trail. `docs/setup-plan.md` is the historical setup plan.
