# maxstack

Personal AI tooling for OpenCode, Claude Code, GitHub Copilot CLI, and Pi, run from T3 Code. It coordinates the workspace config and the installer, and it pins the PStack plugin. maxstack sets no model: you pick the model in the harness.

The original lives in `simpsonm09-org/simpsonm09-maxstack`; work happens on the personal fork. See [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

## What it does

`maxstack` owns AI composition for the `D:\dev\simpsonm09` workspace. It holds the workspace config fragment, the ordered layer manifest, and the installer. `simpsonm09-dev-setup` owns the machine and the human tool set, including a self-hosted Infisical Agent Vault that brokers service credentials for the agent. A wrapper is the entry point: `with-secrets <tool>` for the human loader path, and `with-vault --role human <tool>` or `with-vault --role agent <tool>` for the vault path. See [`docs/relationship.md`](docs/relationship.md).

PStack comes from one source: the `plugins/pstack` folder of [`simpsonm09/pstack-claude`](https://github.com/simpsonm09/pstack-claude), at the commit in [`pstack.lock.json`](pstack.lock.json). `layers.json` lists it once, with its runtimes. The installer builds each runtime from that pin:

- OpenCode: `.opencode\plugins\pstack`, with the agent profiles in `.opencode\agents`.
- Claude Code: `.claude\plugins\pstack`.
- GitHub Copilot CLI: `.maxstack\bin\copilot.cmd` and `copilot.sh`, which run Copilot with the Claude plugin folders.
- Pi: `.maxstack\bin\pi.cmd` and `pi.sh`, which run Pi with the settings in `.pi\agent`, listing the same layers as packages and skills.

The org and personal layers are local checkouts. They install for the same four runtimes, and their Claude folders are links to the OpenCode copies. Nothing is global. See [`docs/t3-setup.md`](docs/t3-setup.md). The plan to maintain one master source for seven runtimes is in [`docs/master-template.md`](docs/master-template.md), and the standalone layer generator is described in [`docs/neutral-layer-generator.md`](docs/neutral-layer-generator.md).

## Guardrails

- Never commit API keys, OAuth tokens, OpenCode auth storage, session databases, or local app state.
- Keep PStack scoped to `D:\dev\simpsonm09`. Do not install it globally.
- Edit the plugin in the fork, `simpsonm09/pstack-claude` under `plugins/pstack`, never the installed copies.
- Test changes in a disposable project before relying on them.

## Quick start

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

After an install, restart the running OpenCode server before using a new T3 session: T3 can reuse that server across sessions, so a new session alone does not reliably reload plugins or skills. Claude Code reads the plugin folder at session start. Copilot reads its plugin folders each time it starts. See [`docs/install.md`](docs/install.md).

## Commands

| Command | Does |
| --- | --- |
| `just lint` | Runs the linters over changed files. |
| `just lint-full` | Runs the linters over every tracked file. |
| `just aislop` | Runs the AI-slop gate. |
| `just security` | Scans the filesystem with Trivy. |
| `just validate` | Validates the workspace manifests the installer consumes. |
| `just validate-online` | Also checks the pstack pin against GitHub. Needs `git` and network. |
| `just check` | Runs lint and validate. |

## Documentation

Read [`docs/README.md`](docs/README.md) for the layout, the model rule, the MCP servers, and the installer.

## License

MIT. See [`LICENSE`](LICENSE).

## Related repositories

- [`simpsonm09/pstack-claude`](https://github.com/simpsonm09/pstack-claude) (fork) owns the PStack plugin in `plugins/pstack`, for all four runtimes.
- [`org-ai-plugin`](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin) owns the shared MCP servers and skills.
- [`personal-ai-plugin`](https://github.com/simpsonm09-org/simpsonm09-personal-ai-plugin) owns the personal MCP servers and skills.
- [`simpsonm09-dev-setup`](https://github.com/simpsonm09-org/simpsonm09-dev-setup) owns the machine and app setup.
- [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard) owns the shared CI, linting, security, and governance.
- [`repo-template`](https://github.com/simpsonm09-org/simpsonm09-repo-template) is the generated-repo starting point.
