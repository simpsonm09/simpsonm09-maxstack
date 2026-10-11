# Neutral layer generator

The generator projects the skills and OpenCode MCP servers of layer checkouts into a dedicated output directory for one runtime. It is a standalone step. It does not select layers, write a workspace, or change the installer. Installation stays with `scripts/Install-Workspace.ps1`.

## Usage

```bash
just generate-layers <runtime> <out> '<root>;<root>' [--check]
node scripts/generate-layers.mjs --runtime <claude|copilot|opencode|pi> --out <dir> --layers <root> [--layers <root>...] [--check]
```

- The `just` recipe quotes each argument for its shell: PowerShell on Windows, POSIX `sh` elsewhere. Paths may therefore contain spaces and apostrophes.
- `--runtime` is one of `claude`, `copilot`, `opencode`, or `pi`.
- `--layers` repeats. A value may hold several roots separated by `;`, except that a value which is itself an existing directory (or `name=<existing directory>`) is one root, so a directory name may contain `;`. A root may be `name=path`. Without a name, the layer is named after its folder. Names are lowercase letters, digits, and hyphens.
- Order is precedence. A later layer overrides an MCP server of the same name.
- `--check` plans and compares. It writes nothing, and it exits 1 on any difference.
- Exit 0 on success. Exit 1 on any refusal or failure, with the reason on stderr.

## Inputs

A layer may contain:

- `skills/<skill>/`. Each directory directly under `skills/` is one skill. It must contain a file named exactly `SKILL.md`. The frontmatter `name` must equal the folder name, `description` must be non-empty, and a `model` key is refused because maxstack sets no model. The reader is tolerant. It reads only those three lines, and it does not parse YAML. Dotfiles at the top of `skills/` are ignored. Other loose files there are ignored with a warning. A `node_modules` directory inside a skill is not copied.
- `.claude-plugin/plugin.json`, optional. Its `name` must equal the layer name, and it follows the same JSON rules as the fragment.
- `opencode.fragment.jsonc`, optional. It must be strict JSON whose only key is `mcp`. JSON files may not start with a byte order mark, and their whitespace is only space, tab, CR, and LF. Within the fragment, `mcp.servers` is in the OpenCode V2 shape: `{"type": "local", "command": [...]}` or `{"type": "remote", "url": "..."}`, plus optional `"disabled": true`. Environment and header references are refused. A URL must be `http` or `https`, with no whitespace, no control characters, and no credentials. Duplicate keys are refused.

A root must contain at least one of `skills/`, `.claude-plugin/plugin.json`, or `opencode.fragment.jsonc`. Otherwise it is refused as not a layer. Only then may `skills/` be absent, which means the layer has no skills.

A `neutral-layer.json` is refused, because this generator does not read one. `layer.json` is not read either.

## Outputs

Paths are relative to `--out`.

| Runtime | Skills | MCP |
| --- | --- | --- |
| `claude` | `.claude/plugins/<layer>/.claude-plugin/plugin.json` and `.claude/plugins/<layer>/skills/<skill>/**` | Any server is refused |
| `copilot` | Same as `claude` | Any server is refused |
| `opencode` | `.opencode/skills/<skill>/**` | `opencode.jsonc` with `mcp.servers` |
| `pi` | `.pi/agent/skills/<skill>/**` | Any server is refused |

- Every skill file is a byte copy of its source, `SKILL.md` included. No frontmatter is rewritten.
- Skill names must be unique across layers for `opencode` and `pi`, which discover skills by bare name.
- No MCP means no servers file. Instruction files are not generated, because no layer declares any.
- `generator.owned.json` records `{version, runtime, owned}`. Each record is `{path, sha256, layers}` with an uppercase SHA-256. Records are sorted by UTF-8 bytes, and each record's layers are sorted too. The file never lists itself.

## Ownership and removal

Existing output is adopted only through `generator.owned.json`.

- A file that is neither planned nor owned is refused, and nothing changes.
- An owned file whose bytes no longer match its hash is refused.
- An owned record outside the runtime's namespace is refused. The namespace is `.claude/plugins/` for `claude` and `copilot`, `.opencode/skills/` and `opencode.jsonc` for `opencode`, and `.pi/agent/skills/` for `pi`.
- An owned record under `.claude/plugins/<layer>/` must name that layer in its `layers`.
- A stale owned file is removed only when the plan no longer produces anything in its scope. The scope is its skill folder, or its layer folder for plugin files. If the plan still produces that scope, the file is refused and the output must be regenerated into a clean directory. A forged record inside a surviving skill cannot be told apart from a retired asset, so the generator refuses both.

Known limit: ownership is caller-trusted, not authenticated. A forged record inside a skill or layer that no longer exists is removed. Installer integration must translate these paths and record created directories itself.

## Output safety

- Everything is planned and validated in memory before the first write.
- `--out` must not be a device, extended-length, or UNC path. Its parent must already exist, and the generator creates only the output directory itself.
- No link (symbolic link or junction) may appear in `--out` or in a layer root, judged as written. Below the root, every path the generator reads is checked component by component, so a junction at the manifest directory, the fragment, or any skill folder is refused. The overlap check compares canonical identities, so an 8.3 alias or a junction cannot hide an overlap.
- `--out` must not equal, contain, or sit inside any layer root. It must not be beneath `.git`, or beneath a folder that holds `.git`, `stack.lock.json`, or `maxstack.settings.json`.
- Hard-linked output files are refused.
- Apply writes `.generator-incomplete` before its first change. It writes each file to a temporary sibling and renames it. Stale files are removed first, then empty folders they leave are removed, and `generator.owned.json` is written last. After a clean finish the marker is deleted. An in-process error restores every prior byte from memory and then deletes the marker. A hard kill leaves the marker behind, and then both apply and `--check` refuse with "regenerate into a clean output directory".

## Limits

- The generator does not validate, parse, or translate skill frontmatter for any runtime. Each runtime reads its own frontmatter.
- Nonempty MCP is projected only for OpenCode. Claude, Copilot, and Pi refuse it until their delivery is verified.
- Instructions, agents, and hooks are not projected.
- Runtime discovery, installer wiring, and removal of a previous install are not tested here.
- Concurrent writers to the output directory are not guarded.

## Tests

- `scripts/generate-layers.test.mjs` uses temporary fixtures under the system temp directory. Its junction and 8.3 tests skip with a stated reason when the host cannot create them.
- `scripts/generate-layers.integration.test.mjs` projects three real layers, read only, and checks that every skill and asset is a byte copy. It also runs the installer against temporary stub layers under the same byte check. Set `MAXSTACK_TEST_LAYER_ROOTS` to a JSON array of the three roots, and set `MAXSTACK_REQUIRE_TEST_LAYER_ROOTS=1` so a missing root fails instead of skipping.

```bash
MAXSTACK_REQUIRE_TEST_LAYER_ROOTS=1 MAXSTACK_TEST_LAYER_ROOTS='["<org>","<personal>","<pstack>"]' node --test scripts/generate-layers*.test.mjs
```
