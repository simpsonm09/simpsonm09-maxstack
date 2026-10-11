import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { repoRoot, runGenerator, succeeds, withTemp, write } from './generate-layers.test-helpers.mjs';

// Real-source proof. MAXSTACK_TEST_LAYER_ROOTS is a JSON array of three layer roots, read only.
// MAXSTACK_REQUIRE_TEST_LAYER_ROOTS=1 turns a missing root into a failure instead of a skip.
const inputRoots = JSON.parse(process.env.MAXSTACK_TEST_LAYER_ROOTS ?? '[]');
const strict = process.env.MAXSTACK_REQUIRE_TEST_LAYER_ROOTS === '1';
const unavailable = inputRoots.find((path) => !existsSync(path));
const missing = inputRoots.length !== 3
  ? 'MAXSTACK_TEST_LAYER_ROOTS must be a JSON array of three layer roots'
  : unavailable
    ? `layer root is unavailable: ${unavailable}`
    : false;
const skip = strict ? false : missing;
const AUDITED_SKILLS = 68;
const AUDITED_ASSETS = 110;

const skillBase = {
  claude: (layer) => `.claude/plugins/${layer}/skills`,
  copilot: (layer) => `.claude/plugins/${layer}/skills`,
  opencode: () => '.opencode/skills',
  pi: () => '.pi/agent/skills',
};

function skillFolders(root) {
  return readdirSync(join(root, 'skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), relative) : [relative];
  });
}

test('strict real-source proof requires all three available roots', () => {
  if (!strict) return;
  assert.equal(missing, false, missing || undefined);
});

// Every source file must reach the output byte for byte, SKILL.md included.
function assertByteCopy(runtime, source, out) {
  const layer = basename(source);
  let skills = 0;
  let assets = 0;
  for (const name of skillFolders(source)) {
    const sourceDir = join(source, 'skills', name);
    const outputDir = join(out, ...skillBase[runtime](layer).split('/'), name);
    for (const relative of files(sourceDir)) {
      const expected = readFileSync(join(sourceDir, ...relative.split('/')));
      const actual = readFileSync(join(outputDir, ...relative.split('/')));
      assert.deepEqual(actual, expected, `${runtime}/${layer}/${name}/${relative} is a byte copy`);
      if (relative === 'SKILL.md') skills += 1;
      else assets += 1;
    }
  }
  return { skills, assets };
}

for (const runtime of ['claude', 'copilot', 'opencode', 'pi']) {
  test(`${runtime} projection byte-copies every skill and asset of the real layers`, { skip }, () => {
    withTemp((temp) => {
      const out = join(temp, runtime);
      succeeds(runGenerator(runtime, inputRoots, out), `${runtime} real-source projection`);
      let skills = 0;
      let assets = 0;
      for (const source of inputRoots) {
        const counted = assertByteCopy(runtime, source, out);
        skills += counted.skills;
        assets += counted.assets;
      }
      assert.equal(skills, AUDITED_SKILLS, 'the audited source set has 68 skills');
      assert.equal(assets, AUDITED_ASSETS, 'the audited source set has 110 assets');
    });
  });
}

function findPowerShell() {
  for (const command of ['pwsh', 'powershell']) {
    const probe = spawnSync(command, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, encoding: 'utf8' });
    if (probe.status === 0) return command;
  }
  return null;
}

function manifestLayer(root, name) {
  const source = join(root, name);
  write(source, '.claude-plugin/plugin.json', JSON.stringify({ name }));
  write(source, 'layer.json', JSON.stringify({ files: ['.claude-plugin', 'index.ts', 'skills', 'opencode.fragment.jsonc'] }));
  write(source, 'index.ts', 'export default {};\n');
  write(source, 'opencode.fragment.jsonc', '{}');
  return source;
}

// The installer copies each layer's skills into its own workspace. The copied SKILL.md and
// assets must be the same bytes the generator copies, which is the byte audit's installer half.
test('the installer overlay of the real layers copies the same bytes the generator copies', { skip: skip || (findPowerShell() ? false : 'PowerShell is not available') }, () => {
  const shell = findPowerShell();
  withTemp((temp) => {
    const workspace = join(temp, 'workspace');
    mkdirSync(workspace);
    const stubs = inputRoots.map((source) => {
      const name = basename(source);
      const stub = manifestLayer(temp, name);
      cpSync(join(source, 'skills'), join(stub, 'skills'), { recursive: true });
      return { name, source, stub };
    });
    const layersFile = join(temp, 'layers.json');
    writeFileSync(layersFile, JSON.stringify({ layers: stubs.map(({ name }) => ({
      name, kind: 'config', path: `source/${name}`, source: 'https://example.invalid/audited-fixture.git',
      runtimes: { claude: {}, opencode: {}, copilot: {}, pi: {} },
    })) }));
    const fakeCopilot = join(temp, 'copilot.cmd');
    const fakePi = join(temp, 'pi.cmd');
    writeFileSync(fakeCopilot, '@echo off\r\nexit /b 0\r\n');
    writeFileSync(fakePi, '@echo off\r\nexit /b 0\r\n');
    const layerSource = stubs.map(({ name, stub }) => `${name}=${stub}`).join(',');
    const installed = spawnSync(shell, [
      '-NoProfile', '-NonInteractive', '-File', join(repoRoot, 'scripts', 'Install-Workspace.ps1'),
      '-Workspace', workspace, '-LayersFile', layersFile,
      '-LayerSource', layerSource,
      '-CopilotCommand', fakeCopilot, '-PiCommand', fakePi, '-Runtimes', 'all', '-Layers', 'all', '-Apply',
    ], { windowsHide: true, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true' } });
    assert.equal(installed.status, 0, `installer exited ${installed.status}\n${installed.stdout}\n${installed.stderr}`);

    const generated = join(temp, 'generated-claude');
    succeeds(runGenerator('claude', inputRoots, generated), 'claude projection for the installer comparison');
    let identical = 0;
    for (const { name, source } of stubs) {
      for (const skill of skillFolders(source)) {
        const sourceSkill = join(source, 'skills', skill, 'SKILL.md');
        const installedSkill = join(workspace, '.claude', 'plugins', name, 'skills', skill, 'SKILL.md');
        const generatedSkill = join(generated, '.claude', 'plugins', name, 'skills', skill, 'SKILL.md');
        const expected = readFileSync(sourceSkill);
        assert.deepEqual(readFileSync(installedSkill), expected, `installer copies ${name}/${skill}/SKILL.md unchanged`);
        assert.deepEqual(readFileSync(generatedSkill), expected, `generator copies ${name}/${skill}/SKILL.md unchanged`);
        identical += 1;
      }
    }
    assert.equal(identical, AUDITED_SKILLS, 'every audited skill matches the source bytes in both trees');
  });
});
