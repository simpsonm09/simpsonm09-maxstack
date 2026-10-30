#!/usr/bin/env node
// Reads a Codex hook's current hash with a temporary CODEX_HOME. The CLI override contains only the requested
// hook definition, so this works before the project config exists and never reads the real user config.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INITIALIZE_ID = 1;
const HOOKS_LIST_ID = 2;
const DEFAULT_WAIT_MS = 15000;
const MARKER = 'project_root_markers=["stack.lock.json"]';

function toForwardSlashes(value) {
  return value.replaceAll('\\', '/');
}

// An npm install on Windows puts a .cmd shim on PATH. Starting it needs the command shell, which rewrites
// quotes in the -c values, so start the native codex.exe the shim wraps instead.
function nativeFromShim(shim) {
  const vendor = join(dirname(shim), 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  if (!existsSync(vendor)) return null;
  for (const platform of readdirSync(vendor).filter((name) => name.startsWith('codex-win32-'))) {
    const vendorRoot = join(vendor, platform, 'vendor');
    if (!existsSync(vendorRoot)) continue;
    for (const target of readdirSync(vendorRoot)) {
      const exe = join(vendorRoot, target, 'bin', 'codex.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

export function resolveCommand(command, pathValue = process.env.PATH ?? '') {
  if (process.platform !== 'win32') return command;
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [command]
    : pathValue.split(delimiter).filter(Boolean).flatMap((directory) =>
      ['.exe', '.cmd', '.bat', ''].map((extension) => join(directory, command + extension)));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (!/\.(cmd|bat)$/i.test(candidate)) return candidate;
    const native = nativeFromShim(candidate);
    if (native) return native;
    throw new Error(`${candidate} is a shim that needs the command shell; pass the native codex.exe instead`);
  }
  return command;
}

// MAXSTACK_CODEX_COMMAND names the codex to run instead of the one on PATH. A .mjs or .js file runs under this node,
// which is how the tests supply a stand-in without a shell shim.
function startAppServer(command, args, options) {
  const chosen = process.env.MAXSTACK_CODEX_COMMAND || command;
  if (/\.(mjs|js)$/i.test(chosen)) return spawn(process.execPath, [chosen, ...args], { ...options, windowsHide: true });
  return spawn(resolveCommand(chosen), args, { ...options, windowsHide: true });
}

function parseMessage(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function takeLines(state, chunk, onLine) {
  state.buffer += chunk.toString();
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  }
}

function writeListRequest(child, workspace) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: HOOKS_LIST_ID, method: 'hooks/list', params: { cwds: [toForwardSlashes(workspace)] } })}\n`);
}

async function queryHooks({ command, workspace, home, waitMs, definition }) {
  const args = ['app-server', '-c', MARKER, '-c', definition];
  const child = startAppServer(command, args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home },
  });
  const state = { buffer: '' };
  let answer = null;
  let failure = null;
  await new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => settle(), waitMs);
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', (chunk) => takeLines(state, chunk, (line) => {
      const message = parseMessage(line);
      if (message?.id === INITIALIZE_ID) writeListRequest(child, workspace);
      if (message?.id === HOOKS_LIST_ID) { answer = message; settle(); }
    }));
    child.stderr.resume();
    child.on('error', (error) => { failure = error; settle(); });
    child.on('exit', settle);
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'maxstack-codex-hook-status', version: '1.0.0' } } })}\n`);
    } catch (error) { failure = error; settle(); }
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (failure) throw failure;
  if (!answer) throw new Error(`codex did not answer hooks/list within ${waitMs} ms`);
  if (answer.error) throw new Error(`codex returned an error: ${answer.error.message}`);
  return answer.result?.data ?? answer.data ?? [];
}

export async function readHookStatus({ workspace, hookCommand, command = 'codex', waitMs = DEFAULT_WAIT_MS }) {
  const home = mkdtempSync(join(tmpdir(), 'maxstack-codex-home-'));
  try {
    mkdirSync(home, { recursive: true });
    const definition = `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="${hookCommand.replaceAll('\\', '/').replaceAll('"', '\\"')}",timeout=30}]}]`;
    writeFileSync(join(home, 'config.toml'), '', 'utf8');
    const entries = await queryHooks({ command, workspace, home, waitMs, definition });
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook.command === hookCommand) {
          if (!hook.key || !hook.currentHash) throw new Error('codex listed the hook without a key or current hash');
          return { key: hook.key, hash: hook.currentHash, trustStatus: hook.trustStatus ?? null };
        }
      }
    }
    throw new Error(`codex listed no hook for ${hookCommand}`);
  } finally {
    // Codex can hold a file in the temporary home for a moment after it exits on Windows. A leftover temp
    // folder must not hide the hash the caller asked for.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      process.stderr.write(`warning: could not remove ${home}: ${error.message}\n`);
    }
  }
}

export function parseArgs(argv) {
  const options = { workspace: null, hookCommand: null, command: 'codex', waitMs: DEFAULT_WAIT_MS };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--workspace') options.workspace = argv[++index];
    else if (argument === '--hook-command') options.hookCommand = argv[++index];
    else if (argument === '--codex') options.command = argv[++index];
    else if (argument === '--timeout-ms') options.waitMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.workspace) throw new Error('--workspace is required');
  if (!options.hookCommand) throw new Error('--hook-command is required');
  if (!Number.isFinite(options.waitMs) || options.waitMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return options;
}

async function main(argv) {
  const result = await readHookStatus(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${(error?.message ?? String(error)).replaceAll('\n', ' ')}\n`);
      process.exitCode = 1;
    },
  );
}
