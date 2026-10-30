# Task: update maxstack docs from verified OpenCode host evidence

Worktree maxstack-opencode-host-acceptance, branch docs/opencode-host-acceptance,
base 416c8e22adab5880769397ceca52ef328ea6a0b8 (main, PR #84).

## Steps

1. Inspect worktree list and create the new branch and worktree from exact main. done
2. Read repo-standard, repo-tasks, technical-writing, AGENTS.md, docs/manifest.json, and the source docs. done
3. Read only the private evidence allowed: REVIEW.md. done
4. Update docs/features/current-alignment.md, docs/t3-setup.md, and docs/parity-matrix.md. done
5. Run safe checks: just validate and git diff --check. just lint skipped: flint is not installed and mise would install it (no installs).
6. Report candidate branch, worktree, base, files and reasons, checks, and gaps. No commit, no push, no PR.

## Constraints

- No commit, push, PR, cleanup, delete, reset, force. No GitHub writes.
- No network or model calls. No server start, restart, or credential rotation.
- No tool or dependency installs. No full test, installer, Codex, node shard, or macOS suites.
- Keep temp paths, machine paths, secrets, and raw transcripts out of the docs.
