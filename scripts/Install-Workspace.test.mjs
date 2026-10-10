#!/usr/bin/env node
// Prove Install-Workspace.ps1 installs each layer's runtimes from one layers.json: the
// Claude plugin folders, the OpenCode entry and agents, and the Copilot wrappers. The
// pstack source is a local git fixture standing in for GitHub, and Copilot is a stand-in
// command, so the tests need no network and no Copilot install.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, parse as parsePath, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(repoRoot, 'scripts', 'Install-Workspace.ps1');
// The two local layers. Each declares every runtime, and each needs a manifest whose name
// matches its layer name. pstack is pinned to a git source and needs no local checkout.
const LOCAL_LAYERS = ['projects/repos/simpsonm09-org-ai-plugin', 'projects/repos/simpsonm09-personal-ai-plugin'];
const MISSING_COPILOT = 'maxstack-test-no-such-copilot';
const MISSING_PI = 'maxstack-test-no-such-pi';

let layersCounter = 0;

function findShell() {
  for (const name of ['pwsh', 'powershell']) {
    if (spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0) return name;
  }
  return null;
}

// On Windows a bash on PATH can be the WSL launcher, so use the one Git for Windows ships.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe');
  return existsSync(gitBash) ? gitBash : null;
}

function writeFile(root, rel, content) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function stringValues(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) stringValues(item, out);
  else if (node && typeof node === 'object') for (const item of Object.values(node)) stringValues(item, out);
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// PowerShell colours and wraps its error view, with a "Line |" gutter, so matching
// a message needs the escape codes, the gutter bars, and the line breaks removed.
function plainOutput(run) {
  return `${run.stdout}\n${run.stderr}`
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the ANSI colour code being removed
    .replace(/\x1B\[[0-9;]*m/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

// A local layer stub: an index.ts, a node_modules tree so the installer skips npm, a
// fragment, a skills folder, a package.json, and a layer.json. A claude runtime needs
// .claude-plugin in its files list. A pi key adds a pi folder and lists it in the files.
function writeLayerStub(root, { claudePlugin = null, manifestName = claudePlugin, withManifest = true, extra = {}, pi = null } = {}) {
  const files = ['index.ts', 'node_modules', 'package.json', 'skills', ...Object.keys(extra)];
  if (claudePlugin) files.push('.claude-plugin');
  if (pi) files.push('pi');
  writeFile(root, 'index.ts', 'export default {};\n');
  writeFile(root, 'layer.json', JSON.stringify({ files }));
  writeFile(root, 'package.json', JSON.stringify({ name: manifestName ?? 'layer', version: '0.1.0', ...(pi ? { pi } : {}) }));
  writeFile(root, 'skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: fixture\n---\nbody\n');
  writeFile(root, 'node_modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeFile(root, 'opencode.fragment.jsonc', '{}');
  if (pi) writeFile(root, 'pi/index.ts', 'export default {};\n');
  for (const [rel, content] of Object.entries(extra)) writeFile(root, rel, content);
  if (claudePlugin && withManifest) {
    writeFile(root, '.claude-plugin/plugin.json', JSON.stringify({ name: manifestName, version: '0.1.0' }));
  }
}

// A git repository standing in for simpsonm09/pstack-claude at the fork's layout: the
// plugin folder carries a Claude manifest, the OpenCode entry and its agent profiles, and
// the shared skills tree the entry reads. A file outside the folder must not come along.
// With npm, the OpenCode package declares a dependency and ships no node_modules, so the installer runs npm in the
// entry's folder. With shipLock, the package also ships a package-lock.json, as a layer may.
const SHIPPED_LOCK = '{"lockfileVersion": 3, "shipped": true}\n';
const SHIPPED_SHRINKWRAP = '{"lockfileVersion": 3, "shippedShrinkwrap": true}\n';

function makeFixture(base, { npm = false, shipLock = false, shipShrinkwrap = false } = {}) {
  const dir = join(base, 'pstack-src');
  const plugin = 'plugins/pstack';
  writeFile(dir, `${plugin}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'pstack', version: '0.9.79' }));
  for (const skillId of ['poteto-mode', 'setup-pstack', 'principle-laziness-protocol']) {
    writeFile(dir, `${plugin}/skills/${skillId}/SKILL.md`, `---\nname: ${skillId}\ndescription: fixture\n---\nfixture body\n`);
  }
  writeFile(dir, `${plugin}/opencode/index.ts`, 'export default {};\n');
  const packageJson = npm ? { name: 'pstack-opencode', private: true, dependencies: { '@opencode/plugin': '2.0.18' } } : { name: 'pstack-opencode', private: true };
  writeFile(dir, `${plugin}/opencode/package.json`, JSON.stringify(packageJson));
  if (shipLock) writeFile(dir, `${plugin}/opencode/package-lock.json`, SHIPPED_LOCK);
  if (shipShrinkwrap) writeFile(dir, `${plugin}/opencode/npm-shrinkwrap.json`, SHIPPED_SHRINKWRAP);
  if (!npm) writeFile(dir, `${plugin}/opencode/node_modules/@opencode/plugin/index.js`, 'module.exports = {};\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-agent.md`, '---\ndescription: worker\nmodel: opencode-go/deepseek-v4.1-flash\n---\nbody\nmodel: a body line\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-reviewer.md`, '---\ndescription: reviewer\n---\nreview\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-comment-sicko.md`, '---\ndescription: comments\n---\ncomments\n');
  // The pinned repository root is the Pi package: its pi key names paths under plugins/pstack.
  writeFile(dir, 'package.json', JSON.stringify({ name: 'pstack', version: '0.9.79', pi: { skills: ['./plugins/pstack/skills'], extensions: ['./plugins/pstack/pi/index.ts'] } }));
  writeFile(dir, `${plugin}/pi/index.ts`, 'export default {};\n');
  writeFile(dir, 'other/notes.txt', 'outside the plugin folder\n');
  const git = (args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
    return run.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'uploadpack.allowFilter', 'true']);
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'pin']);
  return { dir, commit: git(['rev-parse', 'HEAD']), url: `file:///${dir.replaceAll('\\', '/')}` };
}

// A stand-in for the Copilot CLI: it echoes the account-independent switch and its arguments.
function writeFakeCopilot(base) {
  const path = join(base, 'fake-copilot.cmd');
  writeFileSync(path, '@echo off\r\necho ASK=%AGENT_ACCESS_COPILOT_ASK%\r\necho ARGS=%*\r\n');
  return path;
}

// A stand-in for the Pi CLI: it echoes the agent folder, the ask switch, and its arguments.
function writeFakePi(base) {
  const path = join(base, 'fake-pi.cmd');
  writeFileSync(path, '@echo off\r\necho AGENT_DIR=%PI_CODING_AGENT_DIR%\r\necho ASK=%AGENT_ACCESS_PI_ASK%\r\necho ARGS=%*\r\n');
  return path;
}

// A stand-in for npm on PATH. A real install beside a package.json writes a package-lock.json and a node_modules
// folder into its prefix, and nothing else here. FAKE_NPM_EXTRA names one more file it writes, and FAKE_NPM_REWRITE
// makes it write a different lock, as npm does to a lock the layer ships. A node script runs it, behind a .cmd on
// Windows and a shell file elsewhere.
const FAKE_NPM_SCRIPT = `import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
const shrinkwrap = join(prefix, 'npm-shrinkwrap.json');
// npm writes into a shrinkwrap the layer ships, and otherwise into package-lock.json; FAKE_NPM_SHRINKWRAP makes it generate one.
const lockPath = process.env.FAKE_NPM_SHRINKWRAP || existsSync(shrinkwrap) ? shrinkwrap : join(prefix, 'package-lock.json');
const lock = process.env.FAKE_NPM_REWRITE ? '{"lockfileVersion": 3, "rewritten": true}' : '{"lockfileVersion": 3}';
writeFileSync(lockPath, lock);
const sdk = join(prefix, 'node_modules', '@opencode', 'plugin', 'index.js');
mkdirSync(dirname(sdk), { recursive: true });
writeFileSync(sdk, 'module.exports = {};\\n');
if (process.env.FAKE_NPM_EXTRA) {
  const extra = join(prefix, process.env.FAKE_NPM_EXTRA);
  mkdirSync(dirname(extra), { recursive: true });
  writeFileSync(extra, 'written by npm\\n');
}
// FAKE_NPM_BROKEN_SCOPE leaves a scope folder that is a junction to a folder that is gone, which listing it cannot read.
if (process.env.FAKE_NPM_BROKEN_SCOPE) {
  mkdirSync(join(prefix, 'node_modules'), { recursive: true });
  symlinkSync(join(prefix, 'gone-target'), join(prefix, 'node_modules', '@broken'), 'junction');
}
// FAKE_NPM_SCRIPTED lists installed packages that declare a postinstall script, so the ignore-scripts scan has them.
if (process.env.FAKE_NPM_SCRIPTED) {
  for (const name of JSON.parse(process.env.FAKE_NPM_SCRIPTED)) {
    const dir = join(prefix, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { postinstall: 'node build.js' } }));
  }
}
`;

function writeFakeNpm(base) {
  const bin = join(base, 'fake-npm-bin');
  const script = join(base, 'fake-npm.mjs');
  mkdirSync(bin);
  writeFileSync(script, FAKE_NPM_SCRIPT);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const path = join(bin, 'npm');
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(path, 0o755);
  }
  return bin;
}

// The environment the installer runs in, with the fake npm first on PATH. The key is found by case, because
// Windows keeps the variable as Path in the environment object.
function environmentWithNpm(bin) {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = `${bin}${delimiter}${env[key] ?? ''}`;
  return env;
}

// A stand-in CLI on PATH for the host: a .cmd on Windows, and an executable file with no
// extension elsewhere, which is what Homebrew or npm put on a POSIX PATH.
function writeFakeCli(dir, name) {
  if (process.platform === 'win32') {
    const path = join(dir, `${name}.cmd`);
    writeFileSync(path, '@echo off\r\necho stand-in\r\n');
    return path;
  }
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho stand-in\n');
  chmodSync(path, 0o755);
  return path;
}

// The workspace and its fixtures. An npm fixture runs the installer with the fake npm on PATH, and ctx.env holds that
// environment, so a test can set FAKE_NPM_EXTRA or FAKE_NPM_REWRITE on it.
function buildWorkspace({ withManifests = true, fixture = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-lock-'));
  const workspace = join(base, 'simpsonm09');
  for (const layerPath of LOCAL_LAYERS) {
    const name = layerPath.split('/').pop();
    writeLayerStub(join(workspace, layerPath), { claudePlugin: name, withManifest: withManifests });
  }
  const ctx = { base, workspace, fixture: makeFixture(base, fixture), fakeCopilot: writeFakeCopilot(base), fakePi: writeFakePi(base) };
  if (fixture.npm) ctx.env = environmentWithNpm(writeFakeNpm(base));
  return ctx;
}

// The repository layers.json with the pstack source pointed at the fixture, and an
// optional change applied to the manifest before it is written.
function writeLayers(ctx, mutate = null) {
  const manifest = readJson(join(repoRoot, 'layers.json'));
  const pstack = manifest.layers.find((layer) => layer.name === 'pstack');
  pstack.source = { url: ctx.fixture.url, path: 'plugins/pstack', commit: ctx.fixture.commit, ref: 'test' };
  if (mutate) mutate(manifest);
  layersCounter += 1;
  const path = join(ctx.base, `layers-${layersCounter}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

function layerNamed(manifest, name) {
  return manifest.layers.find((layer) => layer.name === name);
}

// The environment a test run gives the installer. MAXSTACK_TEST_MODE turns on the test seam, which lets the fixtures'
// file remotes be read, so every installer run in these tests sets it. A test of the unset seam builds its own env.
function testEnvironment(base) {
  return { ...(base ?? process.env), MAXSTACK_TEST_MODE: '1' };
}

// Runs the installer. Copilot and Pi are the stand-ins unless the caller names their command.
function runInstaller(shell, ctx, extra = [], { apply = true, layersFile = writeLayers(ctx), env = undefined } = {}) {
  const copilot = extra.includes('-CopilotCommand') ? [] : ['-CopilotCommand', ctx.fakeCopilot];
  const pi = extra.includes('-PiCommand') ? [] : ['-PiCommand', ctx.fakePi];
  const args = [
    '-NoProfile', '-NonInteractive', '-File', installer,
    '-Workspace', ctx.workspace,
    ...(layersFile ? ['-LayersFile', layersFile] : []),
    ...copilot,
    ...pi,
    ...(apply ? ['-Apply'] : []),
    ...extra,
  ];
  return spawnSync(shell, args, { encoding: 'utf8', env: testEnvironment(env ?? ctx.env) });
}

// A junction reports as a symbolic link to lstat.
function isLink(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat ? stat.isSymbolicLink() : false;
}

function driftLines(run) {
  return run.stdout.split(/\r?\n/).filter((line) => line.startsWith('Drift:'));
}

const shell = findShell();
const skip = shell ? false : 'pwsh is not available';

function findPython() {
  for (const name of ['python', 'python3']) {
    if (spawnSync(name, ['--version']).status === 0) return name;
  }
  return null;
}

const python = findPython();


function withWorkspace(name, body, options) {
  test(name, { skip }, () => {
    const ctx = buildWorkspace(options);
    try {
      body(ctx);
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  });
}

// A test that needs an external program. Without it the test is reported as skipped, with the program
// named as the reason, so a run on a machine without it cannot pass by doing nothing.
function withWorkspaceNeeding(label, available, name, body, options) {
  const reason = skip || (available ? false : `${label} is not available`);
  test(name, { skip: reason }, () => {
    const ctx = buildWorkspace(options);
    try {
      body(ctx);
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  });
}

function mustApply(ctx, extra = [], options = {}) {
  const run = runInstaller(shell, ctx, extra, options);
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  return run;
}

withWorkspace('the lock records each layer once, with its runtimes and no absolute path', (ctx) => {
  mustApply(ctx);
  const raw = readFileSync(join(ctx.workspace, 'stack.lock.json'), 'utf8');
  const lock = JSON.parse(raw);

  assert.equal(lock.workspace, 'simpsonm09', 'the lock names the workspace');
  assert.ok(!raw.includes(ctx.workspace), 'the lock holds no absolute workspace path');
  assert.ok(!raw.includes(ctx.base), 'the lock holds no temporary path');
  for (const value of stringValues(lock)) {
    assert.doesNotMatch(value, /^[A-Za-z]:[\\/]/, `drive-letter path: ${value}`);
    assert.doesNotMatch(value, /^\//, `absolute path: ${value}`);
  }

  assert.equal(typeof lock.generatedAt, 'string');
  assert.ok(!('primaryModel' in lock), 'the lock records no model');
  assert.match(lock.configSha256, /^[0-9a-fA-F]{64}$/);
  assert.equal(lock.layers.length, 3, 'one record per layer in layers.json');
  assert.deepEqual(lock.layers.map((record) => record.name), ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']);
  for (const record of lock.layers) {
    assert.equal(typeof record.name, 'string');
    assert.equal(typeof record.kind, 'string');
    assert.equal(typeof record.source, 'object', `layer ${record.name} records its source block`);
    assert.ok(['git', 'local'].includes(record.source.kind), `layer ${record.name} names its source kind`);
    for (const runtime of ['claude', 'opencode', 'copilot', 'pi']) {
      assert.equal(typeof record[runtime]?.enabled, 'boolean', `layer ${record.name} has a ${runtime} record`);
    }
  }
  assert.equal(lock.copilot.enabled, true, 'the Copilot wrappers are recorded as written');
  assert.deepEqual(lock.copilot.wrappers, ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh']);
  assert.match(lock.copilot.cmdSha256, /^[0-9A-F]{64}$/);
  assert.equal(lock.pi.enabled, true, 'the Pi wrappers are recorded as written');
  assert.deepEqual(lock.pi.wrappers, ['.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh']);
  assert.equal(lock.pi.agentDir, '.pi/agent');
  assert.match(lock.pi.cmdSha256, /^[0-9A-F]{64}$/);
  assert.ok(!('claudeMarketplaceSha256' in lock), 'the marketplace hash is gone');
  assert.ok(!('claudeSettingsSha256' in lock), 'the settings hash is gone');
}, {});

withWorkspace('apply writes no model, and removes one from the config and the installed profiles', (ctx) => {
  // The pstack agent profile carries a model line, and the workspace holds an older
  // profile and config that name one. Apply must leave no model in either and keep the
  // rest of each file.
  writeFile(ctx.workspace, 'opencode.jsonc', '{\n  "model": "opencode-go/deepseek-v4.1-flash",\n  "small_model": "opencode-go/deepseek-v4.1-flash"\n}\n');
  writeFile(ctx.workspace, '.opencode/agents/pstack-agent.md', '---\nmodel: opencode-go/deepseek-v4.1-flash\n---\nold\n');

  const run = mustApply(ctx);
  assert.doesNotMatch(run.stdout, /Primary model|with model/, 'the installer reports a model');

  const config = readJson(join(ctx.workspace, 'opencode.jsonc'));
  assert.ok(!('model' in config), 'the generated config sets no model');
  assert.ok(!('small_model' in config), 'the generated config sets no small_model');
  assert.equal(config.default_agent, 'build', 'the rest of the base config is kept');

  const profile = readFileSync(join(ctx.workspace, '.opencode', 'agents', 'pstack-agent.md'), 'utf8');
  assert.doesNotMatch(profile.split('\n---\n')[0], /^model:/m, 'the installed profile keeps a model line');
  assert.match(profile, /^model: a body line$/m, 'a body line that starts with model: was stripped');
  assert.match(profile, /^description: worker$/m, 'the installed profile lost its other frontmatter');
}, {});

withWorkspace('audit reports a config that still sets a model as drift', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', '{\n  "model": "opencode-go/deepseek-v4.1-flash"\n}\n');

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /Drift: +.*opencode\.jsonc: differs/, audit.stdout);
  assert.match(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), /"model"/, 'audit rewrote the config');

  mustApply(ctx);
  assert.ok(!('model' in readJson(join(ctx.workspace, 'opencode.jsonc'))), 'apply kept the model');
}, {});

withWorkspace('the Claude runtime is a junction for local layers and a pinned sparse copy for pstack', (ctx) => {
  mustApply(ctx);

  const plugins = join(ctx.workspace, '.claude', 'plugins');
  for (const [plugin, target] of [
    ['simpsonm09-org-ai-plugin', '.opencode/plugins/simpsonm09-org-ai-plugin'],
    ['simpsonm09-personal-ai-plugin', '.opencode/plugins/simpsonm09-personal-ai-plugin'],
  ]) {
    const child = join(plugins, plugin);
    assert.ok(isLink(child), `${plugin} is a link`);
    assert.equal(realpathSync(child).toLowerCase(), realpathSync(join(ctx.workspace, ...target.split('/'))).toLowerCase());
    assert.ok(existsSync(join(child, '.claude-plugin', 'plugin.json')), `${plugin} exposes its manifest`);
  }

  const pstackChild = join(plugins, 'pstack');
  assert.ok(!isLink(pstackChild), 'pstack is a real folder, not a link');
  assert.ok(existsSync(join(pstackChild, '.claude-plugin', 'plugin.json')));
  assert.ok(existsSync(join(pstackChild, 'skills', 'poteto-mode', 'SKILL.md')));
  assert.ok(!existsSync(join(pstackChild, 'other')), 'the sparse copy leaves out files outside plugins/pstack');
  assert.ok(existsSync(join(ctx.workspace, '.claude', 'cache', 'pstack', '.git')), 'the git cache is under .claude/cache, named for the layer');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.kind, 'junction');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.plugin, 'simpsonm09-org-ai-plugin');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.child, '.claude/plugins/simpsonm09-org-ai-plugin');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.target, '.opencode/plugins/simpsonm09-org-ai-plugin');
  assert.match(byName['simpsonm09-org-ai-plugin'].claude.treeSha256, /^[0-9A-F]{64}$/);
  assert.equal(byName.pstack.claude.kind, 'git');
  assert.equal(byName.pstack.claude.commit, ctx.fixture.commit, 'the pstack record is the pinned commit');
  assert.equal(byName.pstack.claude.repository, ctx.fixture.url);
  assert.equal(byName.pstack.claude.path, 'plugins/pstack');
  assert.equal(byName.pstack.path, null, 'a git layer has no local checkout path');
  assert.equal(byName.pstack.commit, ctx.fixture.commit);
}, {});

withWorkspace('the pstack OpenCode entry and agents land from the one pstack source', (ctx) => {
  mustApply(ctx);

  const folder = join(ctx.workspace, '.opencode', 'plugins', 'pstack');
  assert.ok(existsSync(join(folder, 'opencode', 'index.ts')), 'the entry is installed');
  assert.ok(existsSync(join(folder, 'skills', 'poteto-mode', 'SKILL.md')), 'the shared skills sit beside the entry folder');
  assert.ok(existsSync(join(folder, 'opencode', 'node_modules', '@opencode', 'plugin', 'index.js')), 'the entry folder keeps its SDK');
  assert.ok(!existsSync(join(folder, 'index.ts')), 'the pstack folder root has no index.ts, so OpenCode does not load it twice');
  assert.ok(!existsSync(join(folder, 'other')), 'the OpenCode copy leaves out files outside the named items');

  for (const agent of ['pstack-agent.md', 'pstack-reviewer.md', 'pstack-comment-sicko.md']) {
    assert.ok(existsSync(join(ctx.workspace, '.opencode', 'agents', agent)), `${agent} is installed`);
  }
  const worker = readFileSync(join(ctx.workspace, '.opencode', 'agents', 'pstack-agent.md'), 'utf8');
  assert.doesNotMatch(worker.split('\n---\n')[0], /^model:/m, 'the installed worker keeps no model line');

  const config = readJson(join(ctx.workspace, 'opencode.jsonc'));
  assert.deepEqual(config.plugin, ['./.opencode/plugins/pstack/opencode'], 'only the nested entry is named in the config');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.deepEqual(byName.pstack.opencode, {
    enabled: true,
    folder: '.opencode/plugins/pstack',
    entry: 'opencode/index.ts',
    loader: 'config',
    plugin: './.opencode/plugins/pstack/opencode',
    agents: ['pstack-agent.md', 'pstack-comment-sicko.md', 'pstack-reviewer.md'],
  });
  assert.equal(byName['simpsonm09-org-ai-plugin'].opencode.loader, 'discovery', 'a root index.ts loads from its folder');
  assert.equal(byName['simpsonm09-org-ai-plugin'].opencode.plugin, null);
}, {});

withWorkspace('the retired pstack-opencode folder is removed, and the result matches a workspace that never had it', (ctx) => {
  mustApply(ctx);
  const clean = readdirSync(join(ctx.workspace, '.opencode', 'plugins')).sort();
  const cleanConfig = readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8');

  const retired = join(ctx.workspace, '.opencode', 'plugins', 'pstack-opencode');
  writeFile(retired, 'index.ts', 'export default {};\n');
  writeFile(retired, 'node_modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  const run = mustApply(ctx);
  assert.match(run.stdout, /Removed the stale plugin folder .*pstack-opencode/);
  assert.ok(!existsSync(retired), 'the retired folder is still there');
  assert.deepEqual(readdirSync(join(ctx.workspace, '.opencode', 'plugins')).sort(), clean);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), cleanConfig);

  mustApply(ctx);
  assert.deepEqual(readdirSync(join(ctx.workspace, '.opencode', 'plugins')).sort(), clean, 'a second apply changes nothing');
}, {});

withWorkspace('copilot.cmd names each Claude folder in layer order, sets the switch, and passes arguments on', (ctx) => {
  mustApply(ctx);
  const cmd = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'utf8');
  const lines = cmd.split(/\r?\n/);

  const plugins = join(ctx.workspace, '.claude', 'plugins');
  const pluginLines = lines.filter((line) => line.includes('--plugin-dir'));
  assert.equal(pluginLines.length, 1, 'one line runs the executable with every plugin folder');
  const dirs = [...pluginLines[0].matchAll(/--plugin-dir "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(dirs, [join(plugins, 'pstack'), join(plugins, 'simpsonm09-org-ai-plugin'), join(plugins, 'simpsonm09-personal-ai-plugin')], 'folders in layer order');

  const env = lines.indexOf('set "AGENT_ACCESS_COPILOT_ASK=allow"');
  assert.ok(env >= 0, 'the switch is set');
  assert.ok(env < lines.indexOf(pluginLines[0]), 'the switch is set before the executable runs');
  assert.ok(pluginLines[0].includes(`"${ctx.fakeCopilot}"`), 'the wrapper names the absolute executable');
  assert.ok(pluginLines[0].endsWith(' %*'), 'the wrapper passes its arguments on');
  assert.ok(!pluginLines[0].includes('.maxstack'), 'the wrapper does not name a file in its own folder');
}, {});

withWorkspace('copilot.cmd runs the executable with the switch, the plugin folders, and the caller arguments', (ctx) => {
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --foo "a b""`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const plugins = join(ctx.workspace, '.claude', 'plugins');
  const args = run.stdout.split(/\r?\n/).find((line) => line.startsWith('ARGS='));
  assert.equal(
    args,
    `ARGS=--plugin-dir "${join(plugins, 'pstack')}" --plugin-dir "${join(plugins, 'simpsonm09-org-ai-plugin')}" --plugin-dir "${join(plugins, 'simpsonm09-personal-ai-plugin')}" --foo "a b"`,
  );
  assert.match(run.stdout, /ASK=allow/);
}, {});

withWorkspaceNeeding('bash', findBash(), 'copilot.sh runs copilot from PATH with the same folders and arguments', (ctx) => {
  const bash = findBash();
  mustApply(ctx);
  const sh = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh'), 'utf8');
  assert.match(sh, /^export AGENT_ACCESS_COPILOT_ASK=allow$/m, 'the script sets the switch');
  assert.match(sh, /exec copilot --plugin-dir "[^"]*\/\.claude\/plugins\/pstack" --plugin-dir "[^"]*\/simpsonm09-org-ai-plugin" --plugin-dir "[^"]*\/simpsonm09-personal-ai-plugin" "\$@"$/m);

  const fakeBin = join(ctx.base, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'copilot'), '#!/bin/sh\nprintf "ASK=%s\\n" "$AGENT_ACCESS_COPILOT_ASK"\nfor arg in "$@"; do printf "ARG=%s\\n" "$arg"; done\n');
  chmodSync(join(fakeBin, 'copilot'), 0o755);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`;
  const run = spawnSync(bash, [join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh').replaceAll('\\', '/'), '--foo', 'a b'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARG=--plugin-dir/);
  assert.match(run.stdout, /ARG=--foo\nARG=a b/, 'the caller arguments follow, unsplit');
}, {});

withWorkspace('copilot is skipped with a message when no executable is found, and an old wrapper goes', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')));

  const run = mustApply(ctx, ['-CopilotCommand', MISSING_COPILOT]);
  assert.match(plainOutput(run), /Copilot CLI not found/, run.stdout);
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')), 'the wrapper is still there');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh')), 'the script is still there');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.copilot.enabled, false);
  assert.match(lock.copilot.reason, /no 'maxstack-test-no-such-copilot' application/);
  assert.ok(lock.layers.every((record) => record.opencode.enabled), 'the OpenCode runtimes still install');
}, {});

withWorkspace('copilot never wraps the generated wrapper itself', (ctx) => {
  const bin = join(ctx.workspace, '.maxstack', 'bin');
  writeFile(bin, 'copilot.cmd', '@echo off\r\necho self\r\n');
  const run = mustApply(ctx, ['-CopilotCommand', join(bin, 'copilot.cmd')]);
  assert.match(plainOutput(run), /Copilot CLI not found/);
  assert.ok(existsSync(join(bin, 'copilot.cmd')), 'an unrecorded file was deleted: only a file that matches its record is removed');
  assert.match(plainOutput(run), /Kept .*copilot.cmd: it is not the installer's recorded copy/);
}, {});

withWorkspace('a git pin the repository cannot supply stops the run before anything is written', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'pstack').source.commit = 'f'.repeat(40);
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted an unreachable pin');
  assert.match(plainOutput(run), /Could not fetch the pinned commit f{40}/);
  assert.ok(!existsSync(join(ctx.workspace, 'opencode.jsonc')), 'the config was written before the pin check');
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack')), 'a pstack folder was written');
  assert.ok(!existsSync(join(ctx.workspace, '.opencode', 'plugins', 'pstack')), 'an OpenCode folder was written');
}, {});

withWorkspace('an offline re-apply reuses the cached commit', (ctx) => {
  mustApply(ctx);
  const moved = `${ctx.fixture.dir}-moved`;
  renameSync(ctx.fixture.dir, moved);
  try {
    const run = runInstaller(shell, ctx);
    assert.equal(run.status, 0, `offline re-apply failed\n${run.stdout}\n${run.stderr}`);
    const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
    const pstack = lock.layers.find((record) => record.name === 'pstack');
    assert.equal(pstack.claude.commit, ctx.fixture.commit);
  } finally {
    renameSync(moved, ctx.fixture.dir);
  }
}, {});

withWorkspace('the cache follows the layer url, even when it was cloned from another remote', (ctx) => {
  mustApply(ctx);
  const cache = join(ctx.workspace, '.claude', 'cache', 'pstack');
  const drifted = spawnSync('git', ['-C', cache, 'remote', 'set-url', 'origin', 'file:///nonexistent/other-remote'], { encoding: 'utf8' });
  assert.equal(drifted.status, 0, drifted.stderr);

  mustApply(ctx);
  const origin = spawnSync('git', ['-C', cache, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(origin, ctx.fixture.url, 'the cache origin was not reset to the layer url');
}, {});

withWorkspace('a second apply is idempotent: the same links, tree hashes, and wrappers', (ctx) => {
  mustApply(ctx);
  const first = readJson(join(ctx.workspace, 'stack.lock.json'));
  mustApply(ctx);
  const second = readJson(join(ctx.workspace, 'stack.lock.json'));
  const trees = (lock) => lock.layers.map((record) => [record.name, record.claude.treeSha256 ?? null, record.opencode.agents]);
  assert.deepEqual(trees(second), trees(first));
  assert.equal(second.copilot.cmdSha256, first.copilot.cmdSha256);
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin')));

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  const drift = driftLines(audit);
  // config, three Claude children, three OpenCode folders, the two Copilot wrappers, the two
  // Pi wrappers, and the Pi settings.
  assert.equal(drift.length, 12, audit.stdout);
  for (const line of drift) assert.match(line, /: matches$/, line);
}, {});

withWorkspace('audit reports drift in every runtime and writes nothing', (ctx) => {
  const before = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(before.status, 0, before.stderr);
  for (const child of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin', 'pstack']) {
    assert.match(before.stdout, new RegExp(`plugins\\\\${child}: missing`), `missing drift for ${child}`);
  }
  assert.match(before.stdout, /plugins\\pstack: missing/);
  assert.match(before.stdout, /copilot\.cmd: missing/);
  assert.match(before.stdout, /pi\.cmd: missing/);
  // The pinned cache is not synced until apply, so the settings cannot be checked before it.
  assert.match(before.stdout, /\.pi\\agent\\settings\.json: unknown until -Apply/);
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'audit created the Claude folder');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'audit created the Copilot folder');
  assert.ok(!existsSync(join(ctx.workspace, 'stack.lock.json')), 'audit wrote the lock');

  mustApply(ctx);
  const skill = join(ctx.workspace, '.claude', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md');
  appendFileSync(skill, 'hand edit\n');

  const drifted = runInstaller(shell, ctx, [], { apply: false });
  assert.match(drifted.stdout, /plugins\\pstack: differs/);
  assert.match(readFileSync(skill, 'utf8'), /hand edit/, 'audit changed the drifted file');

  mustApply(ctx);
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /hand edit/, 'apply restored the copied folder');
}, {});

withWorkspace('a claude runtime without a manifest fails with a clear error', (ctx) => {
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, 'the installer accepted a claude runtime with no manifest');
  assert.match(plainOutput(run), /claude runtime but no \.claude-plugin/);
}, { withManifests: false });

withWorkspace('a claude plugin name that differs from the layer name fails', (ctx) => {
  writeFile(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), '.claude-plugin/plugin.json', JSON.stringify({ name: 'renamed' }));
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0);
  assert.match(plainOutput(run), /is the Claude plugin 'simpsonm09-org-ai-plugin' but its \.claude-plugin\\plugin\.json names 'renamed'/);
}, {});

withWorkspace('copilot without claude is rejected, because the wrapper loads the Claude folder', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = { opencode: {}, copilot: {} };
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted copilot without claude');
  assert.match(plainOutput(run), /declares copilot, which loads the Claude plugin folder, so it also needs claude/);
}, {});

withWorkspace('removing the claude runtime removes only its link and keeps the installed copy', (ctx) => {
  mustApply(ctx);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  const target = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin');
  assert.ok(isLink(child));
  // Not an item in the layer's files list. The folder is wholly the installer's, so the apply removes it.
  writeFile(target, 'keep-me.txt', 'a file the layer does not install\n');

  // copilot runs the Claude folder, so the layer loses both runtimes together.
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-org-ai-plugin').runtimes = { opencode: {} };
  });
  mustApply(ctx, [], { layersFile: layers });

  assert.equal(lstatSync(child, { throwIfNoEntry: false }), undefined, 'the link is gone');
  assert.ok(!existsSync(join(target, 'keep-me.txt')), 'the apply left a file the layer does not install');
  assert.ok(existsSync(join(target, 'index.ts')), 'the target lost its entrypoint');
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin')), 'the personal link was disturbed');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.layers.find((record) => record.name === 'simpsonm09-org-ai-plugin').claude.enabled, false);
}, {});

withWorkspace('LayerSource overrides a local checkout, and now also a git-pinned layer', (ctx) => {
  const alternate = join(ctx.base, 'alternate-org');
  writeLayerStub(alternate, { claudePlugin: 'simpsonm09-org-ai-plugin', extra: { 'from-override.txt': 'override\n' } });
  mustApply(ctx, ['-LayerSource', `simpsonm09-org-ai-plugin=${alternate}`]);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'from-override.txt')));

  // -LayerSource is the local alias of -Source, so it reads pstack from a checkout of the fork as well.
  const pstackCheckout = join(ctx.base, 'pstack-checkout');
  cpSync(join(ctx.fixture.dir), pstackCheckout, { recursive: true });
  mustApply(ctx, ['-LayerSource', `pstack=${pstackCheckout}`]);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'pstack', 'opencode', 'index.ts')), 'pstack was not installed from the checkout');
}, {});

withWorkspace('the installer has no live-server check and no skip switch', (ctx) => {
  // The installer has no live-server check; T3 can reuse a long-lived server.
  assert.doesNotMatch(readFileSync(installer, 'utf8'), /openchamber|SkipLiveServerCheck/i);
  const run = runInstaller(shell, ctx, ['-SkipLiveServerCheck'], { apply: false });
  assert.notEqual(run.status, 0, 'the installer accepted the removed -SkipLiveServerCheck switch');
  assert.match(plainOutput(run), /SkipLiveServerCheck/);
}, {});

withWorkspace('audit with the real layers.json needs no network and writes no runtime files', (ctx) => {
  // The real manifest points pstack at GitHub; audit must not fetch it.
  const args = [
    '-LayerSource',
    `simpsonm09-org-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin')},` +
      `simpsonm09-personal-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-personal-ai-plugin')}`,
  ];
  const run = runInstaller(shell, ctx, args, { apply: false, layersFile: null });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /plugins\\pstack: missing/);
  // The pinned cache is not synced in audit, so the Pi settings cannot be checked yet.
  assert.match(run.stdout, /\.pi\\agent\\settings\.json: unknown until -Apply/);
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'audit wrote under .claude');
  assert.ok(!existsSync(join(ctx.workspace, '.opencode')), 'audit wrote under .opencode');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'audit wrote under .maxstack');
  assert.ok(!existsSync(join(ctx.workspace, '.pi')), 'audit wrote under .pi');
}, {});

// A layer that stops declaring its runtimes leaves its installed folder behind. The first
// apply records that folder, so the next apply removes it.
function withoutPersonalRuntimes(ctx) {
  return writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = {};
  });
}

withWorkspace('a stale plugin folder the previous lock recorded is removed on apply', (ctx) => {
  mustApply(ctx);
  const stale = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin');
  assert.ok(existsSync(join(stale, 'index.ts')), 'the first apply made the folder');

  const run = mustApply(ctx, [], { layersFile: withoutPersonalRuntimes(ctx) });
  assert.match(run.stdout, /Removed the stale plugin folder .*simpsonm09-personal-ai-plugin/);
  assert.ok(!existsSync(stale), 'the stale folder is still there');
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts')), 'the current folder is missing');
  assert.equal(lstatSync(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin'), { throwIfNoEntry: false }), undefined, 'the personal link was not removed');
  assert.deepEqual(readJson(join(ctx.workspace, 'opencode.jsonc')).plugin, ['./.opencode/plugins/pstack/opencode'], 'the config still names pstack');
}, {});

withWorkspace('a stale plugin folder the previous lock never recorded is reported and kept', (ctx) => {
  mustApply(ctx);
  const handMade = join(ctx.workspace, '.opencode', 'plugins', 'hand-made');
  writeFile(handMade, 'notes.txt', 'not the installer\n');

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /Drift: +.*plugins\\hand-made: stale/, audit.stdout);

  const run = mustApply(ctx);
  assert.match(run.stdout, /Drift: +.*plugins\\hand-made: stale, kept/);
  assert.equal(readFileSync(join(handMade, 'notes.txt'), 'utf8'), 'not the installer\n', 'the unrecorded folder changed');
}, {});

withWorkspace('audit reports a stale recorded plugin folder and removes nothing', (ctx) => {
  mustApply(ctx);
  const stale = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin');
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const configPath = join(ctx.workspace, 'opencode.jsonc');
  const lockBefore = readFileSync(lockPath, 'utf8');
  const configBefore = readFileSync(configPath, 'utf8');

  const audit = runInstaller(shell, ctx, [], { apply: false, layersFile: withoutPersonalRuntimes(ctx) });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /plugins\\simpsonm09-personal-ai-plugin: stale/, audit.stdout);
  assert.doesNotMatch(audit.stdout, /Removed the stale plugin folder/);
  assert.ok(existsSync(join(stale, 'index.ts')), 'audit removed the stale folder');
  assert.equal(readFileSync(lockPath, 'utf8'), lockBefore, 'audit rewrote the lock');
  assert.equal(readFileSync(configPath, 'utf8'), configBefore, 'audit rewrote the config');
}, {});

withWorkspace('pi.cmd sets the agent folder and the ask switch, runs the Pi CLI with the arguments, and honours MAXSTACK_PI_BIN', (ctx) => {
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  const text = readFileSync(wrapper, 'utf8');
  assert.match(text, /\r\n/, 'the wrapper has CRLF endings');
  assert.ok(text.includes(`set "PI_CODING_AGENT_DIR=${join(ctx.workspace, '.pi', 'agent')}"`), 'the agent folder is not set');
  assert.ok(text.includes('set "AGENT_ACCESS_PI_ASK=allow"'), 'the ask switch is not set');
  assert.ok(text.includes(`set "PI_BIN=${ctx.fakePi}"`), 'the wrapper does not name the Pi CLI found at install time');

  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --mode rpc "a b""`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes(`AGENT_DIR=${join(ctx.workspace, '.pi', 'agent')}`), run.stdout);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARGS=--mode rpc "a b"/);

  const other = join(ctx.base, 'other-pi.cmd');
  writeFileSync(other, '@echo off\r\necho OTHER=%PI_CODING_AGENT_DIR%\r\n');
  const overridden = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --mode rpc"`], { encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, MAXSTACK_PI_BIN: other } });
  assert.equal(overridden.status, 0, `${overridden.stdout}\n${overridden.stderr}`);
  assert.ok(overridden.stdout.includes(`OTHER=${join(ctx.workspace, '.pi', 'agent')}`), 'MAXSTACK_PI_BIN did not name the CLI that ran');
}, {});

// cmd's call doubles carets and eats a percent sign before the target sees them, so only a
// .cmd or .bat target may go through call. node.exe stands in for an .exe target here.
withWorkspace('pi.cmd passes arguments to an .exe target unchanged', (ctx) => {
  mustApply(ctx);
  const script = join(ctx.base, 'echo-args.js');
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" "${script}" "a^b" "100%""`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    env: { ...process.env, MAXSTACK_PI_BIN: process.execPath },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout), ['a^b', '100%'], 'the wrapper changed the arguments');
}, {});

// pi.sh puts the agent folder inside double quotes, so a dollar sign or a backtick in the baked
// path would change what the shell runs. The cmd wrapper keeps both as plain text, so the run
// stops only on the shell side. Windows allows both characters in a folder name.
test('a workspace path that pi.sh cannot quote stops the run before anything is written', { skip }, () => {
  for (const name of ['sim$pson', 'sim`pson']) {
    const ctx = buildWorkspace();
    try {
      const renamed = join(ctx.base, name);
      renameSync(ctx.workspace, renamed);
      ctx.workspace = renamed;
      const run = runInstaller(shell, ctx);
      assert.notEqual(run.status, 0, `the installer accepted the workspace path ${name}`);
      assert.match(plainOutput(run), /the Pi shell wrapper cannot quote/, run.stdout);
      assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh')), 'pi.sh was written');
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  }
});

withWorkspaceNeeding('bash', findBash(), 'pi.sh runs pi from PATH with the agent folder and the ask switch, and honours MAXSTACK_PI_BIN', (ctx) => {
  const bash = findBash();
  mustApply(ctx);
  const sh = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh'), 'utf8');
  assert.doesNotMatch(sh, /\r/, 'the script has LF endings');
  assert.match(sh, /^export PI_CODING_AGENT_DIR="[^"]*\/\.pi\/agent"$/m);
  assert.match(sh, /^export AGENT_ACCESS_PI_ASK=allow$/m);
  assert.match(sh, /^exec "\$pi_bin" "\$@"$/m);

  const fakeBin = join(ctx.base, 'pi-fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'pi'), '#!/bin/sh\nprintf "AGENT=%s\\n" "$PI_CODING_AGENT_DIR"\nprintf "ASK=%s\\n" "$AGENT_ACCESS_PI_ASK"\nfor arg in "$@"; do printf "ARG=%s\\n" "$arg"; done\n');
  chmodSync(join(fakeBin, 'pi'), 0o755);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`;
  const script = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh').replaceAll('\\', '/');
  const agentDir = join(ctx.workspace, '.pi', 'agent').replaceAll('\\', '/');

  const run = spawnSync(bash, [script, '--mode', 'rpc', 'a b'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes(`AGENT=${agentDir}`), run.stdout);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARG=--mode\nARG=rpc\nARG=a b/, 'the caller arguments follow, unsplit');

  const overrideBin = join(ctx.base, 'override-pi');
  writeFileSync(overrideBin, '#!/bin/sh\nprintf "OVERRIDE=%s\\n" "$1"\n');
  chmodSync(overrideBin, 0o755);
  const noPi = { ...process.env, [pathKey]: '/nonexistent-maxstack-path', MAXSTACK_PI_BIN: overrideBin.replaceAll('\\', '/') };
  const overridden = spawnSync(bash, [script, 'rpc'], { encoding: 'utf8', env: noPi });
  assert.equal(overridden.status, 0, `${overridden.stdout}\n${overridden.stderr}`);
  assert.match(overridden.stdout, /OVERRIDE=rpc/);
}, {});

withWorkspace('the installer writes no Pi model or provider, and a fresh Pi settings file holds only packages and skills', (ctx) => {
  mustApply(ctx);
  const fresh = readJson(join(ctx.workspace, '.pi', 'agent', 'settings.json'));
  assert.deepEqual(Object.keys(fresh).sort(), ['packages', 'skills'], 'the installer wrote a key it does not own');
  assert.ok(!('defaultModel' in fresh) && !('defaultProvider' in fresh), 'the installer named a model or provider');
}, {});

withWorkspace('the Pi settings list each package and skills folder, and keep the keys and entries the installer does not own', (ctx) => {
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    defaultProvider: 'user-provider',
    defaultModel: 'user-model',
    packages: ['../../user/own-package'],
    skills: ['../../user/own-skills'],
  }, null, 2));

  mustApply(ctx);
  const settings = readJson(settingsPath);
  assert.equal(settings.defaultProvider, 'user-provider', 'the installer dropped a key it does not own');
  assert.equal(settings.defaultModel, 'user-model', 'the installer dropped a model the user chose');
  assert.deepEqual(settings.packages, ['../../user/own-package', '../../.claude/cache/pstack'], 'the packages list');
  assert.deepEqual(settings.skills, [
    '../../user/own-skills',
    '../../.claude/plugins/pstack/skills',
    '../../.claude/plugins/simpsonm09-org-ai-plugin/skills',
    '../../.claude/plugins/simpsonm09-personal-ai-plugin/skills',
  ], 'the skills list');
  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual(lock.pi.packages, ['../../.claude/cache/pstack'], 'the lock records only the entries the installer wrote');

  const again = mustApply(ctx);
  assert.match(again.stdout, /Pi settings already match/, 'a second apply rewrote the settings');
  assert.deepEqual(readJson(settingsPath).packages, settings.packages);

  // pstack stops declaring pi. Its entries go, and the user's stay.
  const layers = writeLayers(ctx, (manifest) => {
    delete layerNamed(manifest, 'pstack').runtimes.pi;
  });
  mustApply(ctx, [], { layersFile: layers });
  const dropped = readJson(settingsPath);
  assert.equal(dropped.defaultProvider, 'user-provider');
  assert.deepEqual(dropped.packages, ['../../user/own-package'], 'a layer that dropped pi left its package behind');
  assert.ok(!dropped.skills.includes('../../.claude/plugins/pstack/skills'), 'a layer that dropped pi left its skills behind');
  assert.ok(dropped.skills.includes('../../user/own-skills'), 'the user skills were removed');
}, {});

// Pi accepts package entries as objects, which the user may write with filters. Distinct
// objects are distinct entries: none is collapsed, and their order holds.
withWorkspace('the user object entries in the Pi packages survive a merge, in order, and repeat on a second apply', (ctx) => {
  const alpha = { source: '../../user/alpha', filters: ['a'] };
  const beta = { source: '../../user/beta' };
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ packages: [alpha, '../../user/own', beta] }));

  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath).packages, [alpha, '../../user/own', beta, '../../.claude/cache/pstack']);
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath).packages, [alpha, '../../user/own', beta, '../../.claude/cache/pstack'], 'a second apply changed the user entries');
}, {});

withWorkspace('an entry the user already lists is not written twice', (ctx) => {
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ packages: ['../../.claude/cache/pstack'] }));
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath).packages, ['../../.claude/cache/pstack']);
}, {});

withWorkspace('a local layer is a Pi package only when its package.json names a pi key', (ctx) => {
  writeLayerStub(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), {
    claudePlugin: 'simpsonm09-org-ai-plugin',
    pi: { extensions: ['./pi/index.ts'] },
  });
  mustApply(ctx);
  const settings = readJson(join(ctx.workspace, '.pi', 'agent', 'settings.json'));
  assert.ok(settings.packages.includes('../../.claude/plugins/simpsonm09-org-ai-plugin'), 'the org layer is not a package');
  assert.ok(!settings.packages.includes('../../.claude/plugins/simpsonm09-personal-ai-plugin'), 'a layer without a pi key is a package');
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'pi', 'index.ts')), 'the pi folder is not installed');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.deepEqual(byName['simpsonm09-org-ai-plugin'].pi, {
    enabled: true,
    package: '.claude/plugins/simpsonm09-org-ai-plugin',
    skills: '.claude/plugins/simpsonm09-org-ai-plugin/skills',
  });
  assert.deepEqual(byName['simpsonm09-personal-ai-plugin'].pi, {
    enabled: true,
    package: null,
    skills: '.claude/plugins/simpsonm09-personal-ai-plugin/skills',
  });
}, {});

withWorkspace('a pi key needs package.json in the installed copy, and the run stops without it', (ctx) => {
  const org = join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin');
  writeLayerStub(org, { claudePlugin: 'simpsonm09-org-ai-plugin', pi: { extensions: ['./pi/index.ts'] } });
  // The source keeps the package.json that names the pi key, but the files list leaves it out,
  // so the installed copy has the pi folder and no package.json for Pi to read.
  const layerPath = join(org, 'layer.json');
  const layer = readJson(layerPath);
  writeFile(org, 'layer.json', JSON.stringify({ ...layer, files: layer.files.filter((file) => file !== 'package.json') }));

  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, 'the installer accepted a pi key whose installed copy has no package.json');
  assert.match(plainOutput(run), /has a pi key in its package\.json, but its installed copy at .* has no package\.json/);
}, {});

withWorkspace('a pi key that names a file the installed copy lacks is refused', (ctx) => {
  writeLayerStub(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), {
    claudePlugin: 'simpsonm09-org-ai-plugin',
    pi: { extensions: ['./pi/missing.ts'] },
  });
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, 'the installer accepted a pi key that names a missing file');
  assert.match(plainOutput(run), /names the extensions entry \.\/pi\/missing\.ts in its package\.json pi key, but .* does not carry it/);
}, {});

withWorkspace('a pi runtime without claude is rejected, because the Pi settings list the Claude folder skills', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = { opencode: {}, pi: {} };
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted pi without claude');
  assert.match(plainOutput(run), /declares pi, which lists the Claude plugin folder's skills, so it also needs claude/);
}, {});

withWorkspace('pi is skipped with a message when no executable is found, and its settings still list the layers', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')));

  const run = mustApply(ctx, ['-PiCommand', MISSING_PI]);
  assert.match(plainOutput(run), /Pi CLI not found/, run.stdout);
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')), 'the Pi wrapper is still there');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh')), 'the Pi script is still there');
  assert.ok(existsSync(join(ctx.workspace, '.pi', 'agent', 'settings.json')), 'the settings were not written without the CLI');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.pi.enabled, false);
  assert.match(lock.pi.reason, /no 'maxstack-test-no-such-pi' application/);
  assert.ok(lock.layers.every((record) => record.opencode.enabled), 'the OpenCode runtimes still install');
}, {});

withWorkspaceNeeding('python', python, 'the verifier fails when a configured CLI is on PATH but its wrapper was never generated', (ctx) => {
  mustApply(ctx, ['-PiCommand', MISSING_PI]);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const cliDir = join(ctx.base, 'cli-on-path');
  mkdirSync(cliDir);
  const fakePi = writeFakeCli(cliDir, 'pi');
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${cliDir}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`;
  assert.ok(fakePi.startsWith(cliDir));

  const run = spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8', env });
  assert.notEqual(run.status, 0, 'the verifier passed with the Pi CLI on PATH and no Pi wrapper');
  assert.match(plainOutput(run), /the pi CLI is on PATH.*rerun Install-Workspace\.ps1 -Apply/);
}, {});

// T3 spawns binaryPath directly, so the .sh wrappers need the executable bit off Windows.
// Windows has no mode bits to check, so only those assertions are skipped there.
test('the shell wrappers are executable off Windows, and the verifier checks the bit', { skip }, async (t) => {
  const posix = process.platform !== 'win32';
  const ctx = buildWorkspace();
  try {
    const extra = posix
      ? ['-PiCommand', writeFakeCli(ctx.base, 'stand-in-pi'), '-CopilotCommand', writeFakeCli(ctx.base, 'stand-in-copilot')]
      : [];
    mustApply(ctx, extra);
    const bin = join(ctx.workspace, '.maxstack', 'bin');
    const home = join(ctx.base, 'home');
    mkdirSync(home);
    const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });

    await t.test('pi.sh and copilot.sh have the executable bit', { skip: posix ? false : 'the executable bit is POSIX-only' }, () => {
      for (const name of ['pi.sh', 'copilot.sh']) {
        assert.notEqual(statSync(join(bin, name)).mode & 0o111, 0, `${name} is not executable`);
      }
    });

    await t.test('the verifier fails when the bit is missing, and passes once it is back', { skip: !python || !posix ? 'needs POSIX and python' : false }, () => {
      chmodSync(join(bin, 'pi.sh'), 0o644);
      const missing = verify();
      assert.notEqual(missing.status, 0, 'the verifier accepted a Pi script that is not executable');
      assert.match(plainOutput(missing), /pi\.sh is not executable/);
      chmodSync(join(bin, 'pi.sh'), 0o755);
      assert.equal(verify().status, 0);
    });
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

// The wrapper target filter, called with each platform as a parameter, so the macOS cases run
// on Windows too. The harness takes the function's text from the installer's own parse tree.
const WRAPPER_TARGET_CASES = [
  ['/opt/homebrew/bin/pi', false, true],
  ['/usr/local/bin/copilot', false, true],
  ['/opt/homebrew/bin/pi.ps1', false, false],
  ['/opt/homebrew/bin/pi.cmd', false, false],
  ['C:\\tools\\pi.exe', true, true],
  ['C:\\tools\\pi.cmd', true, true],
  ['C:\\tools\\pi.bat', true, true],
  ['C:\\tools\\pi.ps1', true, false],
  ['/opt/homebrew/bin/pi', true, false],
];

function wrapperTargetHarness(cases) {
  const rows = cases
    .map(([path, windows]) => `  [pscustomobject]@{ path = '${path.replaceAll("'", "''")}'; windows = ${windows ? '$true' : '$false'} }`)
    .join(',\n');
  return `param([string] $Installer)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref] $tokens, [ref] $errors)
$definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-WrapperTarget' }, $true) | Select-Object -First 1
if (-not $definition) { throw 'Test-WrapperTarget is not defined in the installer' }
Invoke-Expression $definition.Extent.Text
$cases = @(
${rows}
)
$results = foreach ($case in $cases) {
  [pscustomobject]@{ path = $case.path; windows = $case.windows; accepted = [bool] (Test-WrapperTarget -Path $case.path -Windows $case.windows) }
}
ConvertTo-Json -InputObject @($results) -Depth 3 -Compress
`;
}

test('a wrapper takes an extensionless CLI off Windows, and refuses PowerShell and cmd shims on each platform', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-target-'));
  try {
    const harness = join(dir, 'harness.ps1');
    writeFileSync(harness, wrapperTargetHarness(WRAPPER_TARGET_CASES));
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', harness, installer], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const results = JSON.parse(run.stdout);
    for (const [path, windows, accepted] of WRAPPER_TARGET_CASES) {
      const row = results.find((result) => result.path === path && result.windows === windows);
      assert.equal(row?.accepted, accepted, `${path} on ${windows ? 'Windows' : 'macOS or Linux'}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

withWorkspaceNeeding('python', python, 'the workspace verifier passes after an apply and flags a hand-edited Copilot wrapper', (ctx) => {
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });

  const passed = verify();
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.match(passed.stdout, /PASS: workspace bundle present/);

  const cmd = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  appendFileSync(cmd, 'rem hand edit\r\n');
  const edited = verify();
  assert.notEqual(edited.status, 0, 'the verifier accepted an edited wrapper');
  assert.match(plainOutput(edited), /copilot\.cmd differs from the text recorded in stack\.lock\.json/);
}, {});

// The hash check passes here, because the lock is updated to the edited script. What remains
// is the folder the script names, which the verifier must compare to the workspace's.
withWorkspaceNeeding('python', python, 'the verifier compares the agent folder in pi.sh with the workspace, not just its presence', (ctx) => {
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  const shPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh');
  const lockPath = join(ctx.workspace, 'stack.lock.json');

  const text = readFileSync(shPath, 'utf8');
  const tampered = text.replace(/^export PI_CODING_AGENT_DIR=".*"$/m, 'export PI_CODING_AGENT_DIR="/tmp/elsewhere/.pi/agent"');
  assert.notEqual(tampered, text, 'the test did not change the agent folder line');
  writeFileSync(shPath, tampered);
  const lock = readJson(lockPath);
  lock.pi.shSha256 = createHash('sha256').update(tampered).digest('hex').toUpperCase();
  writeFileSync(lockPath, JSON.stringify(lock));

  const wrong = verify();
  assert.notEqual(wrong.status, 0, 'the verifier accepted a pi.sh that names another agent folder');
  assert.match(plainOutput(wrong), /pi\.sh does not set PI_CODING_AGENT_DIR to /);

  mustApply(ctx);
  assert.equal(verify().status, 0);
}, {});

withWorkspaceNeeding('python', python, 'the workspace verifier checks the Pi wrappers and the Pi settings', (ctx) => {
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');

  const passed = verify();
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);

  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh'), '# hand edit\n');
  const edited = verify();
  assert.notEqual(edited.status, 0, 'the verifier accepted an edited Pi script');
  assert.match(plainOutput(edited), /pi\.sh differs from the text recorded in stack\.lock\.json/);

  mustApply(ctx);
  const settings = readJson(settingsPath);
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ ...settings, packages: [] }));
  const unlisted = verify();
  assert.notEqual(unlisted.status, 0, 'the verifier accepted settings without a recorded package');
  assert.match(plainOutput(unlisted), /does not list the Pi packages entry \.\.\/\.\.\/\.claude\/cache\/pstack/);

  mustApply(ctx);
  const restored = verify();
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
}, {});

// The ownership record and -Status. A status run reads the record and the disk, and writes
// nothing, so each test checks the files it could have changed.
const lockPath = (ctx) => join(ctx.workspace, 'stack.lock.json');
const settingsPath = (ctx) => join(ctx.workspace, '.pi', 'agent', 'settings.json');
const verifyWorkspaceScript = join(repoRoot, 'scripts', 'verify-workspace-install.py');
const verifyManifestsScript = join(repoRoot, 'scripts', 'verify-manifests.py');

function runStatus(ctx, extra = []) {
  return runInstaller(shell, ctx, ['-Status', ...extra], { apply: false });
}

// The status report: one "<state> <label>" line per path, then a summary line.
function statusRows(run) {
  return run.stdout
    .split(/\r?\n/)
    .map((line) => /^(matching|drifted|modified|missing|untracked)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map(([, state, label]) => ({ state, label: label.trim() }));
}

function problemRows(run) {
  return statusRows(run).filter((row) => row.state !== 'matching');
}

withWorkspace('apply records an owned entry for every path it wrote, and the record validates', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.ownedSchema, 2, 'the record has no schema version');
  const owned = lock.owned;
  for (const record of owned) {
    assert.ok('runtime' in record && 'layers' in record, `${record.path} names no runtime and layers`);
  }
  assert.deepEqual(owned.find((record) => record.path === '.opencode/plugins/simpsonm09-org-ai-plugin').layers, ['simpsonm09-org-ai-plugin']);
  assert.equal(owned.find((record) => record.path === '.maxstack/bin/pi.cmd').runtime, 'pi');
  assert.equal(owned.find((record) => record.path === '.claude/cache/pstack').runtime, null, 'the claude cache belongs to no runtime');
  const find = (path, kind, key) => owned.find((record) => record.path === path && record.kind === kind && (key === undefined || record.key === key));

  assert.match(find('opencode.jsonc', 'file').sha256, /^[0-9A-F]{64}$/);
  for (const plugin of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    assert.equal(find(`.claude/plugins/${plugin}`, 'link').target, `.opencode/plugins/${plugin}`, `the link of ${plugin}`);
  }
  assert.match(find('.claude/plugins/pstack', 'dir').sha256, /^[0-9A-F]{64}$/);
  assert.match(find('.claude/cache/pstack', 'dir').sha256, /^[0-9A-F]{64}$/);
  for (const plugin of ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    assert.match(find(`.opencode/plugins/${plugin}`, 'dir').sha256, /^[0-9A-F]{64}$/, `the OpenCode folder of ${plugin}`);
  }
  for (const agent of ['pstack-agent.md', 'pstack-reviewer.md', 'pstack-comment-sicko.md']) {
    assert.match(find(`.opencode/agents/${agent}`, 'file').sha256, /^[0-9A-F]{64}$/, `the profile ${agent}`);
  }
  for (const wrapper of ['copilot.cmd', 'copilot.sh', 'pi.cmd', 'pi.sh']) {
    assert.match(find(`.maxstack/bin/${wrapper}`, 'file').sha256, /^[0-9A-F]{64}$/, `the wrapper ${wrapper}`);
  }
  assert.deepEqual(find('.pi/agent/settings.json', 'json-entries', 'packages').entries, ['../../.claude/cache/pstack']);
  assert.equal(find('.pi/agent/settings.json', 'json-entries', 'skills').entries.length, 3, 'one skills entry per layer folder');

  assert.ok(!owned.some((record) => record.path === 'stack.lock.json'), 'the lock records itself');
  assert.equal(owned.length, 17, 'one record per path the install wrote; the two Pi lists hold one record each');
  for (const name of readdirSync(join(ctx.workspace, '.maxstack', 'bin'))) {
    assert.ok(find(`.maxstack/bin/${name}`, 'file'), `${name} is written but not recorded`);
  }
  for (const name of readdirSync(join(ctx.workspace, '.opencode', 'agents'))) {
    assert.ok(find(`.opencode/agents/${name}`, 'file'), `${name} is written but not recorded`);
  }

  const check = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
}, {});

withWorkspace('a second apply with nothing to change leaves the lock byte-identical except generatedAt', (ctx) => {
  mustApply(ctx);
  const first = readFileSync(lockPath(ctx), 'utf8');
  mustApply(ctx);
  const second = readFileSync(lockPath(ctx), 'utf8');
  const withoutTime = (text) => text.replace(/"generatedAt":\s*"[^"]*"/, '"generatedAt": ""');
  assert.ok(readJson(lockPath(ctx)).owned.length > 0, 'the record is empty');
  assert.equal(withoutTime(second), withoutTime(first));
}, {});

withWorkspace('status reports every owned path as matching after an apply, and writes nothing', (ctx) => {
  mustApply(ctx);
  const lockBefore = readFileSync(lockPath(ctx), 'utf8');
  const settingsBefore = readFileSync(settingsPath(ctx), 'utf8');

  const run = runStatus(ctx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(statusRows(run).length, 19, run.stdout);
  assert.deepEqual([...new Set(statusRows(run).map((row) => row.state))], ['matching'], run.stdout);
  assert.match(run.stdout, /Summary: 19 matching, 0 drifted, 0 modified, 0 missing, 0 untracked/);
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, '-Strict failed on a matching workspace');

  assert.equal(readFileSync(lockPath(ctx), 'utf8'), lockBefore, 'status rewrote the lock');
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), settingsBefore, 'status rewrote the Pi settings');
}, {});

withWorkspace('status reports a hand-edited file as modified, and -Strict fails on it', (ctx) => {
  mustApply(ctx);
  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'rem hand edit\r\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: '.maxstack/bin/copilot.cmd' }], run.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 1, '-Strict accepted a modified file');
}, {});

withWorkspace('status reports a deleted file as missing', (ctx) => {
  mustApply(ctx);
  rmSync(join(ctx.workspace, '.opencode', 'agents', 'pstack-reviewer.md'));
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'missing', label: '.opencode/agents/pstack-reviewer.md' }], run.stdout);
}, {});

withWorkspace('status reports a removed Pi entry alone, and never reports a key the installer does not own', (ctx) => {
  mustApply(ctx);
  const settings = readJson(settingsPath(ctx));
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    ...settings,
    defaultModel: 'user-model',
    packages: settings.packages.filter((entry) => entry !== '../../.claude/cache/pstack'),
  }, null, 2));
  const before = readFileSync(settingsPath(ctx), 'utf8');

  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  const problems = problemRows(run);
  assert.equal(problems.length, 1, run.stdout);
  assert.equal(problems[0].state, 'missing');
  assert.match(problems[0].label, /^\.pi\/agent\/settings\.json \[packages\] "\.\.\/\.\.\/\.claude\/cache\/pstack"$/, run.stdout);
  assert.doesNotMatch(run.stdout, /defaultModel|user-model/, 'status reported a key the installer does not own');
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), before, 'status rewrote the Pi settings');
}, {});

withWorkspace('a layer source that changed since the apply is drifted, not modified', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin/skills/new-skill/SKILL.md', '---\nname: new-skill\ndescription: fixture\n---\nbody\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'drifted', label: '.opencode/plugins/simpsonm09-org-ai-plugin' }], run.stdout);

  mustApply(ctx);
  assert.deepEqual(problemRows(runStatus(ctx)), [], 'an apply did not bring the record back to matching');
}, {});

withWorkspace('a file in .maxstack/bin that the record does not name is untracked', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, '.maxstack/bin/notes.txt', 'not the installer\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'untracked', label: '.maxstack/bin/notes.txt' }], run.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 1, '-Strict accepted an untracked file');
}, {});

withWorkspace('a file a user adds to an owned folder is modified, and the next apply removes it', (ctx) => {
  mustApply(ctx);
  const folder = '.opencode/plugins/simpsonm09-org-ai-plugin';
  writeFile(ctx.workspace, `${folder}/notes.txt`, 'mine\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: folder }], run.stdout);

  const applied = mustApply(ctx);
  assert.match(applied.stdout, /Removed .*notes\.txt: the layer does not install it/, applied.stdout);
  assert.ok(!existsSync(join(ctx.workspace, ...folder.split('/'), 'notes.txt')), 'the apply kept the user file');
  assert.deepEqual(problemRows(runStatus(ctx)), [], 'the apply did not bring the folder back to matching');
}, {});

withWorkspace('the package-lock.json that npm writes beside an installed package.json is removed, and reported until then', (ctx) => {
  mustApply(ctx);
  const folder = '.opencode/plugins/simpsonm09-org-ai-plugin';
  writeFile(ctx.workspace, `${folder}/package-lock.json`, '{}\n');
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: folder }]);
  const applied = mustApply(ctx);
  assert.match(applied.stdout, /Removed .*package-lock\.json/, applied.stdout);
  assert.ok(!existsSync(join(ctx.workspace, ...folder.split('/'), 'package-lock.json')));
}, {});

// The pstack OpenCode entry is opencode/index.ts, so npm installs in opencode/ and writes its lock there. The
// pinned folder ships no lock, so an apply removes the one npm wrote, and the folder then matches its plan.
const PSTACK_FOLDER = '.opencode/plugins/pstack';
const PSTACK_NPM_FOLDER = `${PSTACK_FOLDER}/opencode`;
const NPM = { fixture: { npm: true } };

function workspacePath(ctx, rel) {
  return join(ctx.workspace, ...rel.split('/'));
}

withWorkspace('an npm install beside a pstack package.json applies, leaves no lock file, and records the folder', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/node_modules/@opencode/plugin/index.js`)), 'npm did not install the dependency');
  assert.equal(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`)), false, 'the lock npm wrote stayed in the folder');
  assert.ok(ownedRecord(readJson(lockPath(ctx)), PSTACK_FOLDER, 'dir'), 'the pstack folder has no ownership record');
}, NPM);

withWorkspace('after an npm install every owned path matches, and a file added to the pstack folder by hand is modified', (ctx) => {
  mustApply(ctx);
  const run = runStatus(ctx);
  assert.deepEqual(problemRows(run), [], run.stdout);
  assert.deepEqual(statusRows(run).find((row) => row.label === PSTACK_FOLDER), { state: 'matching', label: PSTACK_FOLDER });
  writeFile(ctx.workspace, `${PSTACK_FOLDER}/hand-added.md`, 'added by hand\n');
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: PSTACK_FOLDER }]);
}, NPM);

withWorkspace('a round trip through an npm install leaves the tree byte-identical to the start', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, NPM);

withWorkspace('an npm install that writes a file beyond its lock and node_modules fails the apply, and writes no record', (ctx) => {
  ctx.env.FAKE_NPM_EXTRA = `${PSTACK_NPM_FOLDER}/extra.txt`;
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(plainOutput(run), /\.opencode\/plugins\/pstack holds different content from what the install wrote/);
  assert.equal(existsSync(lockPath(ctx)), false, 'a record was written from a folder that differs from the plan');
}, NPM);

withWorkspace('a package-lock.json the layer ships is put back as shipped when npm rewrites it', (ctx) => {
  ctx.env.FAKE_NPM_REWRITE = '1';
  mustApply(ctx);
  assert.equal(readFileSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`), 'utf8'), SHIPPED_LOCK, 'the folder does not hold the lock the layer ships');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, { fixture: { npm: true, shipLock: true } });

withWorkspace('a read-only package-lock.json the layer ships survives a second apply when npm is skipped', (ctx) => {
  mustApply(ctx);
  const cachedLock = workspacePath(ctx, '.claude/cache/pstack/plugins/pstack/opencode/package-lock.json');
  const installedLock = workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`);
  chmodSync(cachedLock, 0o444);
  try {
    mustApply(ctx);
    assert.deepEqual(problemRows(runStatus(ctx)), []);
    assert.equal(readFileSync(installedLock, 'utf8'), SHIPPED_LOCK, 'the second apply changed the shipped lock');
  } finally {
    chmodSync(cachedLock, 0o666);
    if (existsSync(installedLock)) chmodSync(installedLock, 0o666);
  }
}, { fixture: { shipLock: true } });

withWorkspace('an npm-shrinkwrap.json the layer ships is put back as shipped when npm rewrites it', (ctx) => {
  ctx.env.FAKE_NPM_REWRITE = '1';
  mustApply(ctx);
  assert.equal(readFileSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/npm-shrinkwrap.json`), 'utf8'), SHIPPED_SHRINKWRAP, 'the folder does not hold the shrinkwrap the layer ships');
  assert.equal(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`)), false, 'npm wrote a package-lock.json beside the shipped shrinkwrap');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, { fixture: { npm: true, shipShrinkwrap: true } });

withWorkspace('an npm-shrinkwrap.json npm generates, where none was shipped, is removed', (ctx) => {
  ctx.env.FAKE_NPM_SHRINKWRAP = '1';
  mustApply(ctx);
  assert.equal(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/npm-shrinkwrap.json`)), false, 'the shrinkwrap npm generated stayed in the folder');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, NPM);

withWorkspace('a lock without an owned list gets the clear message, and -Strict fails on it', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete lock.owned;
  delete lock.ownedSchema;
  writeFileSync(lockPath(ctx), JSON.stringify(lock));

  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no ownership record; run -Apply once to create it/, run.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 1, '-Strict accepted a workspace with no record');

  mustApply(ctx);
  assert.ok(readJson(lockPath(ctx)).owned.length > 0, 'apply did not create the record');
}, {});

withWorkspace('a workspace with no lock has no ownership record, and status writes no lock', (ctx) => {
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no ownership record; run -Apply once to create it/, run.stdout);
  assert.ok(!existsSync(lockPath(ctx)), 'status wrote a lock');
}, {});

withWorkspace('-Status and -Apply together are refused', (ctx) => {
  const run = runInstaller(shell, ctx, ['-Status']);
  assert.notEqual(run.status, 0, 'the installer accepted -Status with -Apply');
  assert.match(plainOutput(run), /Choose one/);
}, {});

withWorkspaceNeeding('python', python, 'the workspace verifier checks each owned path against the disk and refuses a malformed record', (ctx) => {
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  assert.equal(verify().status, 0, 'the verifier refused a fresh apply');

  const lock = readJson(lockPath(ctx));
  lock.owned.find((record) => record.path === '.opencode/agents/pstack-reviewer.md').sha256 = 'F'.repeat(64);
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const drifted = verify();
  assert.notEqual(drifted.status, 0, 'the verifier accepted a file that differs from its owned hash');
  assert.match(plainOutput(drifted), /owned file .*pstack-reviewer\.md differs/);

  mustApply(ctx);
  const malformed = readJson(lockPath(ctx));
  malformed.owned[0].path = 'opencode\\jsonc';
  writeFileSync(lockPath(ctx), JSON.stringify(malformed));
  const badPath = verify();
  assert.notEqual(badPath.status, 0, 'the verifier accepted a backslash path');
  assert.match(plainOutput(badPath), /path must be a workspace-relative path with forward slashes/);

  mustApply(ctx);
  const unowned = readJson(lockPath(ctx));
  delete unowned.owned;
  writeFileSync(lockPath(ctx), JSON.stringify(unowned));
  assert.match(plainOutput(verify()), /has no owned list; rerun Install-Workspace\.ps1 -Apply/);
}, {});

// Round two: the ownership record is a claim about the disk, so each test below checks one claim
// against a value this file computes itself, never against the installer's own output.
function sha256Upper(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function sortUtf8(lines) {
  return [...lines].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

function linkTargetText(path) {
  let target = readlinkSync(path);
  for (const prefix of ['\\\\?\\', '\\??\\']) {
    if (target.startsWith(prefix)) target = target.slice(prefix.length);
  }
  return target.replace(/\\+$/, '');
}

// A tree hash computed here. Owned: node_modules and .git are left out at any depth. Legacy: only a
// top-level node_modules, without regard to case, is left out. Links are listed, never followed.
function independentSha(root, rule) {
  const lines = [];
  collectTreeLines(root, '', rule, lines);
  return sha256Upper(Buffer.from(sortUtf8(lines).map((line) => `${line}\n`).join(''), 'utf8'));
}

// Whether a folder is left out of the hash: by its name alone under the owned rule, and only at the
// top of the tree under the legacy rule.
function isLeftOut(name, prefix, rule) {
  if (rule === 'owned') return name === 'node_modules' || name === '.git';
  return prefix === '' && name.toLowerCase() === 'node_modules';
}

// The lines of one folder's entries, recursing into the folders that are not left out.
function collectTreeLines(dir, prefix, rule, lines) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      lines.push(`${relative}\tlink:${linkTargetText(full)}`);
    } else if (stat.isDirectory()) {
      if (!isLeftOut(name, prefix, rule)) collectTreeLines(full, relative, rule, lines);
    } else {
      lines.push(`${relative}\t${sha256Upper(readFileSync(full))}`);
    }
  }
}

function ownedRecord(lock, path, kind, key = '') {
  return lock.owned.find((record) => record.path === path && record.kind === kind && (record.key ?? '') === key);
}

const ORG_FOLDER = '.opencode/plugins/simpsonm09-org-ai-plugin';
const ORG_SOURCE = 'projects/repos/simpsonm09-org-ai-plugin';

withWorkspace('the recorded hashes match an independent recomputation, and each link names its target', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const at = (path) => join(ctx.workspace, ...path.split('/'));

  assert.equal(ownedRecord(lock, 'opencode.jsonc', 'file').sha256, sha256Upper(readFileSync(at('opencode.jsonc'))));
  for (const folder of ['.opencode/plugins/pstack', ORG_FOLDER, '.opencode/plugins/simpsonm09-personal-ai-plugin', '.claude/plugins/pstack', '.claude/cache/pstack']) {
    assert.equal(ownedRecord(lock, folder, 'dir').sha256, independentSha(at(folder), 'owned'), `the tree hash of ${folder}`);
  }
  for (const wrapper of ['copilot.cmd', 'copilot.sh', 'pi.cmd', 'pi.sh']) {
    assert.equal(ownedRecord(lock, `.maxstack/bin/${wrapper}`, 'file').sha256, sha256Upper(readFileSync(at(`.maxstack/bin/${wrapper}`))), wrapper);
  }
  assert.equal(ownedRecord(lock, '.opencode/agents/pstack-agent.md', 'file').sha256, sha256Upper(readFileSync(at('.opencode/agents/pstack-agent.md'))));
  assert.equal(ownedRecord(lock, '.claude/plugins/simpsonm09-org-ai-plugin', 'link').target, ORG_FOLDER);
  assert.deepEqual(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').entries, ['../../.claude/cache/pstack']);
  const check = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
}, {});

withWorkspace('names sort by code point, and the tree hash keeps case, emoji, and fullwidth names exact', (ctx) => {
  // Node_Modules is an item, not npm's folder, so it is hashed. An emoji name sorts after a fullwidth
  // one by code point, and before it by UTF-16, so a sort in the wrong order changes the hash.
  const org = join(ctx.workspace, ...ORG_SOURCE.split('/'));
  writeFile(org, 'Node_Modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeFile(org, 'Package-Lock.json', '{"lockfileVersion": 3}\n');
  writeFile(org, '\u{1F642}-emoji/a.txt', 'emoji\n');
  writeFile(org, 'Ａ-fullwidth/b.txt', 'fullwidth\n');
  writeFile(org, 'layer.json', JSON.stringify({
    files: ['index.ts', 'Node_Modules', 'Package-Lock.json', '\u{1F642}-emoji', 'Ａ-fullwidth', 'package.json', 'skills', '.claude-plugin'],
  }));
  mustApply(ctx);
  const folder = join(ctx.workspace, ...ORG_FOLDER.split('/'));
  assert.ok(existsSync(join(folder, 'Node_Modules', '@opencode', 'plugin', 'index.js')));
  assert.ok(existsSync(join(folder, 'Package-Lock.json')), 'the item named Package-Lock.json was not kept');
  assert.ok(existsSync(join(folder, '\u{1F642}-emoji', 'a.txt')));
  assert.ok(existsSync(join(folder, 'Ａ-fullwidth', 'b.txt')));
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, ORG_FOLDER, 'dir').sha256, independentSha(folder, 'owned'));
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a junction inside an owned folder is hashed as a link, never followed, and the apply removes it and keeps its target', (ctx) => {
  mustApply(ctx);
  const folder = join(ctx.workspace, ...ORG_FOLDER.split('/'));
  const outside = join(ctx.base, 'outside');
  writeFile(ctx.base, 'outside/keep.txt', 'outside the workspace\n');
  symlinkSync(outside, join(folder, 'outside-link'), 'junction');

  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: ORG_FOLDER }], run.stdout);

  const applied = mustApply(ctx);
  assert.match(applied.stdout, /Removed .*outside-link/, applied.stdout);
  assert.ok(existsSync(join(outside, 'keep.txt')), 'the apply deleted the junction target');
  assert.equal(lstatSync(join(folder, 'outside-link'), { throwIfNoEntry: false }), undefined, 'the junction is still there');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a junction that loops back into its own folder neither hangs the status nor survives the apply', (ctx) => {
  mustApply(ctx);
  const folder = join(ctx.workspace, ...ORG_FOLDER.split('/'));
  symlinkSync(folder, join(folder, 'loop'), 'junction');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: ORG_FOLDER }], run.stdout);
  mustApply(ctx);
  assert.equal(lstatSync(join(folder, 'loop'), { throwIfNoEntry: false }), undefined, 'the loop is still there');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a link retargeted by hand is modified, and a file changed in a pinned claude copy is modified', (ctx) => {
  mustApply(ctx);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  rmdirSync(child);
  const other = join(ctx.base, 'other-target');
  mkdirSync(other);
  symlinkSync(other, child, 'junction');
  appendFileSync(join(ctx.workspace, '.claude', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md'), 'edit\n');

  assert.deepEqual(problemRows(runStatus(ctx)), [
    { state: 'modified', label: '.claude/plugins/pstack' },
    { state: 'modified', label: '.claude/plugins/simpsonm09-org-ai-plugin' },
  ]);
  mustApply(ctx);
  assert.equal(realpathSync(child).toLowerCase(), realpathSync(join(ctx.workspace, ...ORG_FOLDER.split('/'))).toLowerCase());
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('node_modules and .git folders nested in an owned folder are not part of its hash', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, `${ORG_FOLDER}/skills/demo/node_modules/pkg/index.js`, 'module.exports = {};\n');
  writeFile(ctx.workspace, `${ORG_FOLDER}/skills/demo/.git/HEAD`, 'ref: refs/heads/main\n');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('an unsynced pinned cache reports only the entries it cannot know, each once', (ctx) => {
  mustApply(ctx);
  // The pin moves to a commit the cache has not fetched: pstack's folders and entries are unknown.
  writeFileSync(join(ctx.fixture.dir, 'bump.txt'), 'bump\n');
  const commit = (args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-C', ctx.fixture.dir, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  commit(['add', '-A']);
  commit(['commit', '-q', '-m', 'bump']);
  const moved = commit(['rev-parse', 'HEAD']);
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'pstack').source.commit = moved;
  });

  const run = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: layers });
  assert.equal(run.status, 0, run.stderr);
  const problems = problemRows(run);
  assert.ok(problems.length > 0, run.stdout);
  assert.ok(problems.every((row) => row.state === 'drifted'), run.stdout);
  assert.ok(problems.every((row) => row.label.includes('pstack')), `a local layer is reported: ${run.stdout}`);
  const labels = problems.map((row) => row.label);
  assert.equal(new Set(labels).size, labels.length, `a path is reported twice: ${run.stdout}`);
  const localSkills = problems.filter((row) => /simpsonm09-(org|personal)-ai-plugin\/skills/.test(row.label));
  assert.deepEqual(localSkills, [], `a local layer's entry was reported: ${run.stdout}`);
}, {});

withWorkspace('a lock from before the ownership record reads quietly, and the claude hashes keep the legacy rule', (ctx) => {
  // A nested node_modules is part of the legacy hash, because that rule leaves out only the top level.
  writeFile(ctx.workspace, `${ORG_SOURCE}/skills/legacy/node_modules/pkg/index.js`, 'module.exports = {};\n');
  mustApply(ctx);
  const current = readJson(lockPath(ctx));
  const orgLayer = current.layers.find((record) => record.name === 'simpsonm09-org-ai-plugin');
  assert.equal(orgLayer.claude.treeSha256, independentSha(join(ctx.workspace, ...ORG_FOLDER.split('/')), 'legacy'));

  const legacy = { ...current };
  for (const field of ['owned', 'ownedSchema', 'createdDirs', 'createdFiles']) delete legacy[field];
  writeFileSync(lockPath(ctx), JSON.stringify(legacy));

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  const drift = driftLines(audit);
  assert.equal(drift.length, 12, audit.stdout);
  for (const line of drift) assert.match(line, /: matches$/, line);
  assert.match(runStatus(ctx).stdout, /no ownership record; run -Apply once to create it/);

  mustApply(ctx);
  assert.equal(readJson(lockPath(ctx)).ownedSchema, 2);
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a Pi entry the user already lists is the user\'s: the record does not hold it, and a second apply keeps it so', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    packages: ['../../.claude/cache/pstack'],
    skills: ['../../.claude/plugins/pstack/skills', '../../.claude/plugins/simpsonm09-org-ai-plugin/skills', '../../.claude/plugins/simpsonm09-personal-ai-plugin/skills'],
  }));
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.owned.filter((record) => record.kind === 'json-entries').length, 0, 'the installer claimed entries the user already had');
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack']);
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack'], 'a second apply added a copy');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a copy the user wrote beside an installer entry stays the user\'s, and the record holds one copy', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    ...readJson(settingsPath(ctx)),
    packages: ['../../.claude/cache/pstack', '../../.claude/cache/pstack'],
  }));
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack', '../../.claude/cache/pstack']);
  const record = ownedRecord(readJson(lockPath(ctx)), '.pi/agent/settings.json', 'json-entries', 'packages');
  assert.deepEqual(record.entries, ['../../.claude/cache/pstack'], 'the record holds more than the installer copy');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('an apply over a legacy lock keeps one copy of an entry that lock lists under pi, and records it', (ctx) => {
  mustApply(ctx);
  // The legacy lock lists the entry under pi, and the settings hold one copy; the stand-in rule owns it.
  const current = readJson(lockPath(ctx));
  const legacy = { ...current };
  for (const field of ['owned', 'ownedSchema', 'createdDirs', 'createdFiles']) delete legacy[field];
  writeFileSync(lockPath(ctx), JSON.stringify(legacy));
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack'], 'the legacy apply duplicated the entry');
  assert.deepEqual(ownedRecord(readJson(lockPath(ctx)), '.pi/agent/settings.json', 'json-entries', 'packages').entries, ['../../.claude/cache/pstack']);
}, {});

withWorkspace('a layer that declares no Pi entries records none, and the apply still writes the settings file', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    delete layerNamed(manifest, 'pstack').runtimes.pi;
  });
  for (const name of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    const root = join(ctx.workspace, 'projects', 'repos', name);
    const layer = readJson(join(root, 'layer.json'));
    writeFile(root, 'layer.json', JSON.stringify({ ...layer, files: layer.files.filter((file) => file !== 'skills') }));
    rmSync(join(root, 'skills'), { recursive: true, force: true });
  }
  mustApply(ctx, [], { layersFile: layers });
  assert.equal(readJson(lockPath(ctx)).owned.filter((record) => record.kind === 'json-entries').length, 0);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, []);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: layers });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(problemRows(status), [], 'an empty Pi list was reported');
}, {});

withWorkspace('the record names the directories and files the installer created, and not the ones that were there first', (ctx) => {
  writeFile(ctx.workspace, '.maxstack/notes.txt', 'mine\n');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ defaultProvider: 'user-provider' }));
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.ok(!lock.createdDirs.includes('.maxstack'), 'the folder that was there first is listed as created');
  assert.ok(!lock.createdDirs.includes('.pi'), 'the folder that was there first is listed as created');
  for (const dir of ['.claude', '.claude/plugins', '.claude/cache', '.claude/cache/pstack', '.claude/plugins/pstack', '.opencode/plugins', '.opencode/agents', '.maxstack/bin']) {
    assert.ok(lock.createdDirs.includes(dir), `${dir} was created by the install but is not listed`);
  }
  assert.deepEqual(lock.createdFiles, ['opencode.jsonc'], 'a settings file that was there first is listed as created, and the config the install created is');
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').createdKey, true, 'a key the user file lacked is not marked as created');
  assert.equal(readJson(settingsPath(ctx)).defaultProvider, 'user-provider');
}, {});

withWorkspace('a settings file the apply created is listed in createdFiles, with no created key', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.deepEqual(lock.createdFiles, ['.pi/agent/settings.json', 'opencode.jsonc']);
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').createdKey, undefined);
}, {});

withWorkspace('a backup the apply writes is recorded with its hash, and it is reported once it exists', (ctx) => {
  mustApply(ctx);
  const config = join(ctx.workspace, 'opencode.jsonc');
  const configBefore = '{ "user": "edit" }\n';
  writeFileSync(config, configBefore);
  const settingsBefore = JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'user-model' }, null, 2);
  writeFileSync(settingsPath(ctx), settingsBefore);
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: 'opencode.jsonc' }], 'a backup the apply has not written was reported');

  mustApply(ctx);
  // The installer created both files, so a hand edit of either is an edited copy, never the original.
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), configBefore);
  assert.equal(readFileSync(join(ctx.workspace, '.pi', 'agent', 'settings.json.bak.1'), 'utf8'), settingsBefore);
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').sha256, sha256Upper(Buffer.from(configBefore, 'utf8')));
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json.bak.1', 'file').sha256, sha256Upper(Buffer.from(settingsBefore, 'utf8')));
  assert.deepEqual(problemRows(runStatus(ctx)), []);

  appendFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'x');
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: 'opencode.jsonc.bak.1' }]);
}, {});

withWorkspace('a layer that stops naming a folder leaves no copy of it in the owned folder', (ctx) => {
  // docs is not a Pi skills folder, so the layer can stop naming it without tripping the Pi check.
  const root = join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin');
  writeFile(root, 'docs/readme.md', 'docs\n');
  const withDocs = readJson(join(root, 'layer.json'));
  writeFile(root, 'layer.json', JSON.stringify({ ...withDocs, files: [...withDocs.files, 'docs'] }));
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, ...ORG_FOLDER.split('/'), 'docs', 'readme.md')));

  writeFile(root, 'layer.json', JSON.stringify(withDocs));
  const run = mustApply(ctx);
  assert.match(run.stdout, /Removed .*docs: the layer does not install it/, run.stdout);
  assert.ok(!existsSync(join(ctx.workspace, ...ORG_FOLDER.split('/'), 'docs')));
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

// The runtime and layer selection. The selection is recorded in stack.lock.json, and each test reads
// the lock and the tree the apply wrote.
const ALL_RUNTIMES = ['claude', 'copilot', 'opencode', 'pi'];
const ALL_LAYERS = ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'];

// Every file under the workspace, keyed by its path with forward slashes, with its bytes. The lock is
// left out, because each apply rewrites it, and the git cache is left out, because a sync re-reads it
// rather than writing an output of a runtime.
function workspaceFiles(workspace) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(workspace, full).replaceAll('\\', '/');
      if (rel === 'stack.lock.json' || rel === '.claude/cache') continue;
      // A junction is listed by its target, because reading it would read the folder it points to.
      if (entry.isSymbolicLink()) files.set(rel, Buffer.from(`link:${readlinkSync(full)}`));
      else if (entry.isDirectory()) walk(full);
      else files.set(rel, readFileSync(full));
    }
  };
  walk(workspace);
  return files;
}

function selectionOf(ctx) {
  return readJson(lockPath(ctx)).selection;
}

withWorkspace('a fresh -Runtimes claude,copilot writes only those runtimes, and records the selection', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const at = (path) => join(ctx.workspace, ...path.split('/'));
  for (const absent of ['.opencode', 'opencode.jsonc', '.pi', '.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh']) {
    assert.ok(!existsSync(at(absent)), `${absent} was written, but opencode and pi are not selected`);
  }
  for (const present of ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh', '.claude/plugins/pstack/.claude-plugin/plugin.json']) {
    assert.ok(existsSync(at(present)), `${present} is missing`);
  }
  // With no OpenCode copy to link to, each local layer is a copy of the items it names.
  for (const plugin of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    assert.ok(!isLink(at(`.claude/plugins/${plugin}`)), `${plugin} links to a folder that was not written`);
    assert.ok(existsSync(at(`.claude/plugins/${plugin}/.claude-plugin/plugin.json`)), `${plugin} has no manifest`);
    // The copy holds the layer's own bytes for each item it names.
    const source = plugin === 'simpsonm09-org-ai-plugin' ? ORG_SOURCE : 'projects/repos/simpsonm09-personal-ai-plugin';
    for (const item of ['index.ts', 'package.json', 'skills/demo-skill/SKILL.md', '.claude-plugin/plugin.json']) {
      assert.deepEqual(readFileSync(at(`.claude/plugins/${plugin}/${item}`)), readFileSync(at(`${source}/${item}`)), `${plugin}/${item} is not the layer's file`);
    }
  }
  assert.deepEqual(selectionOf(ctx), { runtimes: ['claude', 'copilot'], layers: ALL_LAYERS });
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.pi.enabled, false);
  assert.equal(lock.pi.reason, 'not selected');
}, {});

withWorkspace('a later -Runtimes pi adds pi and leaves the earlier outputs byte-identical', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const beforeFiles = workspaceFiles(ctx.workspace);
  const before = readJson(lockPath(ctx));
  mustApply(ctx, ['-Runtimes', 'pi']);
  const afterFiles = workspaceFiles(ctx.workspace);
  const after = readJson(lockPath(ctx));

  for (const [path, bytes] of beforeFiles) {
    assert.ok(afterFiles.get(path)?.equals(bytes), `${path} changed when pi was added`);
  }
  assert.ok(afterFiles.has('.maxstack/bin/pi.cmd') && afterFiles.has('.pi/agent/settings.json'), 'pi was not written');
  assert.deepEqual(after.selection, { runtimes: ['claude', 'copilot', 'pi'], layers: ALL_LAYERS });

  // The ownership record keeps each earlier record as it was, and adds the pi records.
  const sameRecord = (a, b) => a.path === b.path && a.kind === b.kind && (a.key ?? '') === (b.key ?? '');
  for (const record of before.owned) {
    assert.deepEqual(after.owned.find((candidate) => sameRecord(candidate, record)), record, `the owned record of ${record.path} changed`);
  }
  assert.ok(after.owned.length > before.owned.length, 'pi added no owned record');
  assert.ok(after.owned.some((record) => record.path === '.pi/agent/settings.json' && record.key === 'packages'), 'the pi packages list is not owned');

  // The created lists accumulate: an earlier entry stays, and the settings file and folder pi created are added.
  for (const dir of before.createdDirs) assert.ok(after.createdDirs.includes(dir), `${dir} left createdDirs`);
  for (const file of before.createdFiles) assert.ok(after.createdFiles.includes(file), `${file} left createdFiles`);
  assert.ok(after.createdDirs.includes('.pi/agent'), 'the pi agent folder is not in createdDirs');
  assert.ok(after.createdFiles.includes('.pi/agent/settings.json'), 'the pi settings file is not in createdFiles');
}, {});

withWorkspace('-Runtimes opencode -Layers pstack writes one layer, and a later -Layers adds the next', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'opencode', '-Layers', 'pstack']);
  const at = (path) => join(ctx.workspace, ...path.split('/'));
  assert.ok(existsSync(at('.opencode/plugins/pstack/opencode/index.ts')), 'the pstack entry is missing');
  assert.ok(!existsSync(at('.opencode/plugins/simpsonm09-org-ai-plugin')), 'the org layer is not selected');
  assert.ok(!existsSync(at('.opencode/plugins/simpsonm09-personal-ai-plugin')), 'the personal layer is not selected');
  assert.ok(!existsSync(at('.claude/plugins')), 'claude is not selected');
  assert.deepEqual(selectionOf(ctx), { runtimes: ['opencode'], layers: ['pstack'] });

  mustApply(ctx, ['-Layers', 'simpsonm09-org-ai-plugin']);
  assert.ok(existsSync(at('.opencode/plugins/simpsonm09-org-ai-plugin/index.ts')), 'the org layer did not install');
  assert.ok(!existsSync(at('.opencode/plugins/simpsonm09-personal-ai-plugin')), 'the personal layer was added');
  assert.deepEqual(selectionOf(ctx), { runtimes: ['opencode'], layers: ['pstack', 'simpsonm09-org-ai-plugin'] });
}, {});

// The bytes of each output file, as latin1 text so that one character is one byte. Each temporary base
// folder the test builds is replaced by a placeholder, since the wrappers name absolute paths; no other
// byte changes. The lock and the git cache are left out, as in workspaceFiles.
function portableFiles(ctx) {
  const bases = [ctx.base, ctx.base.replaceAll('\\', '/'), JSON.stringify(ctx.base).slice(1, -1)];
  return new Map([...workspaceFiles(ctx.workspace)].map(([path, bytes]) => {
    let text = bytes.toString('latin1');
    for (const base of bases) text = text.replaceAll(base, '<BASE>');
    return [path, text];
  }));
}

withWorkspace('-Runtimes all -Layers all writes what a plain apply writes, and records every name', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'all', '-Layers', 'all']);
  assert.deepEqual(selectionOf(ctx), { runtimes: ALL_RUNTIMES, layers: ALL_LAYERS });
  const plain = buildWorkspace();
  try {
    mustApply(plain);
    const everything = portableFiles(ctx);
    assert.ok(everything.size > 0);
    assert.deepEqual(everything, portableFiles(plain), 'an output file differs between the explicit all and the plain apply');
  } finally {
    rmSync(plain.base, { recursive: true, force: true });
  }
}, {});

withWorkspace('naming a runtime that is already selected narrows nothing, and says so', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const run = mustApply(ctx, ['-Runtimes', 'claude']);
  assert.match(plainOutput(run), /Already selected runtimes: claude\. Flags never narrow the selection; the rest stay selected\./, run.stdout);
  assert.deepEqual(selectionOf(ctx), { runtimes: ['claude', 'copilot'], layers: ALL_LAYERS });
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')), 'copilot was removed by a flag that named fewer runtimes');
}, {});

withWorkspace('an unknown runtime or layer name fails, lists the valid names, and writes nothing', (ctx) => {
  const runtime = runInstaller(shell, ctx, ['-Runtimes', 'codex']);
  assert.notEqual(runtime.status, 0, 'the installer accepted an unknown runtime');
  assert.match(plainOutput(runtime), /-Runtimes names an unknown name 'codex'\. Valid names: claude, opencode, copilot, pi, or all\./);
  const layer = runInstaller(shell, ctx, ['-Layers', 'nope']);
  assert.notEqual(layer.status, 0, 'the installer accepted an unknown layer');
  assert.match(plainOutput(layer), /-Layers names an unknown name 'nope'\. Valid names: pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin, or all\./);
  assert.ok(!existsSync(lockPath(ctx)), 'a rejected run wrote the lock');
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'a rejected run wrote the Claude folder');
}, {});

withWorkspace('copilot or pi without claude fails, both when it is named and when it is already recorded', (ctx) => {
  const named = runInstaller(shell, ctx, ['-Runtimes', 'pi']);
  assert.notEqual(named.status, 0, 'pi was selected without claude');
  assert.match(plainOutput(named), /Runtime 'pi' needs claude: its wrapper or settings name the Claude plugin folders/);
  assert.match(plainOutput(runInstaller(shell, ctx, ['-Runtimes', 'copilot'])), /Runtime 'copilot' needs claude/);

  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.selection.runtimes = ['pi'];
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const recorded = runInstaller(shell, ctx);
  assert.notEqual(recorded.status, 0, 'a recorded pi without claude was accepted');
  assert.match(plainOutput(recorded), /Runtime 'pi' needs claude/);
}, {});

withWorkspaceNeeding('python', python, 'a lock with no selection reads as all, and the next apply writes the selection', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete lock.selection;
  writeFileSync(lockPath(ctx), JSON.stringify(lock));

  const status = runStatus(ctx);
  assert.match(status.stdout, /^Selection: runtimes claude, copilot, opencode, pi; layers pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin \(the lock predates the selection, so all\)\r?$/m, status.stdout);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  mustApply(ctx);
  assert.deepEqual(selectionOf(ctx), { runtimes: ALL_RUNTIMES, layers: ALL_LAYERS });
}, {});

withWorkspace('status prints the selection first, names an unselected file, and judges only the selected runtimes', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  writeFile(ctx.workspace, '.maxstack/bin/pi.cmd', '@echo off\r\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stdout);
  // Warnings also print to stdout, so the first line that is not a warning must be the selection.
  const [first] = run.stdout.split(/\r?\n/).filter((line) => !line.includes('WARNING:'));
  assert.equal(first, 'Selection: runtimes claude, copilot; layers pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin', 'the selection is not the first line');
  assert.match(run.stdout, /^not selected +\.maxstack\/bin\/pi\.cmd\r?$/m, run.stdout);
  assert.doesNotMatch(run.stdout, /^(matching|drifted|modified|missing|untracked) .*opencode/m, 'status judged an OpenCode path');
  // The file, plus the two runtimes layers.json names that this selection leaves out.
  assert.match(run.stdout, /Summary: \d+ matching, 0 drifted, 0 modified, 0 missing, 0 untracked, 3 not selected/);
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, 'a file of an unselected runtime failed -Strict');
  const refused = runStatus(ctx, ['-Runtimes', 'claude']);
  assert.notEqual(refused.status, 0, '-Status accepted a selection flag');
  assert.match(plainOutput(refused), /-Status reports the recorded selection and takes no -Runtimes or -Layers/);
}, {});

withWorkspaceNeeding('python', python, 'the owned list names only selected outputs, and both verifiers accept a partial install', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const owned = readJson(lockPath(ctx)).owned.map((record) => record.path);
  assert.ok(owned.includes('.claude/plugins/simpsonm09-org-ai-plugin'), 'the copy of a local layer is not owned');
  for (const path of owned) {
    assert.doesNotMatch(path, /^(opencode\.jsonc|\.opencode\/|\.pi\/)|pi\.(cmd|sh)$/, `${path} belongs to an unselected runtime`);
  }
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  const manifests = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { encoding: 'utf8' });
  assert.equal(manifests.status, 0, `${manifests.stdout}\n${manifests.stderr}`);
}, {});

withWorkspaceNeeding('python', python, 'the verifiers fail on an unknown, a malformed, or a pi-without-claude selection', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verifyWorkspace = () => spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  const verifyLock = () => spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { encoding: 'utf8' });
  const cases = [
    [(lock) => { lock.selection.runtimes = ['claude', 'codex']; }, /names unknown \['codex'\]/],
    [(lock) => { lock.selection.runtimes = ['copilot']; }, /selects copilot without claude/],
    [(lock) => { lock.selection = 'claude'; }, /must hold exactly a runtimes list and a layers list/],
  ];
  for (const [mutate, message] of cases) {
    const lock = readJson(lockPath(ctx));
    mutate(lock);
    writeFileSync(lockPath(ctx), JSON.stringify(lock));
    for (const run of [verifyWorkspace(), verifyLock()]) {
      assert.notEqual(run.status, 0, `a verifier accepted: ${message}`);
      assert.match(plainOutput(run), message);
    }
  }
}, {});

withWorkspace('a selected layer that declares none of the selected runtimes is reported and installs nothing', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = { opencode: {} };
  });
  const run = mustApply(ctx, ['-Runtimes', 'claude'], { layersFile: layers });
  assert.match(plainOutput(run), /Layer 'simpsonm09-personal-ai-plugin' declares none of the selected runtimes, so it installs nothing\./);
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin')), 'the personal layer installed');
  const personal = readJson(lockPath(ctx)).layers.find((layer) => layer.name === 'simpsonm09-personal-ai-plugin');
  assert.equal(personal.claude.enabled, false);
  assert.equal(personal.opencode.enabled, false);
}, {});

withWorkspace('a runtime that is not selected is never looked up, so its CLI is not warned about', (ctx) => {
  const run = mustApply(ctx, ['-Runtimes', 'claude', '-CopilotCommand', MISSING_COPILOT]);
  assert.doesNotMatch(plainOutput(run), /Copilot CLI not found|Pi CLI not found/);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.copilot.reason, 'not selected');
  assert.equal(lock.pi.reason, 'not selected');
}, {});

withWorkspace('comma-separated -Runtimes and -Layers values bind under pwsh -File, one token each', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,opencode', '-Layers', 'pstack,simpsonm09-org-ai-plugin']);
  assert.deepEqual(selectionOf(ctx), { runtimes: ['claude', 'opencode'], layers: ['pstack', 'simpsonm09-org-ai-plugin'] });
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts')), 'the named org layer is missing');
}, {});

withWorkspace('a later -Runtimes opencode replaces the claude copies with links to the OpenCode copies', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude']);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  assert.ok(!isLink(child), 'the claude copy is a link before opencode is selected');
  mustApply(ctx, ['-Runtimes', 'opencode']);
  assert.ok(isLink(child), 'the copy was not replaced by a link');
  assert.ok(existsSync(join(child, '.claude-plugin', 'plugin.json')), 'the link does not reach the manifest');
  assert.equal(readJson(lockPath(ctx)).layers.find((layer) => layer.name === 'simpsonm09-org-ai-plugin').claude.kind, 'junction');
}, {});

// The review fixes. A recorded name that layers.json no longer names is dropped with a warning, a new layer
// or runtime is named until a flag adds it, an unreadable lock is refused with the cost of deleting it, the
// lock is replaced whole, and the verifiers refuse a block that is enabled for an unselected runtime.
const LAYER_PERSONAL = 'simpsonm09-personal-ai-plugin';

withWorkspace('a layer removed from layers.json is dropped from the selection with a warning, and every command still runs', (ctx) => {
  mustApply(ctx);
  const personalFolder = join(ctx.workspace, '.opencode', 'plugins', LAYER_PERSONAL);
  const personalLink = join(ctx.workspace, '.claude', 'plugins', LAYER_PERSONAL);
  assert.ok(existsSync(personalFolder), 'the first apply did not install the personal layer');
  const withoutPersonal = writeLayers(ctx, (manifest) => {
    manifest.layers = manifest.layers.filter((layer) => layer.name !== LAYER_PERSONAL);
  });
  const warning = new RegExp(`names the layer '${LAYER_PERSONAL}', which is no longer in layers\\.json\\. It is dropped from the selection`);

  const audit = runInstaller(shell, ctx, [], { apply: false, layersFile: withoutPersonal });
  assert.equal(audit.status, 0, `audit failed:\n${audit.stdout}\n${audit.stderr}`);
  assert.match(plainOutput(audit), warning);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: withoutPersonal });
  assert.equal(status.status, 0, `status failed:\n${status.stdout}\n${status.stderr}`);
  assert.match(plainOutput(status), warning);
  assert.ok(existsSync(personalFolder), 'a status run changed the workspace');

  const applied = mustApply(ctx, [], { layersFile: withoutPersonal });
  assert.match(plainOutput(applied), warning);
  assert.ok(!existsSync(personalFolder), 'the removed layer kept its OpenCode folder');
  assert.ok(!existsSync(personalLink), 'the removed layer kept its Claude folder');
  assert.deepEqual(selectionOf(ctx), { runtimes: ALL_RUNTIMES, layers: ['pstack', 'simpsonm09-org-ai-plugin'] });

  const after = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: withoutPersonal });
  assert.equal(after.status, 0, after.stdout);
  assert.doesNotMatch(plainOutput(after), /no longer in layers\.json/, 'the warning outlived the removal');
}, {});

withWorkspace('a runtime removed from the recorded selection is named, dropped with a warning, and the apply runs', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.selection.runtimes = ['claude', 'codex'];
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /names the runtime 'codex', which is no longer in layers\.json\. It is dropped from the selection/);
  assert.deepEqual(selectionOf(ctx).runtimes, ['claude']);
}, {});

withWorkspace('a layer added to layers.json later is not installed by a plain apply, and every command names it until a flag adds it', (ctx) => {
  const withoutPersonal = writeLayers(ctx, (manifest) => {
    manifest.layers = manifest.layers.filter((layer) => layer.name !== LAYER_PERSONAL);
  });
  mustApply(ctx, [], { layersFile: withoutPersonal });
  const personalFolder = join(ctx.workspace, '.opencode', 'plugins', LAYER_PERSONAL);
  assert.ok(!existsSync(personalFolder));
  assert.deepEqual(selectionOf(ctx).layers, ['pstack', 'simpsonm09-org-ai-plugin']);

  const applied = mustApply(ctx);
  const note = `layer '${LAYER_PERSONAL}' is in layers.json but not selected, so this run does not install it. Add it with -Layers ${LAYER_PERSONAL}.`;
  assert.match(plainOutput(applied), new RegExp(note.replaceAll('.', '\\.')));
  assert.ok(!existsSync(personalFolder), 'a plain apply installed a layer the selection leaves out');

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.match(plainOutput(audit), new RegExp(note.replaceAll('.', '\\.')));

  const status = runStatus(ctx);
  assert.equal(status.status, 0, status.stdout);
  assert.match(status.stdout, new RegExp(`^not selected +layer ${LAYER_PERSONAL} \\(add with -Layers ${LAYER_PERSONAL}\\)\\r?$`, 'm'));
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, 'a layer the selection leaves out failed -Strict');

  const flagged = mustApply(ctx, ['-Layers', LAYER_PERSONAL]);
  assert.ok(existsSync(personalFolder), 'the named layer was not installed');
  assert.deepEqual(selectionOf(ctx).layers, ['pstack', 'simpsonm09-org-ai-plugin', LAYER_PERSONAL]);
  assert.doesNotMatch(plainOutput(flagged), /is in layers\.json but not selected/);
}, {});

withWorkspace('a runtime that layers.json names but the selection leaves out is named on every run', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /runtime 'opencode' is in layers\.json but not selected, so this run does not install it\. Add it with -Runtimes opencode\./);
  const status = runStatus(ctx);
  assert.match(status.stdout, /^not selected +runtime pi \(add with -Runtimes pi\)\r?$/m, status.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, 'a runtime the selection leaves out failed -Strict');
}, {});

withWorkspace('an empty, null, or truncated lock is refused with what to do and what it costs, and nothing is written', (ctx) => {
  mustApply(ctx);
  const good = readFileSync(lockPath(ctx), 'utf8');
  const filesBefore = workspaceFiles(ctx.workspace);
  for (const [label, text] of [['empty', ''], ['null', 'null'], ['truncated', good.slice(0, 120)]]) {
    writeFileSync(lockPath(ctx), text);
    const run = runInstaller(shell, ctx);
    assert.notEqual(run.status, 0, `${label}: apply accepted the lock`);
    const message = plainOutput(run);
    assert.match(message, /is empty, null, or truncated, so its selection and created-paths record cannot be read/, `${label}: ${message}`);
    assert.match(message, /Restore it from .*stack\.lock\.json\.bak/, label);
    assert.match(message, /Deleting .*stack\.lock\.json instead resets the selection to all runtimes and layers and loses the createdDirs and createdFiles record/, label);
    assert.match(message, /Keep .*stack\.lock\.json\.bak either way/, label);
    assert.doesNotMatch(message, /StrictMode|PropertyNotFound|cannot be found on this object/, `${label}: a PowerShell error leaked`);
    assert.equal(readFileSync(lockPath(ctx), 'utf8'), text, `${label}: the lock was changed`);
    assert.deepEqual(workspaceFiles(ctx.workspace), filesBefore, `${label}: an apply wrote before it read the lock`);
    const status = runStatus(ctx);
    assert.notEqual(status.status, 0, `${label}: status accepted the lock`);
    assert.match(plainOutput(status), /is empty, null, or truncated/, label);
  }
}, {});

withWorkspace('the lock is replaced whole: a failed write leaves the previous lock as it was, and the replaced lock is kept', (ctx) => {
  mustApply(ctx);
  const before = readFileSync(lockPath(ctx));
  // A folder where the temporary file goes makes the write fail before the lock is replaced.
  mkdirSync(join(ctx.workspace, 'stack.lock.json.new'));
  const failed = runInstaller(shell, ctx, ['-Runtimes', 'claude']);
  assert.notEqual(failed.status, 0, 'the installer ignored a failed write');
  assert.ok(before.equals(readFileSync(lockPath(ctx))), 'a failed write changed the lock');
  rmSync(join(ctx.workspace, 'stack.lock.json.new'), { recursive: true });

  mustApply(ctx, ['-Runtimes', 'claude']);
  assert.ok(!existsSync(join(ctx.workspace, 'stack.lock.json.new')), 'the temporary file was left behind');
  assert.ok(existsSync(`${lockPath(ctx)}.bak`), 'the replaced lock was not kept');
  assert.ok(before.equals(readFileSync(`${lockPath(ctx)}.bak`)), 'the kept copy is not the lock the apply replaced');
  assert.deepEqual(selectionOf(ctx).runtimes, ALL_RUNTIMES);
}, {});

withWorkspace('a truncated temporary file from an interrupted write never stands in for the lock', (ctx) => {
  mustApply(ctx);
  const lock = readFileSync(lockPath(ctx));
  writeFile(ctx.workspace, 'stack.lock.json.new', '{"generatedAt": "2026-');
  const status = runStatus(ctx);
  assert.equal(status.status, 0, status.stdout);
  assert.ok(lock.equals(readFileSync(lockPath(ctx))), 'the lock changed');
  mustApply(ctx);
  assert.ok(!existsSync(join(ctx.workspace, 'stack.lock.json.new')), 'the apply left the temporary file');
  assert.equal(readJson(lockPath(ctx)).selection.layers.length, 3);
}, {});

withWorkspaceNeeding('python', python, 'the verifiers reject an enabled pi or copilot block for a runtime the selection leaves out', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude']);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verifyWorkspace = () => spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  const verifyLock = () => spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { encoding: 'utf8' });
  const clean = verifyWorkspace();
  assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
  assert.equal(verifyLock().status, 0);

  const lock = readJson(lockPath(ctx));
  for (const runtime of ['pi', 'copilot']) {
    const edited = { ...lock, [runtime]: { ...lock[runtime], enabled: true } };
    writeFileSync(lockPath(ctx), JSON.stringify(edited));
    for (const run of [verifyWorkspace(), verifyLock()]) {
      assert.notEqual(run.status, 0, `a verifier accepted an enabled ${runtime} block`);
      assert.match(plainOutput(run), new RegExp(`records ${runtime} enabled, which the selection does not select`));
    }
  }
}, {});

withWorkspace('a claude-only apply over an all-runtime tree leaves every other runtime file byte-identical', (ctx) => {
  mustApply(ctx);
  const isOther = (path) => /^(\.opencode\/|opencode\.jsonc$|\.pi\/|\.maxstack\/)/.test(path);
  const before = workspaceFiles(ctx.workspace);
  const beforeOther = [...before.keys()].filter(isOther);
  assert.ok(beforeOther.length > 10, 'the all-runtime tree has too few other files to prove anything');
  // The lock now selects claude only, as a remove would leave it. Apply must not touch the other runtimes.
  const lock = readJson(lockPath(ctx));
  lock.selection.runtimes = ['claude'];
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  mustApply(ctx);
  const after = workspaceFiles(ctx.workspace);
  for (const path of beforeOther) {
    assert.ok(after.get(path)?.equals(before.get(path)), `${path} changed under an unselected runtime`);
  }
  assert.deepEqual([...after.keys()].filter(isOther), beforeOther, 'a file under an unselected runtime was added or removed');
  assert.deepEqual(readJson(lockPath(ctx)).selection.runtimes, ['claude']);
}, {});

withWorkspace('a copied local layer reports a hand edit as differs, a user file as modified, and an apply restores it', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude']);
  const copy = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  const label = '.claude/plugins/simpsonm09-org-ai-plugin';
  appendFileSync(join(copy, 'index.ts'), '// hand edit\n');
  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.match(audit.stdout, /plugins\\simpsonm09-org-ai-plugin: differs/, audit.stdout);
  assert.ok(problemRows(runStatus(ctx)).some((row) => row.state === 'modified' && row.label === label), 'the hand edit was not modified');

  writeFileSync(join(copy, 'notes.txt'), 'a user file\n');
  assert.ok(problemRows(runStatus(ctx)).some((row) => row.state === 'modified' && row.label === label), 'the user file was not modified');

  mustApply(ctx, ['-Runtimes', 'claude']);
  assert.ok(!existsSync(join(copy, 'notes.txt')), 'the apply kept the user file in the owned copy');
  const source = join(ctx.workspace, ...ORG_SOURCE.split('/'));
  for (const item of ['index.ts', 'package.json', 'skills/demo-skill/SKILL.md']) {
    assert.deepEqual(readFileSync(join(copy, ...item.split('/'))), readFileSync(join(source, ...item.split('/'))), `${item} was not restored`);
  }
  assert.deepEqual(problemRows(runStatus(ctx)), [], 'the restored copy still reports a problem');
}, {});

// Removal: -Remove and -Uninstall. Each test installs, removes or uninstalls, and reads what is left. The
// round trip is the proof of the deletion rules: after -Uninstall the tree equals the tree before the install.

const LOCAL_PLUGINS = ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'];
const PERSONAL_FOLDER = '.opencode/plugins/simpsonm09-personal-ai-plugin';
const USER_CONFIG = '{\n  "username": "user"\n}\n';
const USER_SETTINGS = '{\n  "defaultProvider": "user-provider",\n  "packages": [\n    "user-package"\n  ]\n}\n';

// The user's own files: a config and a Pi settings file with a user key and a user entry, and a note in a folder
// the installer never writes. An install must leave each of them exactly as it was.
function seedUserFiles(ctx) {
  writeFile(ctx.workspace, 'opencode.jsonc', USER_CONFIG);
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  writeFile(ctx.workspace, 'notes/todo.txt', 'mine\n');
}

// Every entry under root, by relative path: a file with its bytes, a folder, or a link with its target. A link is
// listed, never followed. The git metadata of a pinned cache is left out, as the owned hash leaves it out, and the
// lock's generatedAt is left out, because it is the one field that changes on every apply.
function snapshotTree(root, options = {}) {
  const entries = new Map();
  collectSnapshot(root, '', entries, options);
  return entries;
}

function collectSnapshot(dir, prefix, entries, options) {
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (options.skipLockBackup && rel === 'stack.lock.json.bak') continue;
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      entries.set(rel, `link:${linkTargetText(full)}`);
    } else if (stat.isDirectory()) {
      if (options.skipGit && name === '.git') continue;
      entries.set(rel, 'dir');
      collectSnapshot(full, rel, entries, options);
    } else {
      entries.set(rel, `file:${snapshotBytes(full, rel)}`);
    }
  }
}

function snapshotBytes(full, rel) {
  const bytes = readFileSync(full);
  if (rel !== 'stack.lock.json') return bytes.toString('base64');
  const lock = JSON.parse(bytes.toString('utf8'));
  delete lock.generatedAt;
  return Buffer.from(JSON.stringify(lock)).toString('base64');
}

// The links under root that no longer resolve.
function danglingLinks(root) {
  return [...snapshotTree(root).entries()]
    .filter(([rel, value]) => value.startsWith('link:') && !existsSync(join(root, rel)))
    .map(([rel]) => rel);
}

// A removal run: -Apply is added unless apply is false, so a test states the dry run it means.
function removal(ctx, args, { apply = true } = {}) {
  return runInstaller(shell, ctx, [...args, ...(apply ? ['-Apply'] : [])], { apply: false });
}

function assertOk(run) {
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
}

function setLock(ctx, lock) {
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
}

withWorkspace('a round trip: installing every runtime and then uninstalling leaves the tree byte-identical to the start', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  assert.notDeepEqual(snapshotTree(ctx.workspace), before, 'the install wrote nothing');

  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock files remain after a full uninstall');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), USER_CONFIG, 'the user config was not restored');
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the user Pi settings were not restored');
}, {});

withWorkspace('removing pi leaves the tree and the lock that a fresh install of claude and copilot writes', (ctx) => {
  seedUserFiles(ctx);
  mustApply(ctx, ['-Runtimes', 'claude,copilot,pi']);
  assertOk(removal(ctx, ['-Remove', '-Runtimes', 'pi']));
  const removed = snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true });

  assertOk(removal(ctx, ['-Uninstall']));
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  assert.deepEqual(snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true }), removed);
}, {});

withWorkspace('removing claude is refused while copilot or pi is selected, and writes nothing', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot,pi']);
  const before = snapshotTree(ctx.workspace);
  const run = removal(ctx, ['-Remove', '-Runtimes', 'claude']);
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(plainOutput(run), /Removing claude would leave copilot and pi selected, and each needs claude/);
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('removing opencode turns the claude junctions into copies, and leaves no dangling link', (ctx) => {
  seedUserFiles(ctx);
  mustApply(ctx);
  assertOk(removal(ctx, ['-Remove', '-Runtimes', 'opencode']));

  for (const plugin of LOCAL_PLUGINS) {
    const child = join(ctx.workspace, '.claude', 'plugins', plugin);
    assert.ok(!isLink(child), `${plugin} is still a link into the removed OpenCode folder`);
    assert.ok(existsSync(join(child, '.claude-plugin', 'plugin.json')), `${plugin} lost its manifest`);
  }
  assert.deepEqual(danglingLinks(ctx.workspace), [], 'a link is left dangling');
  assert.equal(existsSync(join(ctx.workspace, '.opencode')), false, 'the OpenCode folders remain');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), USER_CONFIG, 'the user config was not restored');

  const removed = snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true });
  assertOk(removal(ctx, ['-Uninstall']));
  mustApply(ctx, ['-Runtimes', 'claude,copilot,pi']);
  assert.deepEqual(snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true }), removed, 'the copies differ from a fresh install without opencode');
}, {});

withWorkspace('removing a layer removes its folders and keeps the others, and the result is a fresh install without it', (ctx) => {
  mustApply(ctx);
  assertOk(removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']));
  assert.equal(existsSync(join(ctx.workspace, PERSONAL_FOLDER)), false, 'the layer folder remains');
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin')), false, 'the Claude link remains');
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin')), 'a remaining layer lost its link');
  assert.deepEqual(danglingLinks(ctx.workspace), []);

  const lock = readJson(lockPath(ctx));
  assert.deepEqual(lock.selection.layers, ['pstack', 'simpsonm09-org-ai-plugin']);
  assert.ok(!lock.owned.some((record) => record.layers.includes('simpsonm09-personal-ai-plugin')), 'a record of the removed layer remains');

  const removed = snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true });
  assertOk(removal(ctx, ['-Uninstall']));
  mustApply(ctx, ['-Layers', 'pstack,simpsonm09-org-ai-plugin']);
  assert.deepEqual(snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true }), removed);
}, {});

withWorkspace('a hand-edited owned file is skipped and reported, the rest is removed, and a retry after the fix finishes', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  const original = readFileSync(wrapper);
  appendFileSync(wrapper, 'rem hand edit\r\n');

  const first = removal(ctx, ['-Uninstall']);
  assertOk(first);
  assert.match(first.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.cmd\s+modified by hand/m, first.stdout);
  assert.deepEqual(readJson(lockPath(ctx)).owned.map((record) => record.path), ['.maxstack/bin/copilot.cmd'], 'the lock kept more than the skipped record');
  assert.equal(existsSync(join(ctx.workspace, '.opencode')), false, 'the OpenCode folders were not removed');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), USER_CONFIG);

  writeFileSync(wrapper, original);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the retry did not finish');
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('a file a user adds to an owned folder keeps the folder, and a retry after the user removes it finishes', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  const note = join(ctx.workspace, ORG_FOLDER, 'mine.txt');
  writeFileSync(note, 'mine\n');

  const first = removal(ctx, ['-Uninstall']);
  assertOk(first);
  assert.match(first.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+modified by hand/m, first.stdout);
  assert.equal(readFileSync(note, 'utf8'), 'mine\n', 'the user file was deleted');

  rmSync(note);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('a junction inside an owned folder is removed as a link, and its target outside the workspace is untouched', (ctx) => {
  mustApply(ctx);
  const outside = join(ctx.base, 'outside');
  writeFile(outside, 'keep.txt', 'outside bytes\n');
  symlinkSync(outside, join(ctx.workspace, ORG_FOLDER, 'skills', 'linked'), 'junction');
  // The folder's record names the link, so the installer's own copy of the folder holds it.
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').sha256 = independentSha(join(ctx.workspace, ...ORG_FOLDER.split('/')), 'owned');
  setLock(ctx, lock);

  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside bytes\n', 'the link target was changed');
  assert.equal(existsSync(join(ctx.workspace, ORG_FOLDER)), false, 'the owned folder remains');
}, {});

withWorkspace('a tampered record that names a path outside the workspace is skipped, and nothing outside is touched', (ctx) => {
  mustApply(ctx);
  const relativeFile = join(ctx.base, 'outside-relative.txt');
  const absoluteFile = join(ctx.base, 'outside-absolute.txt');
  writeFileSync(relativeFile, 'keep\n');
  writeFileSync(absoluteFile, 'keep too\n');
  const lock = readJson(lockPath(ctx));
  lock.owned.push({ path: '../outside-relative.txt', kind: 'file', sha256: sha256Upper(Buffer.from('keep\n')), runtime: 'copilot', layers: [] });
  lock.owned.push({ path: absoluteFile.replaceAll('\\', '/'), kind: 'file', sha256: sha256Upper(Buffer.from('keep too\n')), runtime: 'copilot', layers: [] });
  setLock(ctx, lock);

  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.\.\/outside-relative\.txt\s+outside the workspace: the record does not name a workspace path/m, run.stdout);
  assert.match(run.stdout, /^SKIP\s+.+outside-absolute\.txt\s+outside the workspace: the record does not name a workspace path/m, run.stdout);
  assert.equal(readFileSync(relativeFile, 'utf8'), 'keep\n');
  assert.equal(readFileSync(absoluteFile, 'utf8'), 'keep too\n');
  assert.equal(readJson(lockPath(ctx)).owned.length, 2, 'the lock dropped a skipped record');
}, {});

withWorkspace('a record whose path passes through a junction is skipped, and the folder it reaches is untouched', (ctx) => {
  mustApply(ctx);
  const outside = join(ctx.base, 'outside-folder');
  writeFile(outside, 'keep.txt', 'outside\n');
  symlinkSync(outside, join(ctx.workspace, 'escape'), 'junction');
  const lock = readJson(lockPath(ctx));
  lock.owned.push({ path: 'escape/keep.txt', kind: 'file', sha256: sha256Upper(Buffer.from('outside\n')), runtime: 'copilot', layers: [] });
  setLock(ctx, lock);

  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+escape\/keep\.txt\s+outside the workspace: a folder on its path is a junction/m, run.stdout);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside\n');
  assert.deepEqual(readJson(lockPath(ctx)).owned.map((record) => record.path), ['escape/keep.txt']);
}, {});

withWorkspace('a dry run prints the plan with a state for each path, and writes nothing', (ctx) => {
  seedUserFiles(ctx);
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);

  const remove = removal(ctx, ['-Remove', '-Runtimes', 'pi'], { apply: false });
  assertOk(remove);
  assert.match(remove.stdout, /^DELETE\s+\.maxstack\/bin\/pi\.cmd\s/m, remove.stdout);
  assert.match(remove.stdout, /^RESTORE\s+\.pi\/agent\/settings\.json\s/m, remove.stdout);
  assert.match(remove.stdout, /^Dry run: nothing was removed or written/m);
  assert.deepEqual(snapshotTree(ctx.workspace), before, '-Remove without -Apply wrote');

  const uninstall = removal(ctx, ['-Uninstall'], { apply: false });
  assertOk(uninstall);
  assert.match(uninstall.stdout, /^RESTORE\s+opencode\.jsonc\s/m, uninstall.stdout);
  assert.match(uninstall.stdout, /^DELETE\s+\.claude\/cache\/pstack\s/m, uninstall.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, '-Uninstall without -Apply wrote');
}, {});

withWorkspace('a second uninstall, and a remove of what is not selected, find nothing to remove and change nothing', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const notSelected = removal(ctx, ['-Remove', '-Runtimes', 'pi']);
  assertOk(notSelected);
  assert.match(notSelected.stdout, /runtime 'pi' is not selected, so there is nothing to remove for it/);
  assert.match(notSelected.stdout, /Nothing to remove/);

  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
  const again = removal(ctx, ['-Uninstall']);
  assertOk(again);
  assert.match(again.stdout, /Nothing to remove/);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a second uninstall changed the tree');
}, {});

withWorkspace('-Strict makes a removal that skips anything exit 1, and a clean removal exit 0', (ctx) => {
  mustApply(ctx);
  assert.equal(removal(ctx, ['-Uninstall', '-Strict'], { apply: false }).status, 0, 'a clean dry run failed');
  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'rem hand edit\r\n');
  assert.equal(removal(ctx, ['-Uninstall', '-Strict'], { apply: false }).status, 1, 'a dry run with a skip passed');
  assert.equal(removal(ctx, ['-Uninstall', '-Strict']).status, 1, 'an apply with a skip passed');
  assert.ok(existsSync(lockPath(ctx)), 'the lock was removed with a skip');
}, {});

withWorkspace('-Remove and -Uninstall refuse a lock with no usable record, and write nothing', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const { owned, ...withoutOwned } = lock;
  // A schema-1 lock with an owned list still uninstalls (item 9), so only -Remove refuses it.
  const both = [['-Uninstall', '-Apply'], ['-Remove', '-Runtimes', 'pi', '-Apply']];
  const removeOnly = [['-Remove', '-Runtimes', 'pi', '-Apply']];
  const cases = [
    ['no lock', null, /There is no usable ownership record/, both],
    ['ownedSchema 1', { ...lock, ownedSchema: 1 }, /its ownedSchema is 1, and -Remove needs version 2/, removeOnly],
    ['no owned list', withoutOwned, /it has no owned list/, both],
  ];
  for (const [label, value, pattern, argsList] of cases) {
    if (value === null) rmSync(lockPath(ctx)); else setLock(ctx, value);
    const before = snapshotTree(ctx.workspace);
    for (const args of argsList) {
      const run = runInstaller(shell, ctx, args, { apply: false });
      assert.equal(run.status, 1, `${label}: ${args.join(' ')}\n${run.stdout}\n${run.stderr}`);
      assert.match(plainOutput(run), pattern, label);
      assert.match(plainOutput(run), /Install-Workspace\.ps1 -Apply once/, label);
      assert.deepEqual(snapshotTree(ctx.workspace), before, `${label}: ${args.join(' ')} wrote`);
    }
  }
}, {});

withWorkspace('the removal switches refuse each other, -Status, and a missing selection before anything runs', (ctx) => {
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);
  const cases = [
    [['-Remove', '-Uninstall'], /Choose one/],
    [['-Uninstall', '-Status'], /Choose -Status, -Remove, or -Uninstall/],
    [['-Uninstall', '-Runtimes', 'pi'], /takes no -Runtimes or -Layers/],
    [['-Remove'], /names what to remove/],
    [['-Strict'], /applies to -Status, -Remove, -Uninstall, and -Update/],
  ];
  for (const [args, pattern] of cases) {
    const run = runInstaller(shell, ctx, args, { apply: false });
    assert.notEqual(run.status, 0, args.join(' '));
    assert.match(plainOutput(run), pattern, args.join(' '));
  }
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('a key the user adds to the Pi settings after the install survives, and only the installer entries go', (ctx) => {
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'user-model' }, null, 2));
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(readJson(settingsPath(ctx)), { defaultModel: 'user-model' });
}, {});

// Backups and the Pi settings. The original backup is the one restore source; a hand edit made after it goes to a
// numbered copy. The settings are edited as strict JSON, so dates, nulls, depth, and key order survive a write.
const ORIGINAL_CONFIG = '{\n  "original": true\n}\n';

withWorkspace('a hand edit after the first apply goes to a numbered backup, and the original backup is never overwritten', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG);
  mustApply(ctx);
  writeFileSync(join(ctx.workspace, 'opencode.jsonc'), '{\n  "hand": "edit"\n}\n');
  mustApply(ctx);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), ORIGINAL_CONFIG, 'the original backup was overwritten');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), '{\n  "hand": "edit"\n}\n', 'the hand edit was not kept');
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak', 'file').role, 'original');
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').role, 'edited');
}, {});

withWorkspace('a hand edit of the Pi settings after the first apply leaves the original settings backup as it was', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), JSON.stringify({ defaultModel: 'hand-edit' }, null, 2));
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the original settings backup was overwritten');
}, {});

withWorkspace('the first schema-2 apply over a schema-1 lock keeps an existing settings backup untouched', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.ownedSchema = 1;
  delete lock.pi.settingsSha256;
  setLock(ctx, lock);
  writeFileSync(settingsPath(ctx), JSON.stringify({ defaultModel: 'hand-edit' }, null, 2));
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'an existing backup was overwritten where the last write is unknown');
}, {});

withWorkspace('the Pi settings keep dates with offsets, nulls in lists, deep nesting, and key order exactly', (ctx) => {
  let deep = { leaf: 'x' };
  for (let level = 0; level < 40; level += 1) deep = { level: deep };
  const user = `{\n  "zeta": "2024-01-02T03:04:05+02:00",\n  "packages": [null, "user-package"],\n  "nested": ${JSON.stringify(deep)},\n  "alpha": 1.50\n}\n`;
  writeFile(ctx.workspace, '.pi/agent/settings.json', user);
  mustApply(ctx);
  const text = readFileSync(settingsPath(ctx), 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.zeta, '2024-01-02T03:04:05+02:00', 'a date string changed');
  assert.deepEqual(parsed.packages.slice(0, 2), [null, 'user-package'], 'a null list item was dropped');
  assert.deepEqual(parsed.nested, deep, 'a deep value was truncated');
  assert.deepEqual(Object.keys(parsed), ['zeta', 'packages', 'nested', 'alpha', 'skills'], 'the key order changed');
  assert.match(text, /"alpha": 1\.50/, 'a number changed its text');
}, {});

withWorkspace('a Pi settings file with comments or trailing commas is refused by the apply, and is not rewritten', (ctx) => {
  const commented = '{\n  // the user\'s note\n  "defaultProvider": "user-provider",\n}\n';
  writeFile(ctx.workspace, '.pi/agent/settings.json', commented);
  const run = runInstaller(shell, ctx, [], { apply: true });
  assert.notEqual(run.status, 0, `the apply accepted a settings file that is not strict JSON\n${run.stdout}`);
  assert.match(plainOutput(run), /not strict JSON/);
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), commented, 'the settings file was rewritten');
}, {});

withWorkspace('-Remove -Apply keeps a hand-edited Copilot wrapper even when the apply finds no Copilot executable', (ctx) => {
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  appendFileSync(wrapper, 'rem hand edit\r\n');
  const run = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'pi', '-Apply', '-CopilotCommand', MISSING_COPILOT], { apply: false });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(existsSync(wrapper), 'a hand-edited wrapper was deleted without its hash matching the record');
  assert.match(run.stdout, /Kept .*copilot\.cmd: it is not the installer's recorded copy/);
}, {});

// Removal fixes: quarantine, already-gone records, the restore fallback, excluded folders, the swap check, the summary
// line, strays, and offline uninstall from a schema-1 lock.

// Holds a file open without sharing, from another process, until the returned child is killed.
// The ready marker goes to the temp folder, not beside the file: a marker inside an owned folder would change its hash.
function holdExclusive(path) {
  const ready = join(tmpdir(), `maxstack-ready-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const script = `$f = [IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); New-Item -ItemType File -Path '${ready.replaceAll("'", "''")}' | Out-Null; Start-Sleep -Seconds 300`;
  const child = spawn(shell, ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error(`the holder did not open ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  rmSync(ready, { force: true });
  return child;
}

// Runs one removal with a fault in MAXSTACK_TEST_HOOK, and clears it again.
function withHook(hook, body) {
  process.env.MAXSTACK_TEST_HOOK = hook;
  try {
    return body();
  } finally {
    delete process.env.MAXSTACK_TEST_HOOK;
  }
}

const ORIGINAL_CONFIG_B = '{\n  "original": true\n}\n';

withWorkspace('a folder with a file held open by another process is kept, and a retry after the file is released finishes', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace, { skipGit: true });
  mustApply(ctx);
  const held = join(ctx.workspace, ORG_FOLDER, 'skills', 'demo-skill', 'SKILL.md');
  const holder = holdExclusive(held);
  try {
    const first = removal(ctx, ['-Uninstall']);
    assertOk(first);
    assert.match(first.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+in use/m, first.stdout);
    assert.ok(existsSync(ORG_FOLDER_FULL(ctx)) || existsSync(`${ORG_FOLDER_FULL(ctx)}.maxstack-removing`), 'the folder in use was lost');
  } finally {
    holder.kill();
  }
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the retry did not finish');
  assert.deepEqual(snapshotTree(ctx.workspace, { skipGit: true }), before);
}, {});

function ORG_FOLDER_FULL(ctx) {
  return join(ctx.workspace, ...ORG_FOLDER.split('/'));
}

withWorkspace('a recorded file the user already deleted is complete, not a skip, and the uninstall removes the lock', (ctx) => {
  mustApply(ctx);
  rmSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh'));
  const run = removal(ctx, ['-Uninstall', '-Strict']);
  assertOk(run);
  assert.match(run.stdout, /^GONE\s+\.maxstack\/bin\/copilot\.sh\s/m, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock was kept for an already-gone record');
}, {});

withWorkspace('a run that stops between a delete and its lock write finishes on the next run', (ctx) => {
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  const target = '.maxstack/bin/copilot.cmd';
  const crashed = withHook(`crash:${target}`, () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readJson(lockPath(ctx)).owned.some((record) => record.path === target), true, 'the lock lost the record before its write');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false);
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('a Pi settings file with a backup and a user-added key keeps the key, loses the installer entries, and keeps the backup', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'user-model' }, null, 2));
  assertOk(removal(ctx, ['-Uninstall']));
  const settings = readJson(settingsPath(ctx));
  assert.equal(settings.defaultModel, 'user-model', 'the user key was lost');
  assert.deepEqual(settings.packages, ['user-package'], 'an installer entry stayed');
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the backup was lost');
}, {});

withWorkspace('uninstall restores the original config, never a hand edit, and keeps the numbered copy', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG_B);
  mustApply(ctx);
  writeFileSync(join(ctx.workspace, 'opencode.jsonc'), '{\n  "hand": "edit"\n}\n');
  mustApply(ctx);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), ORIGINAL_CONFIG_B, 'the restore did not use the original');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), '{\n  "hand": "edit"\n}\n', 'the hand edit was not kept');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false);
}, {});

withWorkspace('a modified original backup is kept and not restored, and the config goes by its own record', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG_B);
  mustApply(ctx);
  const edited = '{\n  "edited": "backup"\n}\n';
  writeFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), edited);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^KEEP\s+opencode\.jsonc\.bak\s+kept: the original backup changed by hand, so it is not restored/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), edited, 'the modified backup was changed');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the config was not removed by its own record');
}, {});

// A plain .bak with no role is the file the install first replaced (review 2, item 4), so it is restored while the
// settings still hold the installer's text. The user's entries come back with it.
withWorkspace('a settings backup with no role is the file the install replaced, and it is restored while the settings hold the installer text', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete ownedRecord(lock, '.pi/agent/settings.json.bak', 'file').role;
  setLock(ctx, lock);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the file the install replaced was not restored');
  assert.equal(existsSync(`${settingsPath(ctx)}.bak`), false, 'the restored backup was left behind');
}, {});

withWorkspace('a node_modules folder inside an owned folder is counted in the plan, and a junction under it that leads outside refuses the folder', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, `${ORG_FOLDER}/node_modules/extra/index.js`, 'module.exports = 1;\n');
  const plan = removal(ctx, ['-Uninstall'], { apply: false });
  assertOk(plan);
  assert.match(plan.stdout, /^DELETE\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+.*node_modules \(\d+ files, \d+ bytes\)/m, plan.stdout);

  const outside = join(ctx.base, 'outside-modules');
  writeFile(outside, 'keep.txt', 'outside\n');
  symlinkSync(outside, join(ORG_FOLDER_FULL(ctx), 'node_modules', 'linked'), 'junction');
  const refused = removal(ctx, ['-Uninstall']);
  assertOk(refused);
  assert.match(refused.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+refused: a junction under/m, refused.stdout);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside\n', 'the junction target was changed');
  assert.ok(existsSync(ORG_FOLDER_FULL(ctx)), 'the refused folder was deleted');
}, {});

withWorkspace('a file swapped for a folder after the plan is refused, and the folder is not deleted', (ctx) => {
  mustApply(ctx);
  const target = '.maxstack/bin/copilot.cmd';
  const run = withHook(`swap:${target}`, () => removal(ctx, ['-Uninstall']));
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.cmd\s+could not be removed: changed since the plan/m, run.stdout);
  assert.ok(statSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')).isDirectory(), 'the swapped folder was deleted');
}, {});

withWorkspace('a partial uninstall ends with one line that says how many items were skipped and that the lock is kept', (ctx) => {
  mustApply(ctx);
  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'rem hand edit\r\n');
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  const lines = run.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  assert.equal(lines[lines.length - 1], '1 items skipped; lock kept; rerun -Uninstall -Apply to retry.', run.stdout);
}, {});

withWorkspace('a restore that cannot replace its file leaves no uninstall copy behind, and a rerun finishes', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const holder = holdExclusive(settingsPath(ctx));
  let first;
  try {
    first = removal(ctx, ['-Uninstall']);
    assertOk(first);
    assert.equal(existsSync(`${settingsPath(ctx)}.uninstall-restore`), false, 'a copy was left behind');
    assert.equal(existsSync(`${settingsPath(ctx)}.uninstall-replaced`), false, 'a copy was left behind');
    assert.match(first.stdout, /^SKIP\s+\.pi\/agent\/settings\.json\s+could not be removed/m, first.stdout);
  } finally {
    holder.kill();
  }
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS);
}, {});

withWorkspace('uninstall works from a schema-1 lock that has an owned list, and remove still refuses it', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.ownedSchema = 1;
  delete lock.pi.settingsSha256;
  for (const record of lock.owned) {
    delete record.runtime;
    delete record.layers;
    delete record.role;
  }
  setLock(ctx, lock);
  const refused = removal(ctx, ['-Remove', '-Runtimes', 'pi']);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(plainOutput(refused), /its ownedSchema is 1, and -Remove needs version 2/, refused.stdout);
  assert.equal(existsSync(lockPath(ctx)), true, 'the refused -Remove removed the lock');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
  assert.equal(existsSync(join(ctx.workspace, '.opencode')), false, 'the OpenCode folders remain');
}, {});

withWorkspace('a record whose sha256 is null is skipped, and the file is kept', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, '.maxstack/bin/copilot.sh', 'file').sha256 = null;
  setLock(ctx, lock);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.sh\s+modified by hand/m, run.stdout);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh')));
}, {});

withWorkspace('the folders that were there before the install are kept, with their user files, and the round trip holds', (ctx) => {
  writeFile(ctx.workspace, '.claude/user-note.txt', 'mine\n');
  writeFile(ctx.workspace, '.opencode/mine/x.txt', 'mine\n');
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('the user removed a backup: its copy is gone, the config is restored by deleting the installer copy, and the lock is removed', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG_B);
  mustApply(ctx);
  rmSync(join(ctx.workspace, 'opencode.jsonc.bak'));
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^GONE\s+opencode\.jsonc\.bak\s/m, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), false);
}, {});

// Review 2, item 1: a .bak the installer did not write is the user's. The live config is kept in a numbered copy as the
// original, and the user's copy is left untouched and never deleted.
withWorkspace('a user backup beside the live config is kept, and the live config is recoverable byte for byte after apply and uninstall', (ctx) => {
  const live = '{\n  "live": true\n}\n';
  const userBackup = '{\n  "user": "backup"\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', live);
  writeFile(ctx.workspace, 'opencode.jsonc.bak', userBackup);
  const run = mustApply(ctx);
  assert.match(run.stdout, /Backed up the previous config to .*opencode\.jsonc\.bak\.1/, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), live, 'the live config was not kept');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), userBackup, 'the user backup changed on apply');
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').role, 'original', 'the live copy is not the original');
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak', 'file').role, 'user', 'the user backup is not recorded as the user\'s');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), live, 'the live config was not restored');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), userBackup, 'the user backup changed on uninstall');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak.1')), false, 'the restored copy was left behind');
}, {});

// Review 2, item 2: the installer created the config and the Pi settings. A hand edit of either, made after the first
// apply, is an edited copy. It is never the original, so uninstall does not put it back as the file the install replaced.
withWorkspace('a hand edit of files the installer created is kept as an edited copy, and uninstall never restores it as the original', (ctx) => {
  mustApply(ctx);
  const handConfig = '{\n  "hand": "config"\n}\n';
  const handSettings = '{\n  "packages": [\n    "hand-package"\n  ]\n}\n';
  writeFileSync(join(ctx.workspace, 'opencode.jsonc'), handConfig);
  writeFileSync(settingsPath(ctx), handSettings);
  mustApply(ctx);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), handConfig, 'the config edit was not kept as an edited copy');
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak.1`, 'utf8'), handSettings, 'the settings edit was not kept as an edited copy');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'a hand edit became the original config backup');
  assert.equal(existsSync(`${settingsPath(ctx)}.bak`), false, 'a hand edit became the original settings backup');
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').role, 'edited');
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json.bak.1', 'file').role, 'edited');

  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.doesNotMatch(run.stdout, /^RESTORE\s+opencode\.jsonc\s/m, run.stdout);
  assert.doesNotMatch(run.stdout, /^RESTORE\s+\.pi\/agent\/settings\.json\s/m, run.stdout);
  assert.match(run.stdout, /^KEEP\s+opencode\.jsonc\.bak\.1\s/m, run.stdout);
  assert.match(run.stdout, /^KEEP\s+\.pi\/agent\/settings\.json\.bak\.1\s/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), handConfig, 'the kept edit changed');
  // The second apply wrote the installer's text back, so the config is the installer's and is removed; the edit is not put back.
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the installer-created config was not removed');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false);
}, {});

// Review 2, item 3: a run that restored the config and stopped before its lock write must finish on the next run. The
// backup is gone and the config holds its bytes, so the restore is complete, not a hand edit to skip.
withWorkspace('a run that stops after restoring the config and before its lock write finishes on the next run', (ctx) => {
  const original = '{\n  "original": true\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', original);
  mustApply(ctx);
  const crashed = withHook('crash:opencode.jsonc', () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the restore did not happen before the fault');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false);
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was written before the fault');
  const retry = removal(ctx, ['-Uninstall']);
  assertOk(retry);
  assert.doesNotMatch(retry.stdout, /modified by hand/, retry.stdout);
  assert.match(retry.stdout, /^GONE\s+opencode\.jsonc\s+already restored/m, retry.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the retry changed the restored config');
  assert.equal(existsSync(lockPath(ctx)), false, 'the retry did not remove the lock');
}, {});

// Review 2, item 4: real schema-1 locks. scripts/fixtures/schema1 holds the stack.lock.json, the config, and the Pi
// settings that the pre-branch installer (28872d2) wrote in two workspaces, with the machine path replaced by a placeholder
// and every recorded hash recomputed for the normalised bytes. Each file carries a .fixture suffix, so the linters skip it
// and its bytes are read exactly as they were written.
const SCHEMA1 = join(repoRoot, 'scripts', 'fixtures', 'schema1');

function seedSchema1(ctx, name, files) {
  for (const [rel, fixtureFile] of files) writeFile(ctx.workspace, rel, readFileSync(join(SCHEMA1, name, `${fixtureFile}.fixture`)));
  writeFile(ctx.workspace, 'stack.lock.json', readFileSync(join(SCHEMA1, name, 'stack.lock.json.fixture')));
}

withWorkspace('a real schema-1 lock with a pre-existing config restores the original from its role-less backup', (ctx) => {
  seedSchema1(ctx, 'preexisting-config', [['opencode.jsonc', 'opencode.jsonc'], ['opencode.jsonc.bak', 'opencode.jsonc.bak']]);
  const original = readFileSync(join(SCHEMA1, 'preexisting-config', 'opencode.jsonc.bak.fixture'), 'utf8');
  assert.equal(readJson(lockPath(ctx)).ownedSchema, 1);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^RESTORE\s+opencode\.jsonc\s/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the original was not restored');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'the restored backup was left behind');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

withWorkspace('a real schema-1 lock whose config changed since the install keeps the config and names the original in its backup', (ctx) => {
  seedSchema1(ctx, 'preexisting-config', [['opencode.jsonc', 'opencode.jsonc'], ['opencode.jsonc.bak', 'opencode.jsonc.bak']]);
  const changed = '{\n  "changed": true\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', changed);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), changed, 'the changed config was deleted or overwritten');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), true, 'the original backup was deleted');
  assert.match(run.stdout, /^KEEP\s+opencode\.jsonc\s+kept: it changed since the install, so the original is not restored; the original is in opencode\.jsonc\.bak/m, run.stdout);
  assert.match(run.stdout, /Kept on disk, not restored or deleted: .*opencode\.jsonc\.bak/, run.stdout);
  assert.doesNotMatch(run.stdout, /every recorded path was removed/, 'the summary claims a removal that did not happen');
}, {});

withWorkspace('a real schema-1 lock from a fresh install deletes the config and settings the installer created', (ctx) => {
  seedSchema1(ctx, 'fresh', [['opencode.jsonc', 'opencode.jsonc'], ['.pi/agent/settings.json', 'settings.json']]);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^DELETE\s+opencode\.jsonc\s/m, run.stdout);
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the installer-created config was kept');
  assert.equal(existsSync(join(ctx.workspace, '.pi', 'agent', 'settings.json')), false, 'the installer-created settings were kept');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

// Review 2, item 5: a quarantine folder that is not the one this lock journaled is the user's. It is named, and kept.
withWorkspace('a folder with the quarantine name beside a recorded folder is the user\'s, and a removal does not delete it', (ctx) => {
  mustApply(ctx);
  rmSync(ORG_FOLDER_FULL(ctx), { recursive: true, force: true });
  writeFile(ctx.workspace, `${ORG_FOLDER}.maxstack-removing/user.txt`, 'mine\n');
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+in the way: a folder named simpsonm09-org-ai-plugin\.maxstack-removing exists/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, `${ORG_FOLDER}.maxstack-removing`, 'user.txt'), 'utf8'), 'mine\n', 'the user folder was deleted');
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was removed beside a skipped folder');
}, {});

// A quarantine the lock journaled, whose files changed after the journal, is kept and named. An unchanged one is resumed.
withWorkspace('a journaled quarantine whose files changed since the journal is kept and named', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  writeFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'changed by the user\n');
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+in the way/m, run.stdout);
  assert.equal(readFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), 'changed by the user\n', 'the changed folder was deleted');
}, {});

withWorkspace('a journaled quarantine whose files are unchanged is resumed and deleted by the uninstall', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^DELETE\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+resumes the removal/m, run.stdout);
  assert.equal(existsSync(quarantine), false, 'the quarantine was not deleted');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

// Review 2, item 6: a leftover copy whose bytes the lock records is deleted; any other leftover is named and kept, and
// the lock stays for it.
withWorkspace('a leftover copy the lock knows is deleted, and an unknown one is named, kept, and keeps the lock', (ctx) => {
  mustApply(ctx);
  const known = join(ctx.workspace, 'opencode.jsonc.maxstack-tmp');
  writeFileSync(known, readFileSync(join(ctx.workspace, 'opencode.jsonc')));
  const unknown = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd.uninstall-restore');
  writeFileSync(unknown, 'unknown\n');
  const plan = removal(ctx, ['-Uninstall'], { apply: false });
  assertOk(plan);
  assert.match(plan.stdout, /^DELETE\s+opencode\.jsonc\.maxstack-tmp\s/m, plan.stdout);
  assert.match(plan.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.cmd\.uninstall-restore\s+a leftover copy/m, plan.stdout);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.equal(existsSync(known), false, 'the known copy was kept');
  assert.equal(readFileSync(unknown, 'utf8'), 'unknown\n', 'the unknown copy was changed or deleted');
  assert.match(run.stdout, /items skipped; lock kept; rerun -Uninstall -Apply to retry/, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was removed beside an unknown copy');
}, {});

withWorkspace('an apply deletes a leftover copy the lock knows and names the rest', (ctx) => {
  mustApply(ctx);
  const known = join(ctx.workspace, 'opencode.jsonc.maxstack-old');
  writeFileSync(known, readFileSync(join(ctx.workspace, 'opencode.jsonc')));
  const unknown = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh.uninstall-replaced');
  writeFileSync(unknown, 'unknown\n');
  const run = mustApply(ctx);
  assert.equal(existsSync(known), false, 'the apply kept a copy the lock knows');
  assert.match(run.stdout, /^SKIP\s+\.maxstack\/bin\/pi\.sh\.uninstall-replaced\s+a leftover copy of \.maxstack\/bin\/pi\.sh whose bytes the lock does not record/m, run.stdout);
  assert.equal(readFileSync(unknown, 'utf8'), 'unknown\n', 'the apply changed an unknown copy');
}, {});

// Review 2, item 7: a copy whose bytes an earlier backup already holds is not written again.
withWorkspace('a Pi settings rewrite that repeats an earlier version writes no new numbered backup', (ctx) => {
  mustApply(ctx);
  const edit = JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'pi-rewrite' }, null, 2);
  writeFileSync(settingsPath(ctx), edit);
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak.1`, 'utf8'), edit);
  writeFileSync(settingsPath(ctx), edit);
  const run = mustApply(ctx);
  assert.equal(existsSync(`${settingsPath(ctx)}.bak.2`), false, 'an identical copy was written again');
  assert.match(run.stdout, /already kept in .*settings\.json\.bak\.1, so no new copy was made/, run.stdout);
  const uninstall = removal(ctx, ['-Uninstall']);
  assertOk(uninstall);
  assert.match(uninstall.stdout, /Kept on disk, not restored or deleted: .*\.pi\/agent\/settings\.json\.bak\.1/, uninstall.stdout);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak.1`, 'utf8'), edit, 'the kept copy changed');
}, {});

// Review 2, item 8: a settings file that is not strict JSON keeps its backup as a skip, with the record, and says so.
withWorkspace('a Pi settings file that is not strict JSON keeps its backup and its record, and the message says the backup stays', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), '{\n  // a comment\n  "packages": []\n}\n');
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.pi\/agent\/settings\.json\.bak\s+kept: the settings file could not be edited, so its original stays in place/m, run.stdout);
  assert.doesNotMatch(run.stdout, /only the installer entries were removed/, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was removed');
  assert.ok(ownedRecord(readJson(lockPath(ctx)), '.pi/agent/settings.json.bak', 'file'), 'the backup record was dropped');
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the backup changed');
}, {});

// Review 2, item 5: a plain apply does not delete a quarantine folder, and it names one an interrupted removal left.
withWorkspace('a plain apply names a quarantine folder beside a recorded folder, and leaves it in place', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  writeFile(ctx.workspace, `${ORG_FOLDER}.maxstack-removing/left.txt`, 'left\n');
  const run = mustApply(ctx);
  assert.match(run.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\.maxstack-removing\s+a folder with the removal quarantine name/m, run.stdout);
  assert.equal(readFileSync(join(quarantine, 'left.txt'), 'utf8'), 'left\n', 'the apply changed the quarantine folder');
}, {});

// Review 3, item 1: a restore that stopped before its lock write, then a plain apply. The live file is the original again,
// so the apply writes it back as the original, and uninstall restores it byte for byte.
withWorkspace('a plain apply after a config restore that stopped keeps the user config as the original, and uninstall restores it byte for byte', (ctx) => {
  const user = '{\n  "user": "config"\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', user);
  mustApply(ctx);
  const crashed = withHook('crash:opencode.jsonc', () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), user, 'the restore did not happen before the fault');
  mustApply(ctx);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), user, 'the user config was not kept as the original');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak.1')), false, 'the user config was filed as an edited copy');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), user, 'the user config was not restored byte for byte');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'the restored original was left behind');
}, {});

withWorkspace('a plain apply after a Pi settings restore that stopped keeps the user settings as the original, and uninstall restores them byte for byte', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const crashed = withHook('crash:.pi/agent/settings.json', () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the restore did not happen before the fault');
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the user settings were not kept as the original');
  assert.equal(existsSync(`${settingsPath(ctx)}.bak.1`), false, 'the user settings were filed as an edited copy');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the user settings were not restored byte for byte');
}, {});

// Review 3, item 2: an upgrade apply over a real schema-1 lock records the config the way uninstall infers it.
withWorkspace('an upgrade apply over a real schema-1 fresh lock records the config as created, and uninstall removes it and the settings', (ctx) => {
  seedSchema1(ctx, 'fresh', [['opencode.jsonc', 'opencode.jsonc'], ['.pi/agent/settings.json', 'settings.json']]);
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.ownedSchema, 2);
  assert.ok(lock.createdFiles.includes('opencode.jsonc'), `createdFiles ${JSON.stringify(lock.createdFiles)}`);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.doesNotMatch(run.stdout, /it existed before the install/, run.stdout);
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the installer-created config was kept');
  assert.equal(existsSync(settingsPath(ctx)), false, 'the installer-created settings were kept');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

withWorkspace('an upgrade apply over a real schema-1 lock with a pre-existing config keeps the original, and uninstall restores it', (ctx) => {
  seedSchema1(ctx, 'preexisting-config', [['opencode.jsonc', 'opencode.jsonc'], ['opencode.jsonc.bak', 'opencode.jsonc.bak']]);
  const original = readFileSync(join(SCHEMA1, 'preexisting-config', 'opencode.jsonc.bak.fixture'), 'utf8');
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak', 'file').role, 'original');
  assert.equal(lock.createdFiles.includes('opencode.jsonc'), false, 'a pre-existing config was recorded as created');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the original was not restored');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'the restored original was left behind');
}, {});

// Review 3, item 3: a plain apply after a removal that journaled a quarantine.
withWorkspace('a plain apply finishes a journaled quarantine it left, prints it once, and writes the folder again', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = mustApply(ctx);
  assert.equal(existsSync(quarantine), false, 'the journaled quarantine was kept');
  assert.equal(existsSync(ORG_FOLDER_FULL(ctx)), true, 'the folder was not written again');
  assert.equal(run.stdout.split(/\r?\n/).filter((line) => line.includes('maxstack-removing')).length, 1, run.stdout);
  assert.doesNotMatch(run.stdout, /Rerun -Uninstall/, run.stdout);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

withWorkspace('a plain apply keeps a journaled quarantine whose files changed, names it once, and keeps the journal', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  writeFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'changed by the user\n');
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = mustApply(ctx);
  const lines = run.stdout.split(/\r?\n/).filter((line) => line.includes('maxstack-removing'));
  assert.equal(lines.length, 1, run.stdout);
  assert.match(lines[0], /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+kept: simpsonm09-org-ai-plugin\.maxstack-removing holds files that changed since its removal began/, lines[0]);
  assert.equal(readFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), 'changed by the user\n', 'the changed folder was deleted');
  const kept = readJson(lockPath(ctx));
  assert.equal(ownedRecord(kept, ORG_FOLDER, 'dir').quarantine, 'simpsonm09-org-ai-plugin.maxstack-removing', 'the journal was dropped');
  assert.doesNotMatch(run.stdout, /Rerun -Uninstall/, run.stdout);
}, {});

// ---- Layer sources: -Source, the -LayerSource alias, and the recorded override -----------------------------------
// A git command in a folder. A failing command fails the test, so a fixture that did not build is never a result.
function gitRun(dir, args) {
  const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

// The test stand-in for github.com. MAXSTACK_TEST_GITHUB_ROOT names the folder, and owner/repo resolves to
// <root>/<owner>/<repo>.git. GIT_TERMINAL_PROMPT stops git from waiting for a credential.
function githubEnv(ctx) {
  return { ...process.env, MAXSTACK_TEST_GITHUB_ROOT: join(ctx.base, 'github'), GIT_TERMINAL_PROMPT: '0' };
}

function remoteUrl(ctx, owner, repo) {
  return join(ctx.base, 'github', owner, `${repo}.git`).replace(/\\/g, '/');
}

// Serves a copy of a repository as <owner>/<repo>.git under the test GitHub root, and returns the bare path.
function serveRepo(ctx, owner, repo, sourceDir) {
  const bare = join(ctx.base, 'github', owner, `${repo}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  gitRun(ctx.base, ['clone', '--bare', '--quiet', sourceDir, bare]);
  gitRun(bare, ['config', 'uploadpack.allowFilter', 'true']);
  gitRun(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return bare;
}

// Commits one file on a branch of a served repository, starting from the branch or from the default branch, and
// pushes it there. Returns the new commit.
function commitToBranch(ctx, bare, branch, relPath, content) {
  const work = join(ctx.base, 'work');
  if (!existsSync(work)) gitRun(ctx.base, ['clone', '--quiet', bare, work]);
  gitRun(work, ['fetch', '--quiet', 'origin']);
  const hasBranch = spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  gitRun(work, ['checkout', '-q', '-B', branch, hasBranch ? `origin/${branch}` : 'origin/HEAD']);
  writeFile(work, relPath, content);
  gitRun(work, ['add', '-A']);
  gitRun(work, ['commit', '-q', '-m', `change on ${branch}`]);
  gitRun(work, ['push', '-q', 'origin', branch]);
  return gitRun(work, ['rev-parse', 'HEAD']);
}

const SKILL_PATH = 'plugins/pstack/skills/poteto-mode/SKILL.md';
const SKILL_FEAT = '---\nname: poteto-mode\ndescription: fixture\n---\nfeat body\n';
const installedSkill = (ctx) => join(ctx.workspace, '.opencode', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md');

// pstack served as simpsonm09/pstack-claude, with a feat branch that changes its skill.
function servedFeature(ctx) {
  const bare = serveRepo(ctx, 'simpsonm09', 'pstack-claude', ctx.fixture.dir);
  const featCommit = commitToBranch(ctx, bare, 'feat', SKILL_PATH, SKILL_FEAT);
  return { bare, featCommit };
}

function sourceOf(ctx, name) {
  const record = readJson(lockPath(ctx)).layers.find((layer) => layer.name === name);
  assert.ok(record, `the lock has no record for ${name}`);
  return record;
}

withWorkspace('-Source owner/repo@branch installs the branch commit, and the lock records it as an override', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/, 'the branch content was not installed');

  const pstack = sourceOf(ctx, 'pstack');
  assert.deepEqual(pstack.source, { kind: 'git', url: remoteUrl(ctx, 'simpsonm09', 'pstack-claude'), ref: 'feat', commit: featCommit, override: true });
  assert.equal(pstack.commit, featCommit, 'the layer commit is the resolved branch commit');
  assert.equal(sourceOf(ctx, 'simpsonm09-org-ai-plugin').source.override, false, 'a layer no flag names is not an override');
}, {});

withWorkspace('a recorded override persists across a plain apply, and -Source name=default drops it', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  mustApply(ctx, [], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').source.override, true, 'the plain apply dropped the override');
  assert.equal(sourceOf(ctx, 'pstack').commit, featCommit, 'the plain apply moved the recorded commit');
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/);

  mustApply(ctx, ['-Source', 'pstack=default'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').source.override, false, '-Source name=default kept the override');
  assert.equal(sourceOf(ctx, 'pstack').commit, ctx.fixture.commit, 'the default pin is installed again');
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /fixture body/);
}, {});

withWorkspace('a local source installs the working tree as it is, and the lock records HEAD and the dirty flag', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const head = gitRun(checkout, ['rev-parse', 'HEAD']);
  writeFile(checkout, 'index.ts', 'export default { edited: true };\n');

  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  assert.match(readFileSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts'), 'utf8'), /edited: true/);
  const org = sourceOf(ctx, 'simpsonm09-org-ai-plugin');
  assert.deepEqual(org.source, { kind: 'local', url: null, ref: null, commit: head, dirty: true, override: true, path: checkout });
  assert.equal(org.commit, head);
}, {});

withWorkspace('pstack installs from a local checkout, comma-separated with another layer, and a folder that is not git records no commit', (ctx) => {
  const pstackCheckout = join(ctx.base, 'pstack-checkout');
  cpSync(ctx.fixture.dir, pstackCheckout, { recursive: true });
  const head = gitRun(pstackCheckout, ['rev-parse', 'HEAD']);
  writeFile(pstackCheckout, SKILL_PATH, '---\nname: poteto-mode\ndescription: fixture\n---\nlocal edit\n');
  const orgCheckout = join(ctx.base, 'org-plain');
  writeLayerStub(orgCheckout, { claudePlugin: 'simpsonm09-org-ai-plugin' });

  mustApply(ctx, ['-Source', `pstack=local:${pstackCheckout},simpsonm09-org-ai-plugin=local:${orgCheckout}`]);
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /local edit/, 'pstack was not installed from its checkout');
  assert.ok(existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack', '.claude-plugin', 'plugin.json')), 'the Claude copy lacks the manifest');
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack', '.git')), false, 'the Claude copy carries .git');
  assert.deepEqual(sourceOf(ctx, 'pstack').source, { kind: 'local', url: null, ref: null, commit: head, dirty: true, override: true, path: pstackCheckout });
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'cache', 'pstack')), false, 'a local source keeps no git cache');

  const org = sourceOf(ctx, 'simpsonm09-org-ai-plugin');
  assert.equal(org.commit, null, 'a folder that is not a git checkout records no commit');
  assert.equal(org.source.dirty, null, 'a folder that is not a git checkout records no dirty flag');
}, {});

const REFUSED_SOURCES = [
  ['pstack=http://github.com/simpsonm09/pstack-claude.git@feat', 'only https'],
  ['pstack=ssh://git@github.com/simpsonm09/pstack-claude.git@feat', 'only https'],
  ['pstack=file:///tmp/pstack.git@feat', 'only https'],
  ['pstack=https://user@github.com/simpsonm09/pstack-claude.git@feat', 'only https'],
  ['pstack=simpsonm09/pstack-claude@feat..x', 'holds [.][.]'],
  ['pstack=simpsonm09/pstack-claude@-feat', 'not a safe git ref name'],
  ['pstack=simpsonm09/pstack-claude@feat~1', 'not a safe git ref name'],
  ['pstack=simpsonm09/pstack-claude@feat.lock', 'not a safe git ref name'],
  ['pstack=simpsonm09/pstack-claude@feat x', 'space or a control character'],
  ['pstack=simpsonm09/pstack claude@feat', 'space or a control character'],
  ['pstack=-simpsonm09/pstack-claude@feat', 'starts with a dash'],
  ['pstack=simpsonm09/pstack-claude', 'needs @ref'],
  ['pstack=simpsonm09/..x@feat', 'holds \\.\\.'],
  ['pstack=local:relative/checkout', 'needs an absolute path'],
  ['nosuchlayer=simpsonm09/pstack-claude@feat', 'names an unknown layer'],
];

withWorkspace('malformed -Source specs and unknown layers are refused before anything is written', (ctx) => {
  for (const [spec, reason] of REFUSED_SOURCES) {
    const run = runInstaller(shell, ctx, ['-Source', spec]);
    assert.notEqual(run.status, 0, `the installer accepted -Source ${spec}`);
    assert.match(plainOutput(run), new RegExp(reason), `${spec}: ${run.stdout}\n${run.stderr}`);
    assert.equal(existsSync(lockPath(ctx)), false, `${spec} wrote a lock`);
    assert.equal(existsSync(join(ctx.workspace, '.claude')), false, `${spec} wrote under .claude`);
  }
}, {});

withWorkspace('a local source is refused for the workspace itself and for each folder the installer writes', (ctx) => {
  for (const folder of [ctx.workspace, join(ctx.workspace, '.claude'), join(ctx.workspace, '.claude', 'cache')]) {
    mkdirSync(folder, { recursive: true });
    const run = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${folder}`]);
    assert.notEqual(run.status, 0, `the installer accepted ${folder}`);
    assert.match(plainOutput(run), /cannot be a layer source/, run.stdout);
  }
  assert.equal(existsSync(lockPath(ctx)), false, 'a refused local source wrote a lock');
}, {});

withWorkspace('an https source that cannot be reached fails with the reason, and leaves the install untouched', (ctx) => {
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);
  const run = runInstaller(shell, ctx, ['-Source', 'pstack=https://127.0.0.1:1/simpsonm09/pstack-claude.git@feat'], { env: githubEnv(ctx) });
  assert.notEqual(run.status, 0, 'an unreachable source was accepted');
  assert.match(plainOutput(run), /could not read the refs of https:\/\/127\.0\.0\.1:1/, run.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a failed source changed the install');
}, {});

withWorkspace('-Status, -Remove, and -Uninstall refuse -Source, which only an apply or an audit takes', (ctx) => {
  for (const args of [['-Status'], ['-Remove', '-Layers', 'pstack'], ['-Uninstall']]) {
    const run = runInstaller(shell, ctx, [...args, '-Source', 'pstack=simpsonm09/pstack-claude@feat'], { apply: false });
    assert.notEqual(run.status, 0, `${args.join(' ')} accepted -Source`);
    assert.match(plainOutput(run), /-Source sets a layer source for an apply or an audit/, run.stdout);
  }
}, {});

withWorkspace('an overridden layer is removed by -Uninstall like any other', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
  assert.equal(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin')), false, 'the overridden folder remains');
}, {});

// The layer-source block: -Status and an audit name every override, every local source, and no pin that holds.
const STATE_ROW = /^(matching|drifted|modified|missing|untracked|not selected)\s/;

// The lines between the block's header and the first state row, or none when the block is absent.
function sourceBlockOf(stdout) {
  const lines = stdout.split(/\r?\n/);
  const header = lines.indexOf('Layer sources not at their committed pin:');
  if (header < 0) return null;
  const firstState = lines.findIndex((line, index) => index > header && STATE_ROW.test(line));
  return { header, lines: lines.slice(header + 1, firstState < 0 ? undefined : firstState), firstState };
}

withWorkspace('-Status prints the layer-source block above the state rows, with each override and each local source', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, env: githubEnv(ctx) });
  assertOk(status);

  const block = sourceBlockOf(status.stdout);
  assert.ok(block, `no source block:\n${status.stdout}`);
  assert.ok(block.firstState > block.header, 'the block is below a state row');
  const text = block.lines.join('\n');
  assert.match(text, new RegExp(`pstack: override, git \\S+ ref feat at ${featCommit}`), text);
  assert.match(text, /simpsonm09-org-ai-plugin: local, default /, text);
  assert.doesNotMatch(text, /pstack: .*local/, 'a pinned git layer is listed as local');
}, {});

withWorkspace('a default workspace lists its local layers in the block and no git pin', (ctx) => {
  mustApply(ctx);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  const block = sourceBlockOf(status.stdout);
  assert.ok(block, status.stdout);
  const text = block.lines.join('\n');
  assert.match(text, /simpsonm09-org-ai-plugin: local, default/);
  assert.match(text, /simpsonm09-personal-ai-plugin: local, default/);
  assert.doesNotMatch(text, /pstack/, 'the pinned pstack layer is listed');
}, {});

withWorkspace('an audit names the source it would install, and writes nothing', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);
  const audit = runInstaller(shell, ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { apply: false, env: githubEnv(ctx) });
  assertOk(audit);
  const block = sourceBlockOf(audit.stdout);
  assert.ok(block, audit.stdout);
  assert.match(block.lines.join('\n'), new RegExp(`pstack: override, git \\S+ ref feat at ${featCommit}`));
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'an audit changed the workspace');
}, {});

// -Update: a branch or tag override moves to its current commit, a commit pin and a default pin do not, and a local
// source is re-read. A check writes nothing. A failed resolve leaves the install as it was.
const SKILL_FEAT_TWO = '---\nname: poteto-mode\ndescription: fixture\n---\nfeat body two\n';

// Moves the feat branch on the served repository to a new commit, which the workspace has not fetched.
function moveFeat(ctx, bare) {
  return commitToBranch(ctx, bare, 'feat', SKILL_PATH, SKILL_FEAT_TWO);
}

withWorkspace('-Update moves a branch override to its current commit and records it, and a dry run changes nothing', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const lockBefore = readFileSync(lockPath(ctx), 'utf8');
  const featTwo = moveFeat(ctx, bare);

  const dry = runInstaller(shell, ctx, ['-Update'], { apply: false, env: githubEnv(ctx) });
  assertOk(dry);
  assert.match(dry.stdout, new RegExp(`feat ${featCommit} -> ${featTwo}`), dry.stdout);
  assert.equal(readFileSync(lockPath(ctx), 'utf8'), lockBefore, 'a dry -Update changed the lock');

  mustApply(ctx, ['-Update'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').commit, featTwo, 'the branch override did not move');
  assert.equal(sourceOf(ctx, 'pstack').source.override, true);
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body two/, 'the moved content was not installed');
}, {});

withWorkspace('-Update does not move a commit pin, even when its branch has moved', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', `pstack=simpsonm09/pstack-claude@${featCommit}`], { env: githubEnv(ctx) });
  moveFeat(ctx, bare);
  mustApply(ctx, ['-Update'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').commit, featCommit, 'a commit pin moved');
  assert.equal(sourceOf(ctx, 'pstack').source.ref, featCommit);
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/);
  assert.doesNotMatch(readFileSync(installedSkill(ctx), 'utf8'), /feat body two/);
}, {});

withWorkspace('-Update -Check writes nothing, not even the cache, and reports the move and the drift', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const featTwo = moveFeat(ctx, bare);
  const before = snapshotTree(ctx.workspace);
  const lockBefore = readFileSync(lockPath(ctx));

  const check = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) });
  assertOk(check);
  assert.match(check.stdout, new RegExp(`feat ${featCommit} -> ${featTwo}`), check.stdout);
  assert.match(check.stdout, /needs fetch/, check.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, '-Update -Check changed the tree or the cache');
  assert.deepEqual(readFileSync(lockPath(ctx)), lockBefore, '-Update -Check changed the lock');

  const strict = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false, env: githubEnv(ctx) });
  assert.equal(strict.status, 1, `-Strict did not exit 1 when a source would move:\n${strict.stdout}`);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'the strict check changed the tree or the cache');
}, {});

withWorkspace('-Update -Check -Strict exits 0 when nothing would change', (ctx) => {
  servedFeature(ctx);
  mustApply(ctx);
  const strict = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false, env: githubEnv(ctx) });
  assert.equal(strict.status, 0, `${strict.stdout}\n${strict.stderr}`);
  assert.match(strict.stdout, /Nothing would change/, strict.stdout);
}, {});

withWorkspace('-Update needs a lock with a selection, and refuses the flags it does not take', (ctx) => {
  const none = runInstaller(shell, ctx, ['-Update'], { apply: false });
  assert.notEqual(none.status, 0, '-Update ran without a lock');
  assert.match(plainOutput(none), /needs a stack\.lock\.json with a selection/, none.stdout);

  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete lock.selection;
  setLock(ctx, lock);
  const legacy = runInstaller(shell, ctx, ['-Update'], { apply: false });
  assert.notEqual(legacy.status, 0, '-Update ran on a lock with no selection');
  assert.match(plainOutput(legacy), /predates the selection/, legacy.stdout);

  mustApply(ctx);
  for (const [args, reason] of [
    [['-Update', '-Remove', '-Layers', 'pstack'], /-Update re-resolves the recorded sources/],
    [['-Update', '-Uninstall'], /-Update re-resolves the recorded sources/],
    [['-Update', '-Status'], /-Update re-resolves the recorded sources/],
    [['-Update', '-Source', 'pstack=simpsonm09/pstack-claude@feat'], /Set a source with -Source and an apply/],
    [['-Update', '-Layers', 'pstack'], /applies the recorded selection/],
    [['-Check'], /-Check applies to -Update/],
    [['-Update', '-Check', '-Apply'], /-Check writes nothing/],
    [['-Update', '-Apply', '-Strict'], /reports and writes nothing/],
  ]) {
    const run = runInstaller(shell, ctx, args, { apply: false, env: githubEnv(ctx) });
    assert.notEqual(run.status, 0, `${args.join(' ')} was accepted`);
    assert.match(plainOutput(run), reason, `${args.join(' ')}: ${run.stdout}\n${run.stderr}`);
  }
}, {});

withWorkspace('-Update re-reads a local source, and an apply then installs what the checkout holds', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  writeFile(checkout, 'index.ts', 'export default { edit: 1 };\n');
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);

  writeFile(checkout, 'index.ts', 'export default { edit: 2 };\n');
  const installed = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts');
  const check = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false });
  assert.equal(check.status, 1, `the edited checkout was not reported:\n${check.stdout}`);
  assert.match(readFileSync(installed, 'utf8'), /edit: 1/, 'the check changed the install');

  mustApply(ctx, ['-Update']);
  assert.match(readFileSync(installed, 'utf8'), /edit: 2/, '-Update did not re-read the checkout');
  assert.equal(sourceOf(ctx, 'simpsonm09-org-ai-plugin').source.dirty, true);
}, {});

withWorkspace('a -Update whose branch cannot be resolved fails with the reason, and leaves the install untouched', (ctx) => {
  const { bare } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  gitRun(bare, ['update-ref', '-d', 'refs/heads/feat']);
  const before = snapshotTree(ctx.workspace);
  const run = runInstaller(shell, ctx, ['-Update'], { env: githubEnv(ctx) });
  assert.notEqual(run.status, 0, '-Update resolved a branch that is gone');
  assert.match(plainOutput(run), /has no branch or tag named feat/, run.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a failed -Update changed the install');
}, {});

withWorkspace('-Update prints the pin hint when layers.json\'s branch has moved, and moves no pin', (ctx) => {
  mustApply(ctx);
  const lockBefore = readFileSync(lockPath(ctx), 'utf8');
  gitRun(ctx.fixture.dir, ['checkout', '-q', '-b', 'test']);
  writeFile(ctx.fixture.dir, SKILL_PATH, '---\nname: poteto-mode\ndescription: fixture\n---\nnewer\n');
  gitRun(ctx.fixture.dir, ['add', '-A']);
  gitRun(ctx.fixture.dir, ['commit', '-q', '-m', 'newer']);
  const newer = gitRun(ctx.fixture.dir, ['rev-parse', 'HEAD']);

  const run = runInstaller(shell, ctx, ['-Update'], { apply: false });
  assertOk(run);
  assert.match(run.stdout, new RegExp(`layers\\.json pins ${ctx.fixture.commit}, and test is at ${newer}`), run.stdout);
  assert.match(run.stdout, /-Update never moves a pin/, run.stdout);
  assert.equal(readFileSync(lockPath(ctx), 'utf8'), lockBefore, 'the hint changed the lock');
}, {});

withWorkspace('a lock from before the source block lists its local layers as defaults, and names no dirty state it never recorded', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const LEGACY_COMMIT = 'b'.repeat(40);
  for (const layer of lock.layers) {
    layer.source = layer.source.url;
  }
  lock.layers.find((layer) => layer.name === 'simpsonm09-org-ai-plugin').commit = LEGACY_COMMIT;
  setLock(ctx, lock);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  const text = sourceBlockOf(status.stdout).lines.join('\n');
  assert.match(text, new RegExp(`simpsonm09-org-ai-plugin: local, default \\S+ \\(HEAD ${LEGACY_COMMIT}, dirty state not recorded\\)`), text);
  assert.doesNotMatch(text, /pstack/, 'the pinned pstack layer is listed');
}, {});

withWorkspace('-Source owner/repo@tag resolves an annotated tag to the commit it points at', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  gitRun(bare, ['tag', '-a', 'v1', '-m', 'release', featCommit]);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@v1'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').commit, featCommit, 'the annotated tag resolved to its tag object, not its commit');
  assert.deepEqual(sourceOf(ctx, 'pstack').source, { kind: 'git', url: remoteUrl(ctx, 'simpsonm09', 'pstack-claude'), ref: 'v1', commit: featCommit, override: true });
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/, 'the tagged content was not installed');
}, {});

// ---- Hardening of the layer sources: each test names one review finding, and each fails before its fix. ----

// A config layer served from a local bare repository, pinned to its commit, for a git override of that layer.
function servedConfigLayer(ctx) {
  const source = join(ctx.base, 'cfg-src');
  writeLayerStub(source, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(source, ['init', '-q']);
  gitRun(source, ['add', '-A']);
  gitRun(source, ['commit', '-q', '-m', 'config layer']);
  const commit = gitRun(source, ['rev-parse', 'HEAD']);
  serveRepo(ctx, 'simpsonm09', 'org-ai-plugin', source);
  return commit;
}

// Finding 1: a config layer under a git override is read from its cache, and an audit with no cache says so.
withWorkspace('a config layer under a git override runs -Status and -Update -Check without throwing', (ctx) => {
  const commit = servedConfigLayer(ctx);
  const override = ['-Source', `simpsonm09-org-ai-plugin=simpsonm09/org-ai-plugin@${commit}`];
  mustApply(ctx, override, { env: githubEnv(ctx) });
  assertOk(runInstaller(shell, ctx, ['-Status'], { apply: false, env: githubEnv(ctx) }));
  assertOk(runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) }));
}, {});

withWorkspace('a config layer pinned by -Source and audited without -Apply names its config as unknown, and does not throw', (ctx) => {
  const commit = servedConfigLayer(ctx);
  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=simpsonm09/org-ai-plugin@${commit}`], { apply: false, env: githubEnv(ctx) });
  assertOk(audit);
  assert.match(audit.stdout, /Drift: .*opencode\.jsonc: unknown until -Apply syncs the layer cache/, audit.stdout);
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'cache')), false, 'an audit fetched the cache');
}, {});

// Finding 2: a local tree is read with git, and its .git/config may name a program git runs. An audit must run none of it.
withWorkspace('an audit of a -Source local tree runs no program that its .git/config names', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'fsmonitor-marker');
  gitRun(checkout, ['config', 'core.fsmonitor', `touch '${marker.split('\\').join('/')}'`]);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the command that core.fsmonitor names');
}, {});

// Finding 3: a recorded local override whose folder is gone is reported, and only an apply stops on it.
withWorkspace('a recorded local override whose folder is gone is reported by -Status, -Update -Check, and -Remove, and only -Apply stops', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  rmSync(checkout, { recursive: true, force: true });
  const missing = `local ${checkout}: folder missing`;

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.ok(status.stdout.includes(missing), status.stdout);

  const check = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false });
  assert.equal(check.status, 1, `a missing folder is counted as a change, so -Strict exits 1:\n${check.stdout}`);
  assert.ok(check.stdout.includes(missing), check.stdout);

  assertOk(runInstaller(shell, ctx, ['-Uninstall'], { apply: false }));
  assertOk(runInstaller(shell, ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], { apply: false }));
  const refused = removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']);
  assert.notEqual(refused.status, 0, 'a removal rewrote the config without the missing fragment');
  assert.match(plainOutput(refused), /has no folder at .*Restore the folder, then rerun/, refused.stdout);
  assert.doesNotMatch(plainOutput(refused), /-Source/, refused.stdout);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin')), 'a refused removal removed the layer');

  mustApply(ctx, ['-Source', 'simpsonm09-org-ai-plugin=default']);
  assertOk(removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']));
  assert.equal(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin')), false, 'the other layer was not removed');
}, {});

// Finding 3: -Update resolves only the layers it selects, so a remote the selection leaves out cannot abort it.
withWorkspace('-Update resolves only the selected layers, so an unreachable remote of an unselected layer does not abort', (ctx) => {
  const { bare } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const lock = readJson(lockPath(ctx));
  lock.selection.layers = lock.selection.layers.filter((name) => name !== 'pstack');
  setLock(ctx, lock);
  rmSync(bare, { recursive: true, force: true });

  const check = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) });
  assertOk(check);
  assert.doesNotMatch(plainOutput(check), /could not read the refs/, check.stdout);
}, {});

// Finding 4: the changed-file count of an -Update -Check report. A rename makes git read blobs the partial cache lacks.
// The feat branch moves the skill to a new name and edits it, which is an inexact rename that reads both blobs.
const SKILL_MOVED = 'plugins/pstack/skills/poteto-renamed/SKILL.md';

function renameSkillOnFeat(ctx) {
  const work = join(ctx.base, 'work');
  gitRun(work, ['fetch', '--quiet', 'origin']);
  gitRun(work, ['checkout', '-q', '-B', 'feat', 'origin/feat']);
  mkdirSync(join(work, dirname(SKILL_MOVED)), { recursive: true });
  gitRun(work, ['mv', SKILL_PATH, SKILL_MOVED]);
  writeFile(work, SKILL_MOVED, SKILL_FEAT_TWO);
  gitRun(work, ['add', '-A']);
  gitRun(work, ['commit', '-q', '-m', 'rename the skill']);
  gitRun(work, ['push', '-q', 'origin', 'feat']);
  return gitRun(work, ['rev-parse', 'HEAD']);
}

withWorkspace('-Update -Check counts the changed files of a rename that the partial cache must read, and does not report zero', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const renamed = renameSkillOnFeat(ctx);
  const cache = join(ctx.workspace, '.claude', 'cache', 'pstack');
  gitRun(cache, ['fetch', '--quiet', '--filter=blob:none', 'origin', renamed]);

  const check = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) });
  assertOk(check);
  assert.match(check.stdout, new RegExp(`feat ${featCommit} -> ${renamed}; 2 files changed under plugins/pstack`), check.stdout);
  assert.doesNotMatch(check.stdout, /0 files changed/, check.stdout);
}, {});

// Finding 5: the owner/repo shorthand reads a local folder only in a test run, and only for a folder under the temp folder.
// These call the resolver in a child that dot-sources the module, so nothing here reaches the network.
const layerSourcesFile = join(repoRoot, 'scripts', 'Install-LayerSources.ps1');
const SHORTHAND_URL = 'https://github.com/simpsonm09/pstack-claude.git';

function resolveShorthand(env) {
  const script = `. '${layerSourcesFile}'; Get-GitHubRemoteUrl -Owner 'simpsonm09' -Repo 'pstack-claude'`;
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env });
}

test('without the test-mode flag the owner/repo shorthand names github.com, even when the test root is set', { skip }, () => {
  const env = { ...process.env, MAXSTACK_TEST_GITHUB_ROOT: join(tmpdir(), 'maxstack-seam-probe') };
  delete env.MAXSTACK_TEST_MODE;
  const run = resolveShorthand(env);
  assertOk(run);
  assert.equal(run.stdout.trim(), SHORTHAND_URL, run.stdout);
}, {});

test('with the test-mode flag and a root under the temp folder, the shorthand names that folder and warns', { skip }, () => {
  const root = join(tmpdir(), 'maxstack-seam-probe');
  const run = resolveShorthand({ ...process.env, MAXSTACK_TEST_MODE: '1', MAXSTACK_TEST_GITHUB_ROOT: root });
  assertOk(run);
  assert.ok(run.stdout.split(/\r?\n/).includes(`${root.split('\\').join('/')}/simpsonm09/pstack-claude.git`), run.stdout);
  assert.match(plainOutput(run), /MAXSTACK_TEST_GITHUB_ROOT is set/, plainOutput(run));
}, {});

test('with the test-mode flag but a root outside the temp folder, the shorthand names github.com', { skip }, () => {
  const run = resolveShorthand({ ...process.env, MAXSTACK_TEST_MODE: '1', MAXSTACK_TEST_GITHUB_ROOT: repoRoot });
  assertOk(run);
  assert.equal(run.stdout.trim(), SHORTHAND_URL, run.stdout);
}, {});

withWorkspace('without the test-mode flag, a -Source owner/repo at a commit is audited against github.com', (ctx) => {
  const sha = 'a'.repeat(40);
  const env = { ...process.env, MAXSTACK_TEST_GITHUB_ROOT: join(ctx.base, 'github') };
  delete env.MAXSTACK_TEST_MODE;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', installer, '-Workspace', ctx.workspace, '-LayersFile', writeLayers(ctx),
    '-CopilotCommand', ctx.fakeCopilot, '-PiCommand', ctx.fakePi, '-Source', `pstack=simpsonm09/pstack-claude@${sha}`], { encoding: 'utf8', env });
  assertOk(run);
  assert.ok(run.stdout.includes(`override, git ${SHORTHAND_URL} ref ${sha} at ${sha}`), run.stdout);
  assert.ok(!run.stdout.includes(join(ctx.base, 'github')), 'the test root was used');
}, {});

// Finding 6: a recorded override is checked as a -Source spec is, and a bad value is refused by layer and field.
const BAD_RECORDS = [
  ['commit', (block) => { block.commit = 'zz'; }],
  ['ref', (block) => { block.ref = '--upload-pack=touch x'; }],
  ['ref', (block) => { block.ref = 'feat..x'; }],
  ['url', (block) => { block.url = 'ext::sh -c touch x'; }],
  ['url', (block) => { block.url = 'https://user@github.com/simpsonm09/pstack-claude.git'; }],
  ['url', (block) => { block.url = 'https://github.com/simpsonm09/pstack claude.git'; }],
  ['url', (block) => { block.url = 'https://github.com/../x'; }],
  ['url', (block) => { block.url = 'https://github.com/simpsonm09/pstack-claude.git\n'; }],
  ['commit', (block) => { block.commit = `${block.commit}\n`; }],
];

function sourceBlockIn(lock, name) {
  return lock.layers.find((layer) => layer.name === name).source;
}

// Round 2, B: an invalid recorded override is a warning for every mode that does not write its layer. A plain apply that
// would write the layer stops before any write, and names the one command that repairs it.
withWorkspace('a git override the lock holds with a bad url, ref, or commit is ignored with a warning, and a plain apply refuses it', (ctx) => {
  servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const good = readJson(lockPath(ctx));
  for (const [field, mutate] of BAD_RECORDS) {
    const lock = structuredClone(good);
    mutate(sourceBlockIn(lock, 'pstack'));
    setLock(ctx, lock);
    const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
    assertOk(status);
    assert.match(plainOutput(status), new RegExp(`layer 'pstack' has an invalid ${field}`), plainOutput(status));
    assert.match(status.stdout, /pstack: invalid recorded source, ignored for this run/, status.stdout);
  }
  const lock = structuredClone(good);
  sourceBlockIn(lock, 'pstack').url = 'ext::sh -c touch x';
  setLock(ctx, lock);
  const before = snapshotTree(ctx.workspace);
  const apply = runInstaller(shell, ctx, [], { env: githubEnv(ctx) });
  assert.notEqual(apply.status, 0, 'an apply wrote a layer whose recorded url is invalid');
  assert.match(plainOutput(apply), /layer 'pstack' has an invalid url/, plainOutput(apply));
  assert.match(plainOutput(apply), /-Source pstack=default -Apply/, plainOutput(apply));
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a refused lock changed the install');
}, {});

withWorkspace('a local override the lock holds with a relative path is ignored by -Status, and a plain apply refuses it', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'simpsonm09-org-ai-plugin').path = 'relative/checkout';
  setLock(ctx, lock);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /layer 'simpsonm09-org-ai-plugin' has an invalid path/, plainOutput(status));
  const apply = runInstaller(shell, ctx, []);
  assert.notEqual(apply.status, 0, 'an apply wrote a layer whose recorded path is relative');
  assert.match(plainOutput(apply), /-Source simpsonm09-org-ai-plugin=default -Apply/, plainOutput(apply));
}, {});

withWorkspace('an invalid recorded override is ignored by -Update, -Remove, and -Uninstall, and -Source name=default -Apply repairs it', (ctx) => {
  servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'pstack').url = 'ext::sh -c touch x';
  setLock(ctx, lock);
  for (const args of [['-Update', '-Check'], ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], ['-Uninstall']]) {
    const run = runInstaller(shell, ctx, args, { apply: false, env: githubEnv(ctx) });
    assertOk(run);
    assert.match(run.stdout, /pstack: invalid recorded source, ignored for this run/, `${args.join(' ')}: ${run.stdout}`);
  }
  mustApply(ctx, ['-Source', 'pstack=default']);
  assert.equal(sourceOf(ctx, 'pstack').source.override, false, 'the repair did not drop the invalid override');
}, {});

// Finding 7: git never waits on a credential prompt, and ls-remote gives up after its time limit with the reason.
function runAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // A run that never ends is killed, so a failing test cannot leave the process behind.
    const guard = setTimeout(() => child.kill(), 100000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(guard);
      resolve({ status, stdout, stderr });
    });
  });
}

test('the git guard sets the prompt variables, and turns on file transport only in a test run', { skip }, () => {
  const script = `. '${layerSourcesFile}'; $vars = Get-GitChildVariables -Settings (Get-GitGuardSettings); "PROMPT=$($vars.GIT_TERMINAL_PROMPT)"; "GCM=$($vars.GCM_INTERACTIVE)"; (Get-GitGuardSettings | ForEach-Object { "$($_.key)=$($_.value)" }) -join ' '`;
  const real = { ...process.env };
  delete real.MAXSTACK_TEST_MODE;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: real });
  assertOk(run);
  assert.match(run.stdout, /PROMPT=0/, run.stdout);
  assert.match(run.stdout, /GCM=never/, run.stdout);
  assert.match(run.stdout, /core\.fsmonitor=false/, run.stdout);
  assert.match(run.stdout, /protocol\.allow=never/, run.stdout);
  assert.doesNotMatch(run.stdout, /protocol\.file\.allow/, 'a real run allows file transport');

  const seam = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...real, MAXSTACK_TEST_MODE: '1' } });
  assert.match(seam.stdout, /protocol\.file\.allow=always/, seam.stdout);
}, {});

test('an ls-remote that passes its time limit is stopped, and the error says so', { skip, timeout: 120000 }, async () => {
  // The silent server takes each connection and never answers. The reset a stopped git causes is expected here.
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const script = `. '${layerSourcesFile}'; Find-GitRefCommit -Url 'https://127.0.0.1:${port}/simpsonm09/pstack-claude.git' -Ref 'main' -TimeoutSeconds 2`;
    const run = await runAsync(['-NoProfile', '-NonInteractive', '-Command', script], { ...process.env, GIT_TERMINAL_PROMPT: '0' });
    assert.notEqual(run.status, 0, 'a silent remote was waited for');
    assert.match(plainOutput(run), /ls-remote took longer than 2 seconds/, plainOutput(run));
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

// Finding 8: npm runs with --ignore-scripts, and a layer that declares install scripts or a binding.gyp is named when it runs.
// The stub org layer's node_modules is taken away, so npm runs for it, and its layer.json names the files the copy keeps.
function orgNeedingNpm(ctx, { packageJson, files, extra = {} }) {
  const org = join(ctx.workspace, ORG_SOURCE);
  rmSync(join(org, 'node_modules'), { recursive: true, force: true });
  writeFile(org, 'layer.json', JSON.stringify({ files }));
  writeFile(org, 'package.json', JSON.stringify(packageJson));
  for (const [rel, content] of Object.entries(extra)) writeFile(org, rel, content);
}

const ORG_FILES = ['index.ts', 'package.json', 'skills', '.claude-plugin'];

withWorkspace('an apply that runs npm names a layer that declares an install script, since its scripts do not run', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0', scripts: { postinstall: 'node build.js' } }, files: ORG_FILES });
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /npm ran with --ignore-scripts for layer 'simpsonm09-org-ai-plugin': its scripts\.postinstall did not run/, plainOutput(run));
  assert.doesNotMatch(plainOutput(run), /ignore-scripts for layer 'pstack'/, 'a layer with no install script is named');
}, NPM);

withWorkspace('an apply that runs npm names a layer that ships a binding.gyp, since its native build does not run', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0' }, files: [...ORG_FILES, 'binding.gyp'], extra: { 'binding.gyp': '{}\n' } });
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /npm ran with --ignore-scripts for layer 'simpsonm09-org-ai-plugin': its binding\.gyp did not run/, plainOutput(run));
}, NPM);

withWorkspace('an apply that runs npm on a layer with no install script or binding.gyp prints no ignore-scripts warning', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0' }, files: ORG_FILES });
  const run = mustApply(ctx);
  assert.doesNotMatch(plainOutput(run), /npm ran with --ignore-scripts/, plainOutput(run));
}, NPM);

// Finding 9: a local source is a checkout of its own only when git's top level is the folder; an ancestor of the workspace
// would contain it; a long-path prefix and a junction are followed before a path is compared; a comma and a C:\x@ref
// spec get a clear reason.
withWorkspace('a plain folder inside another git repository is not a checkout, so no commit of that repository is recorded', (ctx) => {
  const outer = join(ctx.base, 'outer');
  writeFile(outer, 'README.md', 'outer\n');
  gitRun(outer, ['init', '-q']);
  gitRun(outer, ['add', '-A']);
  gitRun(outer, ['commit', '-q', '-m', 'outer']);
  const plain = join(outer, 'plain');
  writeLayerStub(plain, { claudePlugin: 'simpsonm09-org-ai-plugin' });

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${plain}`], { apply: false });
  assertOk(audit);
  const text = sourceBlockOf(audit.stdout).lines.join('\n');
  assert.match(text, /simpsonm09-org-ai-plugin: override, local .*plain \(not a git checkout\)/, text);
  assert.doesNotMatch(text, /HEAD/, 'the enclosing repository was recorded');
}, {});

withWorkspace('a local source that contains the workspace is refused, since the layer would hold the installer that reads it', (ctx) => {
  const run = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${ctx.base}`], { apply: false });
  assert.notEqual(run.status, 0, 'an ancestor of the workspace was accepted');
  assert.match(plainOutput(run), /is an ancestor of the workspace/, run.stdout);
}, {});

withWorkspace('a local source reached through a junction, or named with a long-path prefix, is compared by the folder it names', (ctx) => {
  const toClaude = join(ctx.base, 'to-claude');
  mkdirSync(join(ctx.workspace, '.claude'), { recursive: true });
  symlinkSync(join(ctx.workspace, '.claude'), toClaude, 'junction');
  const viaJunction = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${toClaude}`], { apply: false });
  assert.notEqual(viaJunction.status, 0, 'a junction into .claude was accepted');
  assert.match(plainOutput(viaJunction), /is inside \.claude/, viaJunction.stdout);

  const prefixed = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:\\\\?\\${ctx.workspace}`], { apply: false });
  assert.notEqual(prefixed.status, 0, 'a long-path prefix hid the workspace');
  assert.match(plainOutput(prefixed), /is the workspace itself/, prefixed.stdout);
}, {});

withWorkspace('a comma inside a -Source path is refused with the reason, since a comma separates entries', (ctx) => {
  const folder = join(ctx.base, 'a');
  mkdirSync(folder);
  const run = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${folder},b`], { apply: false });
  assert.notEqual(run.status, 0, 'a path with a comma was accepted');
  assert.match(plainOutput(run), /comma separates -Source entries, so a path cannot hold one/i, run.stdout);
}, {});

withWorkspace('a -Source spec that is a folder with an @ref says to use local:', (ctx) => {
  const run = runInstaller(shell, ctx, ['-Source', 'pstack=C:\\x@main'], { apply: false });
  assert.notEqual(run.status, 0, 'a folder with an @ref was accepted as a git source');
  assert.ok(plainOutput(run).includes('did you mean local:C:\\x?'), run.stdout);
}, {});

// Round 2, A: a recorded local override on a drive that is gone is reported as a missing folder, not a raw drive error.
function absentDriveLetter() {
  for (const letter of 'QRSTUVWXYZ') {
    if (!existsSync(`${letter}:/`)) return letter;
  }
  return null;
}

withWorkspace('a recorded override on a drive that is gone is reported as a missing folder, and -Status, -Update, -Remove, -Uninstall run', (ctx) => {
  const gone = absentDriveLetter();
  if (!gone) return;
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'simpsonm09-org-ai-plugin').path = `${gone}:/repo/org`;
  setLock(ctx, lock);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.ok(status.stdout.split('\\').join('/').includes(`${gone}:/repo/org: folder missing`), status.stdout);
  assertOk(runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false }));
  assertOk(runInstaller(shell, ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], { apply: false }));
  assertOk(runInstaller(shell, ctx, ['-Uninstall'], { apply: false }));

  const explicit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${gone}:/nope`], { apply: false });
  assert.notEqual(explicit.status, 0, 'an explicit source on an absent drive was accepted');
  assert.match(plainOutput(explicit), /folder does not exist/, explicit.stdout);
}, {});

// Round 2, C: a drive root or a share root is refused as a local source, and its path is kept whole, never cut to "Y:".
test('the folder helper keeps a drive root whole, with its backslash', { skip }, () => {
  const driveRoot = parsePath(tmpdir()).root;
  const script = `. '${layerSourcesFile}'; Get-FullFolderPath '${driveRoot.split('\\').join('/')}'`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assertOk(run);
  assert.equal(run.stdout.trim(), driveRoot, run.stdout);
}, {});

withWorkspace('a drive root or a share root is refused as a local source, with the reason', (ctx) => {
  const driveRoot = parsePath(tmpdir()).root;
  const drive = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${driveRoot}`], { apply: false });
  assert.notEqual(drive.status, 0, 'a drive root was accepted as a layer source');
  assert.match(plainOutput(drive), /is a drive or share root, which cannot be a layer source/, drive.stdout);

  const share = runInstaller(shell, ctx, ['-Source', 'simpsonm09-org-ai-plugin=local://server/share'], { apply: false });
  assert.notEqual(share.status, 0, 'a share root was accepted as a layer source');
  assert.match(plainOutput(share), /is a drive or share root, which cannot be a layer source/, share.stdout);
}, {});

// Round 2, D: a clean filter that .git/config names is a program too. An audit of a local tree must run none of it.
withWorkspace('an audit of a -Source local tree runs no clean filter that its .git/config names', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'filter-marker');
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  gitRun(checkout, ['config', 'filter.mark.clean', `sh -c "touch '${marker.split('\\').join('/')}'; cat"`]);
  writeFile(checkout, 'notes.txt', 'two\n');

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean filter that .git/config names');
}, {});

// Round 2, E: the installer needs PowerShell 7. Windows PowerShell 5.1 must stop with that requirement, not a parse error.
const windowsPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;
test('the installer under Windows PowerShell 5.1 stops with the PowerShell 7 requirement, not a parse error', { skip: windowsPowerShell ? false : 'powershell.exe is not available' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-requires-'));
  try {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', installer, '-Workspace', join(base, 'missing')], { encoding: 'utf8' });
    const text = plainOutput(run);
    assert.notEqual(run.status, 0, text);
    assert.match(text, /#requires.*7\.0/i, text);
    assert.doesNotMatch(text, /ParserError|Unexpected token|Array index expression/, text);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Round 2, G: a junction under the temp folder that leads outside it does not turn on the test root.
test('a junction under the temp folder that leads outside it does not turn on the test root', { skip }, () => {
  const junction = join(tmpdir(), `maxstack-jct-${process.pid}`);
  symlinkSync(repoRoot, junction, 'junction');
  try {
    const run = resolveShorthand({ ...process.env, MAXSTACK_TEST_MODE: '1', MAXSTACK_TEST_GITHUB_ROOT: junction });
    assertOk(run);
    assert.equal(run.stdout.trim(), SHORTHAND_URL, run.stdout);
  } finally {
    rmdirSync(junction);
  }
}, {});

// Round 2, H: the refusal for a missing layer folder names the absolute folder, and the command that fits the mode.
const ORG_DEFAULT_FOLDER = (ctx) => join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin');

withWorkspace('a missing default layer folder is refused with its absolute path and no -Source advice', (ctx) => {
  rmSync(ORG_DEFAULT_FOLDER(ctx), { recursive: true, force: true });
  const apply = runInstaller(shell, ctx, []);
  assert.notEqual(apply.status, 0, 'an apply wrote past a missing default folder');
  assert.ok(plainOutput(apply).includes(`has no folder at ${ORG_DEFAULT_FOLDER(ctx)}. Restore the folder, then rerun`), plainOutput(apply));
  assert.doesNotMatch(plainOutput(apply), /-Source|drop the override/, plainOutput(apply));
}, {});

withWorkspace('a missing override folder is refused with its absolute path and the -Source repair that applies', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  rmSync(checkout, { recursive: true, force: true });
  const apply = runInstaller(shell, ctx, []);
  assert.notEqual(apply.status, 0, 'an apply wrote past a missing override folder');
  assert.ok(plainOutput(apply).includes(`has no folder at ${checkout}. Restore the folder or drop the override with -Source simpsonm09-org-ai-plugin=default -Apply, then rerun`), plainOutput(apply));
}, {});

withWorkspace('a removal refused for a missing layer folder gives no -Source advice, since -Remove takes no -Source', (ctx) => {
  mustApply(ctx);
  rmSync(ORG_DEFAULT_FOLDER(ctx), { recursive: true, force: true });
  const removed = removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']);
  assert.notEqual(removed.status, 0, 'a removal rewrote the config without a missing fragment');
  assert.match(plainOutput(removed), /has no folder at .*Restore the folder, then rerun/, plainOutput(removed));
  assert.doesNotMatch(plainOutput(removed), /-Source/, plainOutput(removed));
}, {});

// Round 2, I: after npm runs, the installed dependencies that declare install scripts are counted and named, up to ten.
withWorkspace('an apply that runs npm counts the installed packages that declare install scripts, and names up to ten', (ctx) => {
  const names = Array.from({ length: 12 }, (_, index) => `dep-${String(index).padStart(2, '0')}`);
  names.push('@acme/native');
  const run = mustApply(ctx, [], { env: { ...ctx.env, FAKE_NPM_SCRIPTED: JSON.stringify(names) } });
  assert.match(plainOutput(run), /npm ran with --ignore-scripts for layer 'pstack': 13 installed packages declare install scripts or a native build, which did not run: @acme\/native, dep-00.*and 3 more/, plainOutput(run));
}, NPM);

// Round 2, J: a pipe that a stopped git's child still holds open is not waited on past the bound.
test('a git output read that never completes returns within its bound, with no output', { skip, timeout: 60000 }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $task = [System.Threading.Tasks.TaskCompletionSource[string]]::new().Task; $text = Read-GitPipeBounded -Task $task -Milliseconds 1000; "READ=[$text]"`;
  const started = Date.now();
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 50000 });
  assertOk(run);
  assert.ok(Date.now() - started < 40000, 'the read was not bounded');
  assert.ok(run.stdout.includes('READ=[]'), run.stdout);
}, {});

// ---- Round 3: the filter guard. A clean command that the tree's config defines writes a marker file when it runs.
// The fixture runs the command unguarded first, so a marker that is missing after an audit is a result, not a fixture gap.
const touchAndCat = (marker) => `sh -c "touch '${marker.replace(/\\/g, '/')}'; cat"`;

// Finding 1: the name comes from the config key. A clean command whose path has a dot ended the line the old parser read.
withWorkspace('an audit of a -Source local tree runs no clean filter whose command has a dot in it', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'dotted-marker.txt');
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  gitRun(checkout, ['config', 'filter.mark.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  gitRun(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean command that .git/config names');
}, {});

// Finding 2: the guard passes its settings in the child's environment, so a name is never split at "=", and a name the
// guard cannot pass makes the tree unreadable, with no filter run. The checkout's clean command writes the marker.
withWorkspace('an audit of a -Source local tree runs no clean filter whose name holds an equals sign', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'equals-marker.txt');
  writeFile(checkout, '.gitattributes', '*.txt filter=a=b\n');
  gitRun(checkout, ['config', 'filter.a=b.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  gitRun(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command whose filter name holds an equals sign');
}, {});

withWorkspace('a filter name with a control character makes its tree unreadable, and no filter in it runs', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'control-marker.txt');
  writeFile(checkout, '.gitattributes', '*.txt filter=a\x01b\n');
  gitRun(checkout, ['config', 'filter.a\x01b.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  gitRun(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const status = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /simpsonm09-org-ai-plugin: override, local .*unreadable: .*control character/, plainOutput(status));
  assert.equal(existsSync(marker), false, 'a tree with an unpassable filter name was read');
}, {});

withWorkspace('the guard passes its filter settings to git in the child process, and leaves the installer environment as it was', (ctx) => {
  const tree = join(ctx.base, 'tree');
  mkdirSync(tree);
  gitRun(tree, ['init', '-q']);
  gitRun(tree, ['config', 'filter.a=b.clean', 'touch x']);
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $tree = '${tree.replace(/\\/g, '/')}'; $run = Invoke-GitGuarded -Dir $tree -Arguments @('-C', $tree, 'status', '--porcelain'); "CODE=$($run.code)"; "LEFT=[$env:GIT_CONFIG_COUNT]"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /CODE=0/, run.stdout);
  assert.match(run.stdout, /LEFT=\[\]/, 'the guard left its settings in the installer environment');
}, {});

// Finding 3: a tree that names more than 100 filter drivers is unreadable, and every run reports it. Nothing throws.
function manyFilters(count) {
  return Array.from({ length: count }, (_, index) => `[filter "f${index}"]\n\tclean = false\n`).join('');
}

withWorkspace('a tree that names more than 100 filter drivers is reported as unreadable by -Status, -Update, and an audit', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  appendFileSync(join(checkout, '.git', 'config'), manyFilters(400));

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /simpsonm09-org-ai-plugin: override, local .*unreadable: too many filter drivers/, plainOutput(status));
  assertOk(runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false }));
  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /unreadable: too many filter drivers/, plainOutput(audit));
}, {});

withWorkspace('a tree that names exactly 100 filter drivers is still read', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  appendFileSync(join(checkout, '.git', 'config'), manyFilters(100));
  // The user's global config may name filters of its own, such as git-lfs, so the count is taken with an empty global file.
  const emptyGlobal = join(ctx.base, 'empty-gitconfig');
  writeFileSync(emptyGlobal, '');

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: '1' } });
  assertOk(audit);
  assert.doesNotMatch(plainOutput(audit), /unreadable/, plainOutput(audit));
  assert.match(plainOutput(audit), /simpsonm09-org-ai-plugin: override, local .*HEAD [0-9a-f]{40}, clean\)/, plainOutput(audit));
}, {});

// Finding 3: a git failure inside the checkout probe is reported as an unreadable layer. Set-LayerChoice must not throw,
// since a throw there would stop -Status, -Update, and -Remove.
test('a checkout probe that throws is reported as unreadable, and Set-LayerChoice does not throw', { skip }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; function Invoke-GitGuarded { throw 'simulated git failure' }; $state = Get-LocalCheckoutState -Root $env:TEMP; "STATE=[$($state.unreadable)]"; $layer = @{ name = 'x'; sourcePath = '.'; root = $null; override = $false }; $choice = [pscustomobject]@{ kind = 'local'; url = $null; ref = $null; commit = $null; path = $env:TEMP; checkout = $env:TEMP; override = $true }; Set-LayerChoice -Layer $layer -Choice $choice; "LAYER=[$($layer.unreadable)]"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /STATE=\[the checkout could not be read: simulated git failure\]/, run.stdout);
  assert.match(run.stdout, /LAYER=\[the checkout could not be read: simulated git failure\]/, run.stdout);
}, {});

// Finding 4: the guard turns off only the filters the tree itself defines: its own config, what its includes add, its per-worktree
// config, and the names its attributes files use. The user's global and system filters run, as they do in any checkout.
function runGit(dir, args, env = process.env) {
  const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8', env });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

// The environment with a global config file that holds one setting. The file is outside the checkout and the test system config is off.
function globalGitEnv(ctx, key, value) {
  const file = join(ctx.base, 'global-gitconfig');
  runGit(ctx.base, ['config', '-f', file, key, value]);
  return { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

// A local checkout with one committed file, and a .gitattributes that names the mark filter on text files.
function markedCheckoutWithCommit(ctx) {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  runGit(checkout, ['init', '-q']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  return checkout;
}

withWorkspace('a checkout runs the smudge filter that the user global config defines, since the guard turns off only the tree filters', (ctx) => {
  const source = join(ctx.base, 'source');
  writeFile(source, '.gitattributes', '*.txt filter=up\n');
  writeFile(source, 'a.txt', 'hello\n');
  runGit(source, ['init', '-q']);
  runGit(source, ['add', '-A']);
  runGit(source, ['commit', '-q', '-m', 'source']);
  const env = globalGitEnv(ctx, 'filter.up.smudge', 'tr a-z A-Z');
  const target = join(ctx.base, 'target');
  runGit(ctx.base, ['clone', '-q', '--no-checkout', source, target], env);

  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $target = '${target.replace(/\\/g, '/')}'; $run = Invoke-GitGuarded -Dir $target -Arguments @('-C', $target, 'checkout', '--quiet', '-f', 'HEAD'); "CODE=$($run.code)"`;
  const guarded = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: testEnvironment(env) });
  assertOk(guarded);
  assert.match(guarded.stdout, /CODE=0/, guarded.stdout);
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'HELLO\n', 'the guarded checkout did not run the global smudge filter');
}, {});

withWorkspace('an audit turns off a filter that the tree reaches through an include in its own config', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'include-marker.txt');
  const included = join(ctx.base, 'included.cfg');
  runGit(ctx.base, ['config', '-f', included, 'filter.mark.clean', touchAndCat(marker)]);
  runGit(checkout, ['config', 'include.path', included.replace(/\\/g, '/')]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the included clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command that an include in the tree config defines');
}, {});

withWorkspace('an audit turns off a filter that the tree defines in its per-worktree config', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'worktree-marker.txt');
  runGit(checkout, ['config', 'extensions.worktreeConfig', 'true']);
  runGit(checkout, ['config', '--worktree', 'filter.mark.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the per-worktree clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command from the per-worktree config');
}, {});

withWorkspace('an audit turns off the filter that .git/info/attributes names when the tree config defines it', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.git/info/attributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'info-marker.txt');
  runGit(checkout, ['config', 'filter.mark.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command named by .git/info/attributes');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command named by .git/info/attributes');
}, {});

withWorkspace('an audit runs no global filter that only the tree attributes name, since the tree defines none', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'global-marker.txt');
  const env = globalGitEnv(ctx, 'filter.mark.clean', touchAndCat(marker));
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt'], env);
  assert.equal(existsSync(marker), true, 'the fixture did not run the global clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a global clean command that only the in-tree attributes name');
}, {});

// Finding 5: the scan of the packages npm installed is a warning only. A folder it cannot read must not stop an apply after the
// plugin folder is replaced and before the lock is written.
withWorkspace('an apply whose npm scan cannot read a scoped folder still writes its lock, with no ignore-scripts warning', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0' }, files: ORG_FILES });
  const run = mustApply(ctx, [], { env: { ...ctx.env, FAKE_NPM_BROKEN_SCOPE: '1' } });
  assert.doesNotMatch(plainOutput(run), /ignore-scripts/, plainOutput(run));
  assert.ok(existsSync(lockPath(ctx)), 'the apply stopped before the lock was written');
}, NPM);
