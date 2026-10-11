#!/usr/bin/env node
// Prove the workspace skill check needs a model and stops a hung OpenCode run at its
// time limit, naming the command, for both the PowerShell and the shell twin. The
// stand-in binaries never reach a model, so no model call runs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const psScript = join(repoRoot, 'scripts', 'verify-workspace-skill.ps1');
const shScript = join(repoRoot, 'scripts', 'verify-workspace-skill.sh');
// A safety net for the test itself: a check that ignores its limit fails here instead of hanging.
const RUN_CEILING_MS = 90_000;

function findPwsh() {
  for (const name of ['pwsh', 'powershell']) {
    if (spawnSync(name, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0) return name;
  }
  return null;
}

// On Windows a bash on PATH can be the WSL launcher, so use the one Git for Windows ships.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe');
  return existsSync(gitBash) ? gitBash : null;
}

const pwsh = findPwsh();
const bash = findBash();
const forwardSlashes = (path) => path.replaceAll('\\', '/');

// PowerShell colours and wraps its error view, with a "Line |" gutter, so matching a
// message needs the escape codes, the gutter bars, and the line breaks removed.
function plainOutput(run) {
  return `${run.stdout}\n${run.stderr}`
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the ANSI colour code being removed
    .replace(/\x1B\[[0-9;]*m/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'skill-check-'));
  const project = join(base, 'project');
  mkdirSync(project);
  return { base, project, marker: join(base, 'started.txt') };
}

function writeStandIn(base, kind, body) {
  if (kind === 'ps1') {
    const path = join(base, 'fake-opencode.ps1');
    writeFileSync(path, body);
    return path;
  }
  const path = join(base, 'fake-opencode');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

function assertNoRunawayWait(run) {
  assert.equal(run.error, undefined, `the test had to stop the check: ${run.error?.code ?? ''}`);
}

test('the PowerShell check refuses to run without a model and starts no OpenCode', { skip: pwsh ? false : 'pwsh is not available' }, () => {
  const { base, project, marker } = makeFixture();
  try {
    const fake = writeStandIn(base, 'ps1', `'started' | Set-Content -LiteralPath '${marker}'\n`);
    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', psScript, '-OpenCodeBinary', fake, '-Project', project], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: RUN_CEILING_MS,
    });
    assertNoRunawayWait(run);
    assert.notEqual(run.status, 0, 'the check ran without a model');
    assert.match(plainOutput(run), /pass -Model provider\/model/);
    assert.ok(!existsSync(marker), 'OpenCode was started without a model');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a hung PowerShell run stops at its limit and the check names the command', { skip: pwsh ? false : 'pwsh is not available' }, () => {
  const { base, project } = makeFixture();
  try {
    const fake = writeStandIn(base, 'ps1', 'Start-Sleep -Seconds 120\n');
    const started = Date.now();
    const run = spawnSync(
      pwsh,
      ['-NoProfile', '-NonInteractive', '-File', psScript, '-OpenCodeBinary', fake, '-Project', project, '-Model', 'opencode-go/test-model', '-CallTimeoutSeconds', '3'],
      { windowsHide: true, encoding: 'utf8', timeout: RUN_CEILING_MS },
    );
    const elapsed = Date.now() - started;
    assertNoRunawayWait(run);
    assert.notEqual(run.status, 0, 'a hung run passed');
    assert.match(plainOutput(run), /did not finish within 3 seconds/);
    assert.ok(elapsed < 60_000, `the check waited ${elapsed} ms for a 3-second limit`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a run that loads the skill and reads its sibling file passes', { skip: pwsh ? false : 'pwsh is not available' }, () => {
  const { base, project } = makeFixture();
  try {
    // The events the real --format json run prints for a passing check, without a model call.
    const events = [
      '{"type":"tool_use","part":{"type":"tool","tool":"skill","state":{"input":{"id":"poteto-mode"}}}}',
      '{"type":"text","part":{"text":"WORKSPACE_PSTACK_OK=Investigation"}}',
    ];
    const fake = writeStandIn(base, 'ps1', `${events.map((line) => `Write-Output '${line}'`).join('\n')}\n`);
    const run = spawnSync(
      pwsh,
      ['-NoProfile', '-NonInteractive', '-File', psScript, '-OpenCodeBinary', fake, '-Project', project, '-Model', 'opencode-go/test-model'],
      { windowsHide: true, encoding: 'utf8', timeout: RUN_CEILING_MS },
    );
    assertNoRunawayWait(run);
    assert.equal(run.status, 0, plainOutput(run));
    assert.match(run.stdout, /PASS: workspace skill 'poteto-mode' loaded and its sibling file was read/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the shell check refuses to run without a model argument', { skip: bash ? false : 'bash is not available' }, () => {
  const run = spawnSync(bash, [forwardSlashes(shScript)], { windowsHide: true, encoding: 'utf8', timeout: RUN_CEILING_MS });
  assertNoRunawayWait(run);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /pass the model as the second argument/);
});

test('a hung shell run stops at its limit and the check names the command', { skip: bash ? false : 'bash is not available' }, () => {
  const { base, project } = makeFixture();
  try {
    const fake = writeStandIn(base, 'sh', 'sleep 120\n');
    const run = spawnSync(bash, [forwardSlashes(shScript), 'poteto-mode', 'opencode-go/test-model', '2'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: RUN_CEILING_MS,
      env: {
        ...process.env,
        OPENCODE_BIN: forwardSlashes(fake),
        PROJECT: forwardSlashes(project),
        PSTACK_TEST_TMPDIR: forwardSlashes(base),
      },
    });
    assertNoRunawayWait(run);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /did not finish within 2 seconds/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
