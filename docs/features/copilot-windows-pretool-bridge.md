# Copilot Windows PreToolUse bridge

Maxstack pins PStack at `671d84b7eb799c2c38ec39b11deac54a45d524fb`. That source declares a Windows Copilot `PreToolUse` command which runs `pre-tool-use-windows.ps1`. The adapter normalizes Windows paths, locates Git for Windows shell tools, invokes the shared `pre-tool-use.sh`, and forwards successful output. Its setup and runtime errors, and its internal 8-second kill timeout, fail open with a silent exit 0 and no decision. Copilot declares a separate 10-second hook timeout; Copilot's handling of no decision and whether its timeout fires are unverified. The pinned source test asserts Windows task-deny output parity with POSIX, but the test was not run here and Windows behavior remains unverified.

The installed adapter file has SHA-256 `F7BAE5BC709CDEB0461A731D021D66C696435710B31C79237CCFEE0E333D1147`, matching the pinned source. The pinned Git blob is `c4cb6f8ff34ef6d41acd4c97b847c83a6ae7d38e`. This evidence covers one installed file only, not the whole plugin or its installed routing.

PStack owns the Windows adapter test. It runs the actual PowerShell adapter with synthetic payloads and compares its output with the shared hook. The test was not run for this Maxstack change because Bun was unavailable. The fixture is Windows-specific and needs Git for Windows shell tools for its shared-hook comparison. Maxstack does not copy the adapter or depend on a sibling PStack checkout.

No evidence shows that Copilot or T3 loads or invokes the hook. Do not treat the bridge as live-verified. PStack's permission and model checks are separate from the organization access gate; the fail-open behavior does not establish parity with that gate. Evidence for one does not establish the other.
