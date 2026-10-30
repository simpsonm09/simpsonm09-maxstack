#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(repoRoot, 'scripts', 'Install-WorkspaceDiscovery.ps1');
const installer = join(repoRoot, 'scripts', 'Install-Workspace.ps1');
const shell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? 'pwsh' : null;
function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'maxstack-discovery-'));
}

function directory(root, rel) {
  const path = join(root, ...rel.split('/'));
  mkdirSync(path, { recursive: true });
  return path;
}

function marker(root, file = 'stack.lock.json') {
  writeFileSync(join(root, file), '{}');
  return root;
}

function invoke(options = {}) {
  const complete = {
    explicitSpecified: false,
    explicitValue: '',
    cwd: process.cwd(),
    scriptRoot: join(repoRoot, 'scripts'),
    legacy: null,
    ...options,
  };
  const encodedOptions = Buffer.from(JSON.stringify(complete), 'utf8').toString('base64');
  const locationSetup = complete.nonFilesystem ? 'Set-Location Env:; ' : '';
  const command = `${locationSetup}$o = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedOptions}')) | ConvertFrom-Json -AsHashtable; . '${helper.replaceAll("'", "''")}'; try { $r = Resolve-MaxstackWorkspace -ExplicitSpecified:$o.explicitSpecified -ExplicitValue $o.explicitValue -CurrentDirectory $o.cwd -ScriptRoot $o.scriptRoot -LegacyWorkspace $o.legacy; [ordered]@{workspace=$r.Workspace; origin=$r.Origin; warning=$r.Warning} | ConvertTo-Json -Compress } catch { Write-Error $_; exit 23 }`;
  const env = { ...process.env };
  if (Object.hasOwn(options, 'envWorkspace')) env.MAXSTACK_WORKSPACE = options.envWorkspace;
  else delete env.MAXSTACK_WORKSPACE;
  return spawnSync(shell, ['-NoProfile', '-Command', command], { cwd: options.cwd, env, encoding: 'utf8', windowsHide: true });
}

function resolveCase(options, expectedPath, expectedOrigin) {
  const run = invoke(options);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.workspace.toLowerCase(), resolve(expectedPath).toLowerCase());
  assert.equal(result.origin, expectedOrigin);
  return result;
}

function withRoot(run) {
  const root = makeRoot();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('workspace discovery requires PowerShell 7', { skip: !shell }, () => {
  assert.ok(existsSync(helper));
});

test('explicit path wins over environment, cwd marker, script layout, and legacy', { skip: !shell }, () => withRoot((root) => {
  const explicit = marker(directory(root, 'explicit'));
  const env = marker(directory(root, 'env'));
  const cwd = marker(directory(root, 'cwd'));
  const layout = marker(directory(root, 'layout'));
  const legacy = marker(directory(root, 'legacy'));
  resolveCase({ explicitSpecified: true, explicitValue: explicit, envWorkspace: env, cwd, scriptRoot: join(layout, 'projects/repos/repo/scripts'), legacy }, explicit, '-Workspace');
}));

test('environment wins over cwd marker, script layout, and legacy', { skip: !shell }, () => withRoot((root) => {
  const env = marker(directory(root, 'env'));
  const cwd = marker(directory(root, 'cwd'));
  const layout = marker(directory(root, 'layout'));
  const legacy = marker(directory(root, 'legacy'));
  resolveCase({ envWorkspace: env, cwd, scriptRoot: join(layout, 'projects/repos/repo/scripts'), legacy }, env, 'MAXSTACK_WORKSPACE');
}));

test('nearest cwd marker wins and accepts a linked marker as a read-only marker', { skip: !shell }, (t) => withRoot((root) => {
  const outer = directory(root, 'outer');
  marker(outer);
  const nearest = directory(outer, 'child');
  const markerTarget = join(root, 'marker-target.json');
  writeFileSync(markerTarget, '{}');
  try {
    symlinkSync(markerTarget, join(nearest, 'maxstack.settings.json'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Windows symlink privilege is unavailable in this environment.');
      return;
    }
    throw error;
  }
  const layout = marker(directory(root, 'layout'));
  const legacy = marker(directory(root, 'legacy'));
  resolveCase({ cwd: directory(nearest, 'nested'), scriptRoot: join(layout, 'projects/worktrees/repo/scripts'), legacy }, nearest, 'cwd marker maxstack.settings.json');
}));

test('script layout resolves exact repos and worktrees segments', { skip: !shell }, () => withRoot((root) => {
  for (const layoutName of ['repos', 'worktrees']) {
    const workspace = directory(root, layoutName);
    const scriptRoot = directory(workspace, `projects/${layoutName}/repo/scripts`);
    const cwd = directory(root, `outside-${layoutName}`);
    const result = resolveCase({ cwd, scriptRoot }, workspace, 'script layout');
    assert.equal(result.warning, false);
  }
}));

test('cwd marker beats script layout; unrelated script paths do not match layout', { skip: !shell }, () => withRoot((root) => {
  const cwdWorkspace = marker(directory(root, 'cwd-workspace'));
  const layoutWorkspace = directory(root, 'layout-workspace');
  const layoutRoot = directory(layoutWorkspace, 'projects/repos/repo/scripts');
  resolveCase({ cwd: directory(cwdWorkspace, 'child'), scriptRoot: layoutRoot }, cwdWorkspace, 'cwd marker stack.lock.json');
  const badScript = directory(root, 'a/b/c/repo/scripts');
  const legacy = marker(directory(root, 'legacy'));
  resolveCase({ cwd: directory(root, 'outside'), scriptRoot: badScript, legacy }, legacy, 'legacy default');
}));

test('relative explicit and environment paths resolve against filesystem cwd', { skip: !shell }, () => withRoot((root) => {
  const cwd = directory(root, 'base');
  const explicit = marker(directory(cwd, 'explicit'));
  resolveCase({ explicitSpecified: true, explicitValue: 'explicit', cwd }, explicit, '-Workspace');
  const env = marker(directory(cwd, 'environment'));
  resolveCase({ envWorkspace: 'environment', cwd }, env, 'MAXSTACK_WORKSPACE');
}));

test('explicit path matching is case-insensitive on Windows and normalizes the returned path', { skip: !shell }, () => withRoot((root) => {
  const target = marker(directory(root, 'CaseSensitiveName'));
  const alternateCase = target.replace('CaseSensitiveName', 'casesensitivename');
  const result = resolveCase({ explicitSpecified: true, explicitValue: alternateCase, cwd: root }, target, '-Workspace');
  assert.ok(result.workspace.endsWith('CaseSensitiveName'));
}));

test('successful installer runs print the resolved workspace before argument validation', { skip: !shell }, () => withRoot((root) => {
  const target = directory(root, 'target');
  const env = { ...process.env };
  delete env.MAXSTACK_WORKSPACE;
  const run = spawnSync(shell, ['-NoProfile', '-File', installer, '-Workspace', target, '-Apply', '-Status'], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout.split(/\r?\n/)[0], `Workspace: ${target} (from -Workspace)`);
  assert.match(run.stderr, /Choose one/);
  assert.deepEqual(readdirSync(target), []);
}));

test('explicit empty and invalid environment targets fail without falling through', { skip: !shell }, () => withRoot((root) => {
  const cwd = marker(directory(root, 'cwd'));
  const scriptRoot = directory(root, 'layout/projects/repos/repo/scripts');
  const runExplicit = invoke({ explicitSpecified: true, explicitValue: ' ', cwd, scriptRoot });
  assert.equal(runExplicit.status, 23);
  assert.match(runExplicit.stderr, /-Workspace was explicitly supplied but is empty/);
  const runEnv = invoke({ envWorkspace: join(root, 'missing'), cwd, scriptRoot });
  assert.equal(runEnv.status, 23);
  assert.match(runEnv.stderr, /MAXSTACK_WORKSPACE target does not exist/);
  const runEmptyEnv = invoke({ envWorkspace: '', cwd, scriptRoot });
  assert.equal(runEmptyEnv.status, 23);
  assert.match(runEmptyEnv.stderr, /MAXSTACK_WORKSPACE is set but empty/);
}));

test('discovery refuses a non-filesystem current location', { skip: !shell }, () => withRoot((root) => {
  const run = invoke({ nonFilesystem: true, cwd: root, scriptRoot: join(root, 'scripts') });
  assert.equal(run.status, 23);
  assert.match(run.stderr, /requires a filesystem current location/);
}));

test('missing explicit target fails instead of using a marker or layout', { skip: !shell }, () => withRoot((root) => {
  const cwd = marker(directory(root, 'cwd'));
  const scriptRoot = directory(root, 'layout/projects/worktrees/repo/scripts');
  const run = invoke({ explicitSpecified: true, explicitValue: join(root, 'typo'), cwd, scriptRoot });
  assert.equal(run.status, 23);
  assert.match(run.stderr, /-Workspace target does not exist/);
}));

test('missing legacy target reports all four discovery sources', { skip: !shell }, () => withRoot((root) => {
  const cwd = directory(root, 'cwd');
  const scriptRoot = directory(root, 'no/matching/layout/repo/scripts');
  const run = invoke({ cwd, scriptRoot, legacy: join(root, 'absent-legacy') });
  assert.equal(run.status, 23);
  assert.match(run.stderr, /MAXSTACK_WORKSPACE/);
  assert.match(run.stderr, /cwd marker/);
  assert.match(run.stderr, /script layout/);
  assert.match(run.stderr, /legacy default/);
}));

test('legacy fallback is only used when its injected target exists and carries a warning', { skip: !shell }, () => withRoot((root) => {
  const legacy = marker(directory(root, 'legacy'));
  const result = resolveCase({ cwd: directory(root, 'outside'), scriptRoot: directory(root, 'outside-script'), legacy }, legacy, 'legacy default');
  assert.equal(result.warning, true);
}));
