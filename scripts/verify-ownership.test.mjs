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

function checkLock(lock) {
  const source = `import json, sys\nfrom verify_ownership import check_owned\nfailures=[]\ncheck_owned(json.load(sys.stdin), failures)\nprint(json.dumps(failures))\n`;
  const result = spawnSync(python, ['-B', '-E', '-c', source], {
    cwd: resolve(repoRoot, 'scripts'),
    encoding: 'utf8',
    input: JSON.stringify(lock),
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

test('check_owned attributes only the exact Windows Pi self-updater path to Pi', () => {
  const record = {
    kind: 'file',
    path: '.maxstack/bin/pi-self-update.mjs',
    runtime: 'pi',
    sha256: fileHash,
    layers: ['org-ai-plugin'],
  };
  const syntheticWindowsLock = {
    ownedSchema: 2,
    layers: [{ name: 'org-ai-plugin' }],
    selection: { runtimes: ['claude', 'pi'], layers: ['org-ai-plugin'] },
    owned: [record],
  };
  assert.deepEqual(checkLock(syntheticWindowsLock), []);

  for (const runtime of ['claude', 'copilot']) {
    const failures = checkLock({ ...syntheticWindowsLock, owned: [{ ...record, runtime }] });
    assert.ok(failures.some((failure) => failure.includes(`runtime is ${runtime}, but its path belongs to pi`)));
  }

  for (const path of ['.maxstack/bin/future-updater.mjs', '.maxstack/bin/pi-self-update.mjs.bak']) {
    const failures = checkLock({ ...syntheticWindowsLock, owned: [{ ...record, path }] });
    assert.ok(failures.some((failure) => failure.includes('runtime is pi, but its path belongs to None')));
  }
});
