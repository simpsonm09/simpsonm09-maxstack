#!/usr/bin/env node
// Checks Codex's local project-root marker behavior in an isolated fixture. It never makes a model request.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCommand } from './codex-hook-status.mjs';

const SENTINEL = 'MARKER_AGENTS_SENTINEL=fixture-only-7c2a';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MARKER_OVERRIDE = 'project_root_markers=["stack.lock.json"]';
const DIAGNOSTICS = new Set([
  'none', 'missing-cli', 'unsupported-shim', 'timeout', 'output-too-large',
  'launch-error', 'version-check-failed', 'invalid-version', 'marker-mismatch',
]);

export function summarizePromptInput(value) {
  const strings = [];
  const walk = (node) => {
    if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  return { agentsSentinelPresent: strings.join('\n').includes(SENTINEL) };
}

function within(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== '' && pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveResult) => {
    let child;
    let stdout = '';
    let stderr = '';
    let outputTooLarge = false;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ ...result, stdout, stderr, timedOut, outputTooLarge });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
    }, timeoutMs);
    try {
      const isTestScript = /\.(mjs|js)$/i.test(command);
      child = spawn(isTestScript ? process.execPath : command, isTestScript ? [command, ...args] : args, {
        cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = (target, chunk) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > MAX_OUTPUT_BYTES) {
          outputTooLarge = true;
          child.kill();
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk) => collect('stdout', chunk));
      child.stderr.on('data', (chunk) => collect('stderr', chunk));
      child.once('error', (error) => finish({ exitCode: null, error }));
      child.once('close', (exitCode, signal) => finish({ exitCode, signal, error: null }));
    } catch (error) {
      finish({ exitCode: null, error });
    }
  });
}

function errorCategory(run) {
  if (run.timedOut) return 'timeout';
  if (run.outputTooLarge) return 'output-too-large';
  if (run.error?.code === 'ENOENT') return 'missing-cli';
  if (run.error) return 'launch-error';
  if (run.stderr.trim()) return 'stderr';
  return 'none';
}

function versionDiagnostic(run) {
  if (run.timedOut) return 'timeout';
  if (run.outputTooLarge) return 'output-too-large';
  if (run.error?.code === 'ENOENT') return 'missing-cli';
  if (run.error) return 'launch-error';
  if (run.exitCode !== 0) return 'version-check-failed';
  return 'invalid-version';
}

function isolatedEnvironment(fixture, codexHome) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const privateHome = join(fixture, 'user-home');
  const appData = join(fixture, 'app-data');
  const localAppData = join(fixture, 'local-app-data');
  for (const directory of [privateHome, appData, localAppData, join(fixture, 'temp')]) mkdirSync(directory, { recursive: true });
  env.HOME = privateHome;
  env.USERPROFILE = privateHome;
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.TEMP = join(fixture, 'temp');
  env.TMP = env.TEMP;
  env.CODEX_HOME = codexHome;
  return env;
}

function makeFixture(root, name) {
  const fixture = join(root, name);
  const nested = join(fixture, 'workspace', 'nested-repo');
  const home = join(fixture, 'codex-home');
  mkdirSync(join(nested, '.git'), { recursive: true });
  mkdirSync(join(nested, '.git', 'objects', 'info'), { recursive: true });
  mkdirSync(join(nested, '.git', 'objects', 'pack'), { recursive: true });
  mkdirSync(join(nested, '.git', 'refs', 'heads'), { recursive: true });
  mkdirSync(join(nested, '.git', 'refs', 'tags'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  writeFileSync(join(nested, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n', 'utf8');
  writeFileSync(join(fixture, 'workspace', 'stack.lock.json'), '{}\n', 'utf8');
  writeFileSync(join(fixture, 'workspace', 'AGENTS.md'), `${SENTINEL}\n`, 'utf8');
  return { fixture, nested, home };
}

async function runCase(command, root, name, args, timeoutMs) {
  const fixture = makeFixture(root, name);
  const run = await runProcess(command, args, {
    cwd: fixture.nested,
    env: isolatedEnvironment(fixture.fixture, fixture.home),
    timeoutMs,
  });
  let summary = null;
  let outputCategory = 'not-parsed';
  if (!run.error && !run.timedOut && !run.outputTooLarge && run.exitCode === 0) {
    try {
      summary = summarizePromptInput(JSON.parse(run.stdout));
      outputCategory = 'json';
    } catch {
      outputCategory = 'invalid-json';
    }
  }
  return {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    errorCategory: errorCategory(run),
    outputCategory,
    summary,
  };
}

function resolveCodex(command) {
  try {
    const resolved = resolveCommand(command);
    if (/\.(cmd|bat)$/i.test(resolved)) {
      return { command: null, diagnostic: 'unsupported-shim' };
    }
    return { command: resolved, error: null };
  } catch (error) {
    return { command: null, diagnostic: /shim/i.test(error?.message ?? '') ? 'unsupported-shim' : 'missing-cli' };
  }
}

async function checkResolvedCodex(command, root, timeoutMs) {
  const fixture = makeFixture(root, 'version');
  const run = await runProcess(command, ['--version'], {
    cwd: fixture.nested,
    env: isolatedEnvironment(fixture.fixture, fixture.home),
    timeoutMs: Math.min(timeoutMs, 10000),
  });
  const versionText = !run.error && !run.timedOut && run.exitCode === 0 ? run.stdout.trim() : '';
  const versionMatch = versionText.match(/^codex(?:-cli)?\s+(v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]+)?)$/i);
  const cliVersion = versionMatch ? `codex-cli ${versionMatch[1]}` : null;
  if (!cliVersion) return unsupported(versionDiagnostic(run));

  const defaultCase = await runCase(command, root, 'default', ['debug', 'prompt-input'], timeoutMs);
  const markerCase = await runCase(command, root, 'explicit-marker', ['-c', MARKER_OVERRIDE, 'debug', 'prompt-input'], timeoutMs);
  const defaultAbsent = defaultCase.summary?.agentsSentinelPresent === false;
  const markerPresent = markerCase.summary?.agentsSentinelPresent === true;
  const pass = Boolean(defaultAbsent && markerPresent);
  return {
    status: pass ? 'pass' : 'fail',
    pass,
    cliVersion,
    proof: { defaultSentinelAbsent: Boolean(defaultAbsent), explicitMarkerSentinelPresent: Boolean(markerPresent) },
    diagnostic: pass ? 'none' : 'marker-mismatch',
  };
}

function cleanupFixture(base, root) {
  const absoluteRoot = resolve(root);
  if (absoluteRoot !== root || !within(base, absoluteRoot)) {
    process.stderr.write('warning: cleanup refused (unsafe-root)\n');
    return;
  }
  try {
    rmSync(absoluteRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  } catch {
    process.stderr.write('warning: cleanup failed\n');
  }
}

export async function runDiscoveryCheck({ codex = 'codex', timeoutMs = DEFAULT_TIMEOUT_MS, tempRoot = tmpdir() } = {}) {
  const base = resolve(tempRoot);
  const root = mkdtempSync(join(base, 'maxstack-codex-discovery-'));
  if (!isAbsolute(root) || !within(base, root)) throw new Error('temporary fixture path failed its absolute-root check');
  try {
    const resolved = resolveCodex(codex);
    return resolved.diagnostic ? unsupported(resolved.diagnostic) : await checkResolvedCodex(resolved.command, root, timeoutMs);
  } finally {
    cleanupFixture(base, root);
  }
}

function unsupported(diagnostic) {
  return {
    status: 'unsupported',
    pass: false,
    cliVersion: null,
    proof: { defaultSentinelAbsent: false, explicitMarkerSentinelPresent: false },
    diagnostic: DIAGNOSTICS.has(diagnostic) ? diagnostic : 'launch-error',
  };
}

export function parseArgs(argv) {
  const options = { codex: null, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--codex') options.codex = argv[++index];
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else throw new Error('invalid arguments');
  }
  if (!options.codex) throw new Error('--codex is required; choose the installed Codex CLI to check');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120000) {
    throw new Error('--timeout-ms must be between 100 and 120000');
  }
  return options;
}

async function main(argv) {
  const result = await runDiscoveryCheck(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.pass ? 0 : result.status === 'unsupported' ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write('invalid arguments or local fixture error\n');
      process.exitCode = 2;
    },
  );
}
