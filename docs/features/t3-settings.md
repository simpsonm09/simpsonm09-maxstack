# T3 settings snapshot

The installer can read one T3 server settings file from an explicit source. Pass `-T3Settings <file>` or set `MAXSTACK_T3_SETTINGS` to a file path. The command line wins. The installer does not follow `T3CODE_HOME` or guess a profile location.

The snapshot contains only reviewed settings in [the allowlist](../../t3/allowlist.json). Credentials, environment names and values, display names, cosmetic values, model selections, free text, and unknown fields are left out. Paths are reduced to `{workspace}` or `{path}`. Unknown key names may be reported, but their values are never printed or stored.

Audit, apply, and status only read the selected source. Apply writes the sanitized snapshot to `.maxstack/t3/settings.snapshot.json` and records that file in `stack.lock.json`. It never changes T3's settings. Remove preserves the snapshot. Uninstall deletes it only when its ownership hash still matches.

`t3.snapshot: false` disables reading and snapshot comparison. `t3.defaults` accepts `leave-alone` and `apply-defaults`; only `leave-alone` acts in this release. The other value reports that applying defaults is deferred. A runtime is a harness.

Plain `-Status` reports drift without failing. `-Status -Strict` fails on ownership failures, malformed selected input, or T3 states marked strict in the design. Snapshot staleness alone is informational.

The defaults in [t3/defaults.json](../../t3/defaults.json) are report-only. No T3 instance or per-user app default is written. To check the reviewed local T3 contract, pass its source explicitly to `python scripts/verify-manifests.py --t3-contract <path-to-settings.ts>`.
