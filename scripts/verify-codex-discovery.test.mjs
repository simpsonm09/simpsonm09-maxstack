import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseArgs, runDiscoveryCheck, summarizePromptInput } from './verify-codex-discovery.mjs';

const SENTINEL = 'MARKER_AGENTS_SENTINEL=fixture-only-7c2a';
const SCRIPT = fileURLToPath(new URL('./verify-codex-discovery.mjs', import.meta.url));

function makeFakeCli(base, { defaultHasSentinel = false, explicitHasSentinel = true, version = 'codex-cli 9.8.7' } = {}) {
  const fakePath = join(base, 'fake Codex & probe.mjs');
  writeFileSync(fakePath, `
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
    const explicit = args[0] === '-c';
    const expected = explicit
      ? args.length === 4 && args[1] === 'project_root_markers=["stack.lock.json"]' && args[2] === 'debug' && args[3] === 'prompt-input'
      : args.length === 2 && args[0] === 'debug' && args[1] === 'prompt-input';
    if (!expected) process.exit(19);
    const hasSentinel = explicit ? ${explicitHasSentinel} : ${defaultHasSentinel};
    console.log(JSON.stringify({ text: hasSentinel ? 'MARKER_AGENTS_SENTINEL=fixture-only-7c2a' : 'nested instructions' }));
  `, 'utf8');
  return fakePath;
}

test('prompt summary reports only the fixture sentinel, both absent and present', () => {
  assert.deepEqual(summarizePromptInput({ nested: ['ordinary text'] }), { agentsSentinelPresent: false });
  assert.deepEqual(summarizePromptInput({ instructions: [{ text: SENTINEL }] }), { agentsSentinelPresent: true });
});

test('arguments require an explicitly selected CLI and bound timeout values', () => {
  assert.throws(() => parseArgs([]), /--codex is required/);
  assert.throws(() => parseArgs(['--codex', 'codex', '--timeout-ms', '1']), /between 100 and 120000/);
  assert.deepEqual(parseArgs(['--codex', 'C:\\Codex\\codex.exe', '--timeout-ms', '500']), {
    codex: 'C:\\Codex\\codex.exe', timeoutMs: 500,
  });
});

test('missing CLI is unsupported and never reports a pass', async () => {
  const result = await runDiscoveryCheck({ codex: join(tmpdir(), 'codex-that-does-not-exist.exe') });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.pass, false);
  assert.equal(result.diagnostic, 'missing-cli');
});

test('fake CLI receives literal arguments without shell interpolation and reports sentinel contrast', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'codex-fixture-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fakePath = makeFakeCli(base);
  const result = await runDiscoveryCheck({ codex: fakePath, timeoutMs: 1000, tempRoot: base });
  assert.equal(result.status, 'pass');
  assert.equal(result.cliVersion, 'codex-cli 9.8.7');
  assert.deepEqual(result.proof, { defaultSentinelAbsent: true, explicitMarkerSentinelPresent: true });
  assert.deepEqual(Object.keys(result).sort(), ['cliVersion', 'diagnostic', 'pass', 'proof', 'status']);
});

for (const scenario of [
  { name: 'default includes the sentinel', defaultHasSentinel: true, explicitHasSentinel: true },
  { name: 'explicit marker omits the sentinel', defaultHasSentinel: false, explicitHasSentinel: false },
]) {
  test(`marker semantic mismatch fails when ${scenario.name}`, async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'codex-mismatch-test-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const fakePath = makeFakeCli(base, scenario);
    const result = await runDiscoveryCheck({ codex: fakePath, timeoutMs: 1000, tempRoot: base });
    assert.equal(result.status, 'fail');
    assert.equal(result.pass, false);
    assert.equal(result.diagnostic, 'marker-mismatch');
    assert.notDeepEqual(result.proof, { defaultSentinelAbsent: true, explicitMarkerSentinelPresent: true });
  });
}

test('public output does not expose an untrusted version string containing a synthetic path', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'PRIVATE_PATH_SENTINEL_codex-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const syntheticPath = join(base, 'PRIVATE_PATH_SENTINEL');
  const fakePath = makeFakeCli(base, { version: `codex-cli 9.8.7 ${syntheticPath}` });
  const run = spawnSync(process.execPath, [SCRIPT, '--codex', fakePath], { encoding: 'utf8', shell: false, windowsHide: true });
  const publicOutput = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 2);
  assert.equal(publicOutput.includes('PRIVATE_PATH_SENTINEL'), false);
  assert.equal(publicOutput.includes(base), false);
  assert.deepEqual(JSON.parse(run.stdout), {
    status: 'unsupported', pass: false, cliVersion: null,
    proof: { defaultSentinelAbsent: false, explicitMarkerSentinelPresent: false },
    diagnostic: 'invalid-version',
  });

  const badArguments = spawnSync(process.execPath, [SCRIPT, '--PRIVATE_PATH_SENTINEL', syntheticPath], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.equal(badArguments.status, 2);
  assert.equal(`${badArguments.stdout}${badArguments.stderr}`.includes('PRIVATE_PATH_SENTINEL'), false);
  assert.equal(`${badArguments.stdout}${badArguments.stderr}`.includes(base), false);
});

test('timed-out CLI version check is unsupported', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'codex-timeout-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fakePath = join(base, 'slow Codex & probe.mjs');
  writeFileSync(fakePath, 'setTimeout(() => console.log("too late"), 5000);\n', 'utf8');
  const result = await runDiscoveryCheck({ codex: fakePath, timeoutMs: 100, tempRoot: base });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.pass, false);
  assert.equal(result.diagnostic, 'timeout');
});
