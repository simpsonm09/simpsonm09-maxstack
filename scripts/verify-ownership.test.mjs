import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.platform === 'win32' ? 'python' : 'python3';

function check(records) {
  const source = `import json\nfrom verify_ownership import check_owned_record\nfailures=[]\nfor i, record in enumerate(json.load(__import__('sys').stdin)):\n    check_owned_record(record, f'owned[{i}]', failures)\nprint(json.dumps(failures))\n`;
  const result = spawnSync(python, ['-c', source], {
    cwd: resolve(repoRoot, 'scripts'),
    encoding: 'utf8',
    input: JSON.stringify(records),
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const fileHash = 'A'.repeat(64);
const common = { kind: 'file', sha256: fileHash, layers: ['org-ai-plugin'] };

test('owned record verifier accepts current installer runtime shapes and rejects malformed claims', () => {
  const valid = [
    { ...common, path: '.codex/config.toml', runtime: 'codex', hookHash: `sha256:${'a'.repeat(64)}` },
    { ...common, path: '.pstack/pstack-t3-instances.json', runtime: 't3-gated-instances' },
    { ...common, path: '.maxstack/workspace-instructions.md', runtime: 'workspace-instructions' },
    { ...common, path: '.maxstack/copilot-instructions/AGENTS.md', runtime: 'workspace-instructions' },
    { ...common, path: '.agents/skills/shared-demo', kind: 'dir', runtimes: ['antigravity', 'codex'], sha256: fileHash },
  ];
  assert.deepEqual(check(valid), []);

  const badPath = { ...valid[0], path: '../outside/config.toml' };
  const badHookHash = { ...valid[0], hookHash: 'sha256:bad' };
  const misplacedHookHash = { ...valid[1], hookHash: `sha256:${'a'.repeat(64)}` };
  const badRuntime = { ...valid[2], runtime: 'future-runtime' };
  assert.ok(check([badPath]).some((failure) => failure.includes('path must be')));
  assert.ok(check([badHookHash]).some((failure) => failure.includes('hookHash')));
  assert.ok(check([misplacedHookHash]).some((failure) => failure.includes('hookHash')));
  assert.ok(check([badRuntime]).some((failure) => failure.includes('runtime must be')));
});
