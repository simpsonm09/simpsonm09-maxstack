# Copilot Windows PreToolUse bridge

Maxstack pins PStack at `671d84b7eb799c2c38ec39b11deac54a45d524fb`. That source declares a Windows Copilot `PreToolUse` command which runs `pre-tool-use-windows.ps1`. The adapter normalizes Windows paths, locates Git for Windows shell tools, invokes the shared `pre-tool-use.sh`, and forwards successful output. The installed adapter file was checked against the selected source file; this does not verify the whole installed plugin.

PStack has a named Windows adapter test in its owning repository. It exercises the actual PowerShell adapter using synthetic payloads and compares output with the shared hook. That test was not run for this Maxstack change because Bun is unavailable in the environment. Maxstack does not copy or vendor the adapter into a sibling-repository-dependent fixture.

No evidence here shows that Copilot or T3 loads or invokes the hook. Do not treat the bridge as live-verified. The PStack permission/model hook is separate from the organization access gate; evidence for one does not establish the other.
