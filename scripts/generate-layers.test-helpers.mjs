import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cli = join(repoRoot, 'scripts', 'generate-layers.mjs');
export const libPath = join(repoRoot, 'scripts', 'lib', 'generate.mjs');

// Every fixture lives under the system temp directory, and the cleanup target is re-checked.
export function withTemp(run) {
  const tempRoot = resolve(tmpdir());
  const root = mkdtempSync(join(tempRoot, 'maxstack-generator-test-'));
  try {
    run(root);
  } finally {
    const rel = relative(tempRoot, root);
    assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== '..', 'cleanup target stays inside the temp root');
    assert.ok(lstatSync(root).isDirectory(), 'cleanup target is the created directory');
    rmSync(root, { recursive: true, force: true });
  }
}

export function write(root, path, bytes) {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

export function skillText(name = 'sample', description = 'A sample skill') {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody stays exactly as authored.\n`;
}

// options.skills maps folder name to SKILL.md text. options.fragment is an OpenCode fragment
// object or raw text. options.plugin overrides the plugin.json name, and null omits the manifest.
export function makeLayer(root, name, options = {}) {
  const layer = join(root, name);
  const skills = options.skills ?? { sample: skillText('sample') };
  if (options.plugin !== null) write(layer, '.claude-plugin/plugin.json', JSON.stringify({ name: options.plugin ?? name, version: '0.1.0' }));
  for (const [skill, text] of Object.entries(skills)) write(layer, `skills/${skill}/SKILL.md`, text);
  for (const [path, bytes] of Object.entries(options.files ?? {})) write(layer, path, bytes);
  if (options.fragment !== undefined) {
    write(layer, 'opencode.fragment.jsonc', typeof options.fragment === 'string' ? options.fragment : JSON.stringify(options.fragment));
  }
  return layer;
}

export function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { windowsHide: true, encoding: 'utf8' });
}

export function runGenerator(runtime, layers, out, extra = []) {
  const layerArgs = layers.flatMap((layer) => ['--layers', layer]);
  return runCli(['--runtime', runtime, '--out', out, ...layerArgs, ...extra]);
}

export function outputText(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function succeeds(result, label = 'generator') {
  assert.equal(result.error, undefined, `${label} spawn error: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label} exited ${result.status}\n${outputText(result)}`);
}

export function rejects(result, diagnostic, label = 'generator') {
  assert.equal(result.error, undefined, `${label} spawn error: ${result.error?.message}`);
  assert.equal(result.status, 1, `${label} exit status\n${outputText(result)}`);
  assert.match(outputText(result), diagnostic, `${label} diagnostic`);
}

// Every file under root as a map of relative path to bytes. Empty directories are not files.
export function treeBytes(root) {
  const files = new Map();
  if (!existsSync(root)) return files;
  const pending = [''];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = [dir, entry.name].filter(Boolean).join('/');
      if (entry.isDirectory()) pending.push(path);
      else files.set(path, readFileSync(join(root, ...path.split('/'))));
    }
  }
  return files;
}

export function ownership(out) {
  return JSON.parse(readFileSync(join(out, 'generator.owned.json'), 'utf8'));
}

export function saveOwnership(out, document) {
  writeFileSync(join(out, 'generator.owned.json'), JSON.stringify(document));
}
