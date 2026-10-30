# Workspace settings

## Workspace discovery

The target workspace follows this precedence:

1. `-Workspace <path>`
2. `MAXSTACK_WORKSPACE`
3. The nearest ancestor of the current directory with a `maxstack.settings.json` or `stack.lock.json` file
4. The exact repository layout `projects/repos/<repo>` or `projects/worktrees/<repo>` relative to the workspace
5. The previous fixed default, when it exists

The installer prints `Workspace: <absolute path> (from <origin>)` as its first line after successful resolution. Use the origin to confirm the target. The legacy fallback warns and will be removed after one release. An explicit or environment value that is empty or names a missing directory stops discovery. Relative values resolve from the current directory. A marker symlink may identify a workspace without reading its content; a symlinked settings input is refused by settings validation.

Control characters in workspace paths are rejected before path lookup. Error messages render them as `\uXXXX` text instead of sending raw control bytes to the terminal.

For example, set the environment for repeated commands:

```powershell
$env:MAXSTACK_WORKSPACE = '.'
pwsh -File scripts/Install-Workspace.ps1 -Status
```

`maxstack.settings.json` is an optional, hand-edited file beside `stack.lock.json`. Start from [`workspace/maxstack.settings.json`](../../workspace/maxstack.settings.json), and use [`schemas/maxstack.settings.schema.json`](../../schemas/maxstack.settings.schema.json) for editor completion.

```json
{
  "version": 1,
  "runtimes": {
    "claude": {},
    "opencode": {}
  },
  "layers": {
    "pstack": {},
    "simpsonm09-org-ai-plugin": {}
  },
  "t3": {
    "defaults": "leave-alone"
  }
}
```

The settings file is an input. The installer does not own it and never removes it. The lock stores its canonical SHA-256 in `settings`; it does not add the file to `owned`.

`runtimes` and `layers` are additive: names in the file join the recorded lock selection and command-line flags. A runtime is a harness. An omitted name in a declared dimension remains selected and is reported as `unlisted`; an omitted dimension keeps the recorded selection without an unlisted report. Use `-Remove -Runtimes <name>` or `-Remove -Layers <name>` to remove a selection. A name in the file that is not yet recorded is `pending` and is selected on `-Apply`.

On a new workspace, a named settings dimension selects exactly its listed names. A dimension omitted from the file keeps the current behavior: all names on a new workspace, or the names in the lock. `-Update` stays with the recorded selection. A new selection in the file is reported as pending and needs `-Apply`.

`runtimes.<name>.cli` and `t3.cli` accept `detect` or `install`. They are recorded and validated, but CLI installation is not supported in this release. A runtime is a harness. `layers.<name>.source` uses the `-Source` grammar, plus `local:<workspace-relative-path>` and `default`. A relative local source resolves from the workspace root. It cannot contain a `..` component or resolve through a link outside the workspace. An absolute local source is accepted with a machine-path warning.

Layer source precedence is `-Source` or `-LayerSource`, the settings declaration, a recorded lock override, then the `layers.json` default. Omitting `source` leaves a recorded override in place and reports that it is unlisted. The value `default` drops a recorded override. A source declaration that is missing or unreadable is reported and skipped in read-only modes. Apply stops before writing if its chosen source is unavailable. `-Status` and `-Update` inspect the recorded source and report settings declarations without resolving their git refs.

`-InitSettings` prints a seed derived from the lock selection and recorded source overrides. `-InitSettings -Apply` writes that file only when it is absent. It does not run the installer or resolve sources. It refuses an existing file, folder, or link.

`os` accepts `auto`, `windows`, `macos`, or `linux`. A mismatch is allowed during audit and dry run. Apply refuses a mismatch before source resolution or writes. `t3.snapshot` accepts a boolean. `t3.defaults` accepts `leave-alone` or `apply-defaults`. Defaults application is deferred. See the [T3 settings snapshot](t3-settings.md) guide.

The installer accepts strict UTF-8 JSON, including a UTF-8 BOM, with a 64 KiB and 32-level nesting limit. Comments, trailing commas, duplicate keys, unknown keys, invalid types, and unsupported values fail validation before a write or git command. A directory or a symbolic link at the settings path is refused without reading its target. `-Status` reports a settings error and still reports the lock. `-Remove` and `-Uninstall` do not read this file.

See [Install and reload](../install.md#runtime-and-layer-selection) for the commands and selection overview.
