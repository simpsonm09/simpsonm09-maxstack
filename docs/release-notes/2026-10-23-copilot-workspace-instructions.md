# Copilot workspace instructions

The generated Copilot wrappers now set the documented `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` environment variable when selected layers provide workspace instructions. They point Copilot at an installer-owned `.maxstack/copilot-instructions/AGENTS.md` projection, which remains available when Copilot starts in a nested repository or a user-owned root `AGENTS.md` prevents generation at the workspace root. Both wrappers retain an existing comma-separated directory list and continue passing their plugin folders and caller arguments. A projected instruction path containing a comma is rejected because the variable has no documented escape syntax. Planning also rejects `!` in that path because cmd delayed expansion can remove it. Validation runs before installer writes, including when the Copilot CLI is absent.

Offline Windows `cmd` and POSIX `sh` fake-CLI fixtures verify the environment and argument projection, including an apostrophe and spaces in the POSIX workspace path, user-file preservation, and projection ownership cleanup. This does not prove that T3's registry ACP inherits the wrapper environment or that a live Copilot session consumes the projected instructions. Fresh T3 ACP and Copilot CLI acceptance remains pending.

See [T3 setup](../t3-setup.md) and [current alignment](../features/current-alignment.md).
