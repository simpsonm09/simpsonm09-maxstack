// Installer tests for the outputs of each runtime: the Claude plugin folders, the OpenCode entries and agents, the
// Copilot and Pi wrappers, and the Pi settings. Helpers come from ./lib/installer-test-kit.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, chmodSync, realpathSync, readFileSync, mkdirSync, renameSync, rmSync, statSync, mkdtempSync, appendFileSync, rmdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { MISSING_COPILOT, MISSING_PI, ORG_FOLDER, ORG_SOURCE, USER_CONFIG, ZWSP, assertOk, buildWorkspace, danglingLinks, independentSha, installer, isLink, layerNamed, lockPath, mustApply, ownedRecord, plainOutput, problemRows, python, readJson, removal, repoRoot, runInstaller, runStatus, seedUserFiles, settingsPath, shell, skip, snapshotTree, statusRows, verifyManifestsScript, verifyWorkspaceScript, withFreshWorkspace, withWorkspace, withWorkspaceNeeding, withoutTimestamp, wrapperText, writeFile, writeLayerStub, writeLayers } from './lib/installer-test-kit.mjs';

// On Windows a bash on PATH can be the WSL launcher, so use the one Git for Windows ships.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe');
  return existsSync(gitBash) ? gitBash : null;
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

function driftLines(run) {
  return run.stdout.split(/\r?\n/).filter((line) => line.startsWith('Drift:'));
}

const piPackagePath = (ctx) => join(ctx.workspace, '.maxstack', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent');
const expectedClaudeLinkKind = process.platform === 'win32' ? 'junction' : 'symlink';

function seedPiPackage(ctx, version = '1.1.0') {
  mkdirSync(piPackagePath(ctx), { recursive: true });
  writeFileSync(join(piPackagePath(ctx), 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
}

function fakePiNpm(ctx) {
  const bin = join(ctx.base, 'fake-pi-update-npm');
  mkdirSync(bin);
  const argsLog = join(ctx.base, 'npm-args.txt');
  const fakeScript = join(ctx.base, 'fake-pi-update-npm.mjs');
  writeFileSync(fakeScript, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nwriteFileSync(process.env.FAKE_NPM_ARGS, JSON.stringify(args));\nif (process.env.FAKE_NPM_EXIT) process.exit(Number(process.env.FAKE_NPM_EXIT));\nconst prefix = args[args.indexOf('--prefix') + 1];\nconst pkg = join(prefix, 'node_modules/@earendil-works/pi-coding-agent/package.json');\nif (!existsSync(pkg)) process.exit(0);\nconst old = JSON.parse(readFileSync(pkg, 'utf8'));\nold.version = args.at(-1).split('@').at(-1) === 'latest' ? '1.2.0' : args.at(-1).split('@').at(-1);\nwriteFileSync(pkg, JSON.stringify(old));\n`);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    mkdirSync(join(bin, 'node_modules', 'npm', 'bin'), { recursive: true });
    copyFileSync(fakeScript, join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const posixNpm = join(bin, 'npm');
    writeFileSync(posixNpm, `#!/bin/sh\nexec node "${fakeScript}" "$@"\n`);
    chmodSync(posixNpm, 0o755);
  }
  else {
    const npm = join(bin, 'npm');
    writeFileSync(npm, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
    chmodSync(npm, 0o755);
  }
  const env = { ...(ctx.env ?? process.env), FAKE_NPM_ARGS: argsLog };
  const existingPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${existingPath}`;
  return { env, argsLog };
}

function assertPiBridgeDispatch(ctx, shPath, bash, npmEnv, argsLog, fake) {
  const shCases = process.platform === 'win32' ? [['update', '--self']] : [['update', '--self'], ['update'], ['status']];
  for (const args of shCases) {
    const result = spawnSync(bash, [shPath, ...args], { windowsHide: true, encoding: 'utf8', env: { ...npmEnv, MAXSTACK_PI_BIN: args.length === 1 ? fake : undefined } });
    assert.equal(result.status, 0, plainOutput(result));
    if (args.length === 2) {
      assert.deepEqual(JSON.parse(readFileSync(argsLog, 'utf8')), ['install', '--prefix', join(ctx.workspace, '.maxstack', 'npm').replaceAll('\\', '/'), '--ignore-scripts', '--no-audit', '--no-fund', '@earendil-works/pi-coding-agent@latest']);
    } else {
      assert.match(plainOutput(result), new RegExp(`ARGS=${args.join(' ')}`));
    }
  }
}

withWorkspace('Pi update audit does not invoke npm or change the package', (ctx) => {
  seedPiPackage(ctx);
  const { env, argsLog } = fakePiNpm(ctx);
  const before = snapshotTree(ctx.workspace);
  const audit = runInstaller(shell, ctx, ['-UpdatePi'], { apply: false, env, layersFile: null, includeRuntimeCommands: false });
  assertOk(audit, 'Pi update audit failed');
  assert.match(plainOutput(audit), /Pi version before: 1\.1\.0/);
  assert.match(plainOutput(audit), /@earendil-works\/pi-coding-agent@latest/);
  assert.equal(readFileSync(join(piPackagePath(ctx), 'package.json'), 'utf8'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.1.0' }));
  assert.equal(existsSync(argsLog), false, 'audit invoked npm');
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'audit changed the workspace');
}, { fixture: { npm: true } });

withWorkspace('Pi update apply passes safe npm flags and the requested version', (ctx) => {
  seedPiPackage(ctx);
  const { env, argsLog } = fakePiNpm(ctx);
  const before = snapshotTree(ctx.workspace);
  const applied = runInstaller(shell, ctx, ['-UpdatePi', '-PiVersion', '1.1.5'], { env, layersFile: null, includeRuntimeCommands: false });
  assertOk(applied, 'Pi update apply failed');
  assert.match(plainOutput(applied), /Pi version before: 1\.1\.0/);
  assert.match(plainOutput(applied), /Pi version after: 1\.1\.5/);
  assert.deepEqual(JSON.parse(readFileSync(argsLog, 'utf8')), ['install', '--prefix', join(ctx.workspace, '.maxstack', 'npm'), '--ignore-scripts', '--no-audit', '--no-fund', '@earendil-works/pi-coding-agent@1.1.5']);
  assert.equal(JSON.parse(readFileSync(join(piPackagePath(ctx), 'package.json'), 'utf8')).version, '1.1.5');
  const after = snapshotTree(ctx.workspace);
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) === after.get(path)) continue;
    assert.ok(path.startsWith('.maxstack/npm/'), `update changed ${path} outside .maxstack/npm`);
  }
}, { fixture: { npm: true } });

withWorkspace('Pi update refuses a missing package and invalid option combinations', (ctx) => {
  const missing = runInstaller(shell, ctx, ['-UpdatePi'], { apply: false, layersFile: null, includeRuntimeCommands: false });
  assert.notEqual(missing.status, 0);
  assert.match(plainOutput(missing), /No workspace Pi package was found/);
  const wrong = join(ctx.workspace, '.maxstack', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(wrong, { recursive: true });
  writeFileSync(join(wrong, 'package.json'), JSON.stringify({ name: 'other-package', version: '1.0.0' }));
  const mismatch = runInstaller(shell, ctx, ['-UpdatePi'], { apply: false, layersFile: null, includeRuntimeCommands: false });
  assert.notEqual(mismatch.status, 0);
  assert.match(plainOutput(mismatch), /not @earendil-works\/pi-coding-agent/);
  for (const args of [['-UpdatePi', '-Uninstall'], ['-UpdatePi', '-Status'], ['-UpdatePi', '-Update'], ['-PiVersion', '1.0.0']]) {
    const invalid = runInstaller(shell, ctx, args, { apply: false, layersFile: null, includeRuntimeCommands: false });
    assert.notEqual(invalid.status, 0, `accepted ${args.join(' ')}`);
  }
}, { fixture: { npm: true } });

withWorkspace('Pi apply refreshes old wrappers and status is clean', (ctx) => {
  mustApply(ctx, []);
  const cmdPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  const shPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh');
  writeFileSync(cmdPath, readFileSync(cmdPath, 'utf8').replace(/^if \/i .*?\r?\n/m, ''));
  writeFileSync(shPath, readFileSync(shPath, 'utf8').replace(/^if \[ "\$#".*?\n/m, ''));
  assert.notDeepEqual(problemRows(runStatus(ctx)), [], 'status did not detect old wrappers');
  mustApply(ctx, []);
  assert.deepEqual(problemRows(runStatus(ctx)), [], 'status found drift after wrapper refresh');
}, { fixture: { npm: true } });

withWorkspace('Pi wrappers bridge update self to the managed npm package and pass plain update through', (ctx) => {
  seedPiPackage(ctx);
  const localBin = join(ctx.workspace, '.maxstack', 'npm', 'node_modules', '.bin');
  mkdirSync(localBin, { recursive: true });
  let fake;
  if (process.platform === 'win32') {
    writeFileSync(join(localBin, 'pi.cmd'), '@echo off\r\necho ARGS=%*\r\n');
    fake = join(ctx.base, 'fake-pi-args.cmd');
    writeFileSync(fake, '@echo off\r\necho ARGS=%*\r\n');
  } else {
    writeFileSync(join(localBin, 'pi'), '#!/bin/sh\nprintf "ARGS=%s\\n" "$*"\n');
    chmodSync(join(localBin, 'pi'), 0o755);
    fake = join(ctx.base, 'fake-pi-args');
    writeFileSync(fake, '#!/bin/sh\nprintf "ARGS=%s\\n" "$*"\n');
    chmodSync(fake, 0o755);
  }
  mustApply(ctx, []);
  const cmdPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  assert.match(readFileSync(cmdPath, 'utf8'), /%~1/);
  const helperPath = join(ctx.workspace, '.maxstack', 'bin', 'pi-self-update.mjs');
  assert.ok(existsSync(helperPath), 'the durable Pi updater helper was not installed');
  assert.match(readFileSync(cmdPath, 'utf8'), /pi-self-update\.mjs/);
  const piLock = readJson(lockPath(ctx));
  assert.ok(ownedRecord(piLock, '.maxstack/bin/pi-self-update.mjs', 'file'), 'the lock does not own the updater helper');
  const { env: npmEnv, argsLog } = fakePiNpm(ctx);
  const bash = findBash();
  assert.ok(bash, 'Git Bash is needed to execute pi.sh');
  const shPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh');
  assert.match(readFileSync(shPath, 'utf8'), /\[ "\$2" = --self \]/);
  assertPiBridgeDispatch(ctx, shPath, bash, npmEnv, argsLog, fake);
  const refused = spawnSync(bash, [shPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env: { ...npmEnv, MAXSTACK_PI_BIN: fake } });
  assert.equal(refused.status, 2, plainOutput(refused));
  assert.match(plainOutput(refused), /Refusing to update an overridden Pi/);
  const extra = spawnSync(bash, [shPath, 'update', '--self', '&& touch injected'], { windowsHide: true, encoding: 'utf8', env: npmEnv });
  assert.equal(extra.status, 2, plainOutput(extra));
  assert.doesNotMatch(readFileSync(argsLog, 'utf8'), /injected/);
  const removedPackage = piPackagePath(ctx);
  const npmLogBeforeRemoval = readFileSync(argsLog, 'utf8');
  rmSync(removedPackage, { recursive: true, force: true });
  const missingPackage = spawnSync(bash, [shPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env: npmEnv });
  assert.equal(missingPackage.status, 2, plainOutput(missingPackage));
  assert.match(plainOutput(missingPackage), /Managed Pi package is missing/);
  assert.equal(readFileSync(argsLog, 'utf8'), npmLogBeforeRemoval, 'missing package invoked npm');
  seedPiPackage(ctx);
  const emptyExtraSh = spawnSync(bash, [shPath, 'update', '--self', ''], { windowsHide: true, encoding: 'utf8', env: npmEnv });
  assert.equal(emptyExtraSh.status, 2, plainOutput(emptyExtraSh));
  assert.equal(readFileSync(argsLog, 'utf8'), npmLogBeforeRemoval, 'empty extra argument invoked npm');
  const noNpmEnv = { ...npmEnv, PATH: '' };
  const missingNpm = spawnSync(bash, [shPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env: noNpmEnv });
  assert.equal(missingNpm.status, 127, plainOutput(missingNpm));
  assert.match(plainOutput(missingNpm), /npm was not found on PATH/);
  const failedNpm = spawnSync(bash, [shPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env: { ...npmEnv, FAKE_NPM_EXIT: '19' } });
  assert.equal(failedNpm.status, 19, plainOutput(failedNpm));
  if (process.platform === 'win32') {
    const cmd = spawnSync('cmd.exe', ['/d', '/c', cmdPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env: npmEnv });
    assert.equal(cmd.status, 0, plainOutput(cmd));
    const cmdNpmArgs = JSON.parse(readFileSync(argsLog, 'utf8'));
    cmdNpmArgs[2] = cmdNpmArgs[2].replaceAll('\\', '/');
    assert.deepEqual(cmdNpmArgs, ['install', '--prefix', join(ctx.workspace, '.maxstack', 'npm').replaceAll('\\', '/'), '--ignore-scripts', '--no-audit', '--no-fund', '@earendil-works/pi-coding-agent@latest']);
    const plantedCwd = join(ctx.base, 'planted-npm-cwd');
    const plantedMarker = join(ctx.base, 'planted-npm-marker');
    mkdirSync(join(plantedCwd, 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(plantedCwd, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n');
    writeFileSync(join(plantedCwd, 'node_modules', 'npm', 'bin', 'npm-cli.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(plantedMarker)}, 'planted cwd npm ran');\n`);
    const trustedPathCmd = join(join(npmEnv.PATH.split(';')[0]), 'npm.cmd');
    assert.ok(existsSync(trustedPathCmd), 'trusted npm PATH stub is missing');
    const plantedCwdRun = spawnSync('cmd.exe', ['/d', '/c', cmdPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env: npmEnv, cwd: plantedCwd });
    assert.equal(plantedCwdRun.error, undefined, plantedCwdRun.error?.message);
    assert.equal(typeof plantedCwdRun.status, 'number', plainOutput(plantedCwdRun));
    assert.equal(plantedCwdRun.status, 0, plainOutput(plantedCwdRun));
    assert.equal(existsSync(plantedMarker), false, 'npm from the working directory ran');
    const trustedNpmArgs = JSON.parse(readFileSync(argsLog, 'utf8'));
    trustedNpmArgs[2] = trustedNpmArgs[2].replaceAll('\\', '/');
    assert.deepEqual(trustedNpmArgs, ['install', '--prefix', join(ctx.workspace, '.maxstack', 'npm').replaceAll('\\', '/'), '--ignore-scripts', '--no-audit', '--no-fund', '@earendil-works/pi-coding-agent@latest'], 'trusted PATH npm stub did not run');
    const failedCmd = spawnSync('cmd.exe', ['/d', '/c', cmdPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env: { ...npmEnv, FAKE_NPM_EXIT: '19' } });
    assert.equal(failedCmd.status, 19, plainOutput(failedCmd));
    const runCmdVerbatim = (extra, env = npmEnv) => {
      const quotedExtra = extra === null ? '' : ` "${extra.replaceAll('"', '""')}"`;
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${cmdPath}" update --self${quotedExtra}"`], {
        windowsHide: true, encoding: 'utf8', env, windowsVerbatimArguments: true,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(typeof result.status, 'number', plainOutput(result));
      return result;
    };
    const extraCmd = runCmdVerbatim('&& echo injected');
    assert.equal(extraCmd.status, 2, plainOutput(extraCmd));
    assert.match(plainOutput(extraCmd), /Usage: pi update --self/);
    const emptyExtraCmd = runCmdVerbatim('');
    assert.equal(emptyExtraCmd.status, 2, plainOutput(emptyExtraCmd));
    assert.match(plainOutput(emptyExtraCmd), /Usage: pi update --self/);
    const npmLogBeforeCmdRemoval = readFileSync(argsLog, 'utf8');
    rmSync(removedPackage, { recursive: true, force: true });
    assert.equal(existsSync(join(removedPackage, 'package.json')), false, 'fixture package was not removed');
    const missingPackageCmd = runCmdVerbatim(null);
    assert.equal(missingPackageCmd.status, 2, `${plainOutput(missingPackageCmd)}\n${readFileSync(cmdPath, 'utf8')}`);
    assert.match(plainOutput(missingPackageCmd), /Managed Pi package is missing/);
    assert.equal(readFileSync(argsLog, 'utf8'), npmLogBeforeCmdRemoval, 'missing package invoked npm');
    seedPiPackage(ctx);
    const noNpmEnv = { ...npmEnv };
    for (const key of Object.keys(noNpmEnv)) if (key.toUpperCase() === 'PATH') delete noNpmEnv[key];
    const nodeOnly = join(ctx.base, 'node-only-path');
    mkdirSync(nodeOnly);
    copyFileSync(process.execPath, join(nodeOnly, 'node.exe'));
    noNpmEnv.PATH = `${nodeOnly};${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`;
    const missingNpmCmd = runCmdVerbatim(null, noNpmEnv);
    assert.equal(missingNpmCmd.status, 127, plainOutput(missingNpmCmd));
    assert.match(plainOutput(missingNpmCmd), /npm(?:\.cmd)? was not found on PATH/);
    const hostileMarker = join(ctx.base, 'pi-wrapper-injected-marker');
    rmSync(hostileMarker, { force: true });
    const argsBeforeHostile = readFileSync(argsLog, 'utf8');
    const hostile = runCmdVerbatim(`x"=="" (echo INJ>${hostileMarker}) & rem "`);
    assert.equal(hostile.status, 2, plainOutput(hostile));
    assert.match(plainOutput(hostile), /Usage: pi update --self/);
    assert.equal(readFileSync(argsLog, 'utf8'), argsBeforeHostile, 'quote/ampersand input invoked npm');
    assert.equal(existsSync(hostileMarker), false, 'a quote/ampersand payload ran a marker command');
    const overrideCmd = runCmdVerbatim(null, { ...npmEnv, MAXSTACK_PI_BIN: fake });
    assert.equal(overrideCmd.status, 2, plainOutput(overrideCmd));
    assert.match(plainOutput(overrideCmd), /Refusing to update an overridden Pi/);
    const passed = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${cmdPath}" update`], { windowsHide: true, encoding: 'utf8', env: process.env, windowsVerbatimArguments: true });
    assert.equal(passed.status, 0, plainOutput(passed));
    assert.match(plainOutput(passed), /ARGS=update/);
  }
}, { fixture: { npm: true } });

withWorkspace('external Pi selection refuses update self and names the selected path', (ctx) => {
  seedPiPackage(ctx);
  const { env, argsLog } = fakePiNpm(ctx);
  const external = process.platform === 'win32' ? join(ctx.base, 'external-pi.cmd') : join(ctx.base, 'external-pi');
  writeFileSync(external, process.platform === 'win32' ? '@echo off\r\necho external\r\n' : '#!/bin/sh\necho external\n');
  if (process.platform !== 'win32') chmodSync(external, 0o755);
  const run = runInstaller(shell, ctx, ['-PiCommand', external], { env });
  assertOk(run, 'external Pi apply failed');
  const cmdPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  const shPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh');
  assert.match(readFileSync(cmdPath, 'utf8'), new RegExp(external.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(readFileSync(shPath, 'utf8'), /selected external Pi/);
  const bash = findBash();
  assert.ok(bash, 'Git Bash is needed to execute pi.sh');
  const npmArgsBeforeBridge = readFileSync(argsLog, 'utf8');
  const refused = spawnSync(bash, [shPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env });
  assert.equal(refused.status, 2, plainOutput(refused));
  assert.match(plainOutput(refused), new RegExp(external.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(readFileSync(argsLog, 'utf8'), npmArgsBeforeBridge, 'external Pi update invoked npm');
  if (process.platform === 'win32') {
    const refusedCmd = spawnSync('cmd.exe', ['/d', '/c', cmdPath, 'update', '--self'], { windowsHide: true, encoding: 'utf8', env });
    assert.equal(refusedCmd.status, 2, plainOutput(refusedCmd));
    assert.match(plainOutput(refusedCmd), /Refusing to update selected external Pi/);
    assert.equal(readFileSync(argsLog, 'utf8'), npmArgsBeforeBridge, 'external Pi cmd update invoked npm');
  }
}, { fixture: { npm: true } });

if (process.platform === 'win32') {
  withWorkspace('missing Pi helper remains owned and apply fails closed while status reports it', (ctx) => {
    const localPi = writeLocalPi(ctx);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const helper = join(ctx.workspace, '.maxstack', 'bin', 'pi-self-update.mjs');
    rmSync(localPi);
    rmSync(helper);
    const apply = runInstaller(shell, ctx, ['-PiCommand', MISSING_PI]);
    assert.equal(apply.status, 1, plainOutput(apply));
    assert.match(plainOutput(apply), /helper .* is missing or changed/);
    assert.match(plainOutput(apply), /status and uninstall can still report it/);
    assert.ok(ownedRecord(readJson(lockPath(ctx)), '.maxstack/bin/pi-self-update.mjs', 'file'), 'apply dropped helper ownership');
    const status = runStatus(ctx, ['-PiCommand', MISSING_PI]);
    assert.ok(statusRows(status).some((row) => row.label === '.maxstack/bin/pi-self-update.mjs' && row.state === 'missing'), plainOutput(status));
  }, {});

  withWorkspace('modified Pi helper remains owned and apply refuses to overwrite it while Pi is absent', (ctx) => {
    const localPi = writeLocalPi(ctx);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const helper = join(ctx.workspace, '.maxstack', 'bin', 'pi-self-update.mjs');
    appendFileSync(helper, '\n// locally modified\n');
    const changed = readFileSync(helper, 'utf8');
    rmSync(localPi);
    const apply = runInstaller(shell, ctx, ['-PiCommand', MISSING_PI]);
    assert.equal(apply.status, 1, plainOutput(apply));
    assert.match(plainOutput(apply), /helper .* is missing or changed/);
    assert.equal(readFileSync(helper, 'utf8'), changed, 'apply overwrote a modified helper');
    assert.ok(ownedRecord(readJson(lockPath(ctx)), '.maxstack/bin/pi-self-update.mjs', 'file'), 'apply dropped helper ownership');
    const status = runStatus(ctx, ['-PiCommand', MISSING_PI]);
    assert.ok(statusRows(status).some((row) => row.label === '.maxstack/bin/pi-self-update.mjs' && row.state === 'modified'), plainOutput(status));
  }, {});

  withWorkspace('local to external Pi transition cleans only the unchanged owned helper', (ctx) => {
    const localPi = writeLocalPi(ctx);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const helper = join(ctx.workspace, '.maxstack', 'bin', 'pi-self-update.mjs');
    const external = join(ctx.base, 'external-pi.cmd');
    writeFileSync(external, '@echo off\r\necho external\r\n');
    rmSync(localPi);
    const transitioned = runInstaller(shell, ctx, ['-PiCommand', external]);
    assert.equal(transitioned.status, 0, plainOutput(transitioned));
    assert.match(plainOutput(transitioned), /Removed the stale wrapper .*pi-self-update\.mjs/);
    assert.equal(existsSync(helper), false, 'unchanged owned helper remained after transition');
    assert.equal(ownedRecord(readJson(lockPath(ctx)), '.maxstack/bin/pi-self-update.mjs', 'file'), undefined, 'lock retained stale helper ownership');
  }, {});

  withWorkspace('local to external Pi transition preserves and reports a modified helper', (ctx) => {
    const localPi = writeLocalPi(ctx);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const helper = join(ctx.workspace, '.maxstack', 'bin', 'pi-self-update.mjs');
    appendFileSync(helper, '\n// locally modified\n');
    const changed = readFileSync(helper, 'utf8');
    const external = join(ctx.base, 'external-pi.cmd');
    writeFileSync(external, '@echo off\r\necho external\r\n');
    rmSync(localPi);
    const transitioned = runInstaller(shell, ctx, ['-PiCommand', external]);
    assert.equal(transitioned.status, 0, plainOutput(transitioned));
    assert.match(plainOutput(transitioned), /changed since the last apply, so it was not removed/);
    assert.equal(readFileSync(helper, 'utf8'), changed, 'transition overwrote modified helper');
    assert.ok(ownedRecord(readJson(lockPath(ctx)), '.maxstack/bin/pi-self-update.mjs', 'file'), 'lock forgot modified helper ownership');
    const status = runStatus(ctx, ['-PiCommand', external]);
    assert.ok(statusRows(status).some((row) => row.label === '.maxstack/bin/pi-self-update.mjs' && row.state === 'modified'), plainOutput(status));
  }, {});
}

withWorkspace('the Claude runtime uses a platform directory link for local layers and a pinned sparse copy for pstack', (ctx) => {
  mustApply(ctx);

  const plugins = join(ctx.workspace, '.claude', 'plugins');
  for (const [plugin, target] of [
    ['simpsonm09-org-ai-plugin', '.opencode/plugins/simpsonm09-org-ai-plugin'],
    ['simpsonm09-personal-ai-plugin', '.opencode/plugins/simpsonm09-personal-ai-plugin'],
  ]) {
    const child = join(plugins, plugin);
    assert.ok(isLink(child), `${plugin} is a link`);
    assert.equal(realpathSync(child), realpathSync(join(ctx.workspace, ...target.split('/'))));
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
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.kind, expectedClaudeLinkKind);
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
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --foo "a b""`], { windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: true });
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
  const apostropheWorkspace = join(ctx.base, "O'Brien workspace");
  renameSync(ctx.workspace, apostropheWorkspace);
  ctx.workspace = apostropheWorkspace;
  const bash = findBash();
  const orgLayer = join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin');
  const orgManifestPath = join(orgLayer, 'layer.json');
  const orgManifest = JSON.parse(readFileSync(orgManifestPath, 'utf8'));
  orgManifest.workspaceInstructions = 'workspace.md';
  writeFileSync(orgManifestPath, JSON.stringify(orgManifest));
  writeFileSync(join(orgLayer, 'workspace.md'), 'shell projection sentinel\n');
  mustApply(ctx);
  const sh = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh'), 'utf8');
  assert.match(sh, /^export AGENT_ACCESS_COPILOT_ASK=allow$/m, 'the script sets the switch');
  assert.match(sh, /exec copilot --plugin-dir "[^"]*\/\.claude\/plugins\/pstack" --plugin-dir "[^"]*\/simpsonm09-org-ai-plugin" --plugin-dir "[^"]*\/simpsonm09-personal-ai-plugin" "\$@"$/m);

  const fakeBin = join(ctx.base, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'copilot'), '#!/bin/sh\nprintf "ASK=%s\\n" "$AGENT_ACCESS_COPILOT_ASK"\nprintf "INSTRUCTIONS=%s\\n" "$COPILOT_CUSTOM_INSTRUCTIONS_DIRS"\nfor arg in "$@"; do printf "ARG=%s\\n" "$arg"; done\n');
  chmodSync(join(fakeBin, 'copilot'), 0o755);
  const env = { ...process.env, COPILOT_CUSTOM_INSTRUCTIONS_DIRS: 'existing-dir' };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`;
  const run = spawnSync(bash, [join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh').replaceAll('\\', '/'), '--foo', 'a b'], { windowsHide: true, encoding: 'utf8', env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, new RegExp(`INSTRUCTIONS=existing-dir,${join(ctx.workspace, '.maxstack', 'copilot-instructions').replaceAll('\\', '/')}`));
  assert.match(run.stdout, /ARG=--plugin-dir/);
  assert.match(run.stdout, /ARG=--foo\nARG=a b/, 'the caller arguments follow, unsplit');
}, {});

withWorkspace('Copilot instruction path rejects comma during planning when CLI is absent', (ctx) => {
  const layerRoot = join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin');
  const manifestPath = join(layerRoot, 'layer.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.workspaceInstructions = 'workspace.md';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(layerRoot, 'workspace.md'), 'planning validation sentinel\n');
  const commaWorkspace = join(ctx.base, 'comma,workspace');
  renameSync(ctx.workspace, commaWorkspace);
  ctx.workspace = commaWorkspace;
  const run = runInstaller(shell, ctx, ['-Runtimes', 'claude,copilot'], { layersFile: writeLayers(ctx), includeRuntimeCommands: false });
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /contains a comma/);
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'validation happens before projection writes');
}, {});

withWorkspace('Copilot instruction path rejects delayed-expansion exclamation before projection writes', (ctx) => {
  const layerRoot = join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin');
  const manifestPath = join(layerRoot, 'layer.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.workspaceInstructions = 'workspace.md';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(layerRoot, 'workspace.md'), 'planning validation sentinel\n');
  const unsafeWorkspace = join(ctx.base, 'bang!workspace');
  renameSync(ctx.workspace, unsafeWorkspace);
  ctx.workspace = unsafeWorkspace;
  const run = runInstaller(shell, ctx, ['-Runtimes', 'claude,copilot'], { layersFile: writeLayers(ctx), includeRuntimeCommands: false });
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /contains '!'/);
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'validation happens before projection writes');
}, {});

withWorkspace('copilot with no executable found warns, keeps the recorded wrappers, and the lock keeps their records', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')));

  const run = mustApply(ctx, ['-CopilotCommand', MISSING_COPILOT]);
  assert.match(plainOutput(run), /Copilot CLI not found/, run.stdout);
  assert.match(plainOutput(run), /Kept .*copilot\.cmd.*because Copilot was not found/, run.stdout);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')), 'the recorded Copilot wrapper was removed for a Copilot that was only missing on this run');
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh')), 'the recorded Copilot script was removed for a Copilot that was only missing on this run');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.copilot.enabled, true, 'the lock dropped the Copilot wrappers it still holds');
  assert.ok(ownedRecord(lock, '.maxstack/bin/copilot.cmd', 'file'), 'the lock no longer owns the kept Copilot wrapper');
  assert.ok(ownedRecord(lock, '.maxstack/bin/copilot.sh', 'file'), 'the lock no longer owns the kept Copilot script');
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
  for (const line of drift) assert.match(line, /: (?:matching|matches)$/, line);
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

withWorkspace('the installer has no live-server check and no skip switch', (ctx) => {
  // The installer has no live-server check; T3 can reuse a long-lived server.
  assert.doesNotMatch(readFileSync(installer, 'utf8'), /openchamber|SkipLiveServerCheck/i);
  const run = runInstaller(shell, ctx, ['-SkipLiveServerCheck'], { apply: false });
  assert.notEqual(run.status, 0, 'the installer accepted the removed -SkipLiveServerCheck switch');
  assert.match(plainOutput(run), /SkipLiveServerCheck/);
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

withWorkspace('pi.cmd sets the agent folder and the ask switch, runs the Pi CLI with the arguments, and honours MAXSTACK_PI_BIN', (ctx) => {
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  const text = readFileSync(wrapper, 'utf8');
  assert.match(text, /\r\n/, 'the wrapper has CRLF endings');
  assert.ok(text.includes(`set "PI_CODING_AGENT_DIR=${join(ctx.workspace, '.pi', 'agent')}"`), 'the agent folder is not set');
  assert.ok(text.includes('set "AGENT_ACCESS_PI_ASK=allow"'), 'the ask switch is not set');
  assert.ok(text.includes(`set "PI_BIN=${ctx.fakePi}"`), 'the wrapper does not name the Pi CLI found at install time');

  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --mode rpc "a b""`], { windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes(`AGENT_DIR=${join(ctx.workspace, '.pi', 'agent')}`), run.stdout);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARGS=--mode rpc "a b"/);

  const other = join(ctx.base, 'other-pi.cmd');
  writeFileSync(other, '@echo off\r\necho OTHER=%PI_CODING_AGENT_DIR%\r\n');
  const overridden = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --mode rpc"`], { windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, MAXSTACK_PI_BIN: other } });
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
    windowsHide: true,
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

  const run = spawnSync(bash, [script, '--mode', 'rpc', 'a b'], { windowsHide: true, encoding: 'utf8', env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes(`AGENT=${agentDir}`), run.stdout);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARG=--mode\nARG=rpc\nARG=a b/, 'the caller arguments follow, unsplit');

  const overrideBin = join(ctx.base, 'override-pi');
  writeFileSync(overrideBin, '#!/bin/sh\nprintf "OVERRIDE=%s\\n" "$1"\n');
  chmodSync(overrideBin, 0o755);
  const noPi = { ...process.env, [pathKey]: '/nonexistent-maxstack-path', MAXSTACK_PI_BIN: overrideBin.replaceAll('\\', '/') };
  const overridden = spawnSync(bash, [script, 'rpc'], { windowsHide: true, encoding: 'utf8', env: noPi });
  assert.equal(overridden.status, 0, `${overridden.stdout}\n${overridden.stderr}`);
  assert.match(overridden.stdout, /OVERRIDE=rpc/);
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

withWorkspace('a local layer is a Pi package only when its repository-root package.json names a pi key', (ctx) => {
  writeLayerStub(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), {
    claudePlugin: 'simpsonm09-org-ai-plugin',
    pi: { extensions: ['./pi/index.ts'] },
  });
  mustApply(ctx);
  const settings = readJson(join(ctx.workspace, '.pi', 'agent', 'settings.json'));
  const orgPackage = relative(join(ctx.workspace, '.pi/agent'), join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin')).replaceAll('\\', '/');
  assert.ok(settings.packages.includes(orgPackage), 'the org repository-root package is not listed');
  assert.ok(!settings.packages.includes('../../.claude/plugins/simpsonm09-personal-ai-plugin'), 'a layer without a pi key is a package');
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'pi', 'index.ts')), 'the pi folder is not installed');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.deepEqual(byName['simpsonm09-org-ai-plugin'].pi, {
    enabled: true,
    package: 'projects/repos/simpsonm09-org-ai-plugin',
    skills: '.claude/plugins/simpsonm09-org-ai-plugin/skills',
  });
  assert.deepEqual(byName['simpsonm09-personal-ai-plugin'].pi, {
    enabled: true,
    package: null,
    skills: '.claude/plugins/simpsonm09-personal-ai-plugin/skills',
  });
}, {});

withWorkspace('finding F2: a local pstack source installs its root Pi package and keeps its Claude skills', (ctx) => {
  const source = ctx.fixture.dir;
  const result = mustApply(ctx, ['-Source', `pstack=local:${source}`]);
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  const settings = readJson(settingsPath);
  const packageEntry = settings.packages.find((entry) => resolve(ctx.workspace, '.pi', 'agent', entry) === resolve(source));
  assert.ok(packageEntry, `${plainOutput(result)}\nPi packages: ${JSON.stringify(settings.packages)}`);
  const rootPackage = readJson(join(source, 'package.json'));
  assert.ok(rootPackage.pi.extensions.some((entry) => existsSync(join(source, entry.replace('./', '')))));
  assert.ok(settings.skills.includes('../../.claude/plugins/pstack/skills'));
  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.ok(lock.pi.packages.includes(packageEntry));
  const status = runStatus(ctx);
  assert.equal(status.status, 0, plainOutput(status));
  assert.match(plainOutput(status), /matching \.pi\/agent\/settings\.json/);
}, {});

withWorkspace('a local pi key uses the source package.json even when the Claude copy omits it', (ctx) => {
  const org = join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin');
  writeLayerStub(org, { claudePlugin: 'simpsonm09-org-ai-plugin', pi: { extensions: ['./pi/index.ts'] } });
  // The source keeps the package.json that names the pi key, but the files list leaves it out,
  // so the installed copy has the pi folder and no package.json for Pi to read.
  const layerPath = join(org, 'layer.json');
  const layer = readJson(layerPath);
  writeFile(org, 'layer.json', JSON.stringify({ ...layer, files: layer.files.filter((file) => file !== 'package.json') }));

  const run = mustApply(ctx);
  const settings = readJson(join(ctx.workspace, '.pi', 'agent', 'settings.json'));
  const orgPackage = relative(join(ctx.workspace, '.pi/agent'), org).replaceAll('\\', '/');
  assert.ok(settings.packages.includes(orgPackage), `${plainOutput(run)}\nPi packages: ${JSON.stringify(settings.packages)}`);
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

withWorkspace('a workspace with no Pi and no Pi wrappers warns and skips, and writes no wrapper', (ctx) => {
  const run = mustApply(ctx, ['-PiCommand', MISSING_PI]);
  assert.match(plainOutput(run), /Pi CLI not found/, run.stdout);
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')), 'a Pi wrapper was written without a Pi CLI');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh')), 'a Pi script was written without a Pi CLI');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.pi.enabled, false);
  assert.match(lock.pi.reason, /no 'maxstack-test-no-such-pi' application/);
}, {});

withWorkspace('finding F6: a skipped selected Pi wrapper is summarized and strict apply fails', (ctx) => {
  const run = runInstaller(shell, ctx, ['-PiCommand', MISSING_PI, '-CopilotCommand', MISSING_COPILOT]);
  assert.equal(run.status, 0, plainOutput(run));
  assert.match(run.stdout, /INCOMPLETE: selected runtime wrappers were skipped:/);
  assert.match(run.stdout, /pi: \.maxstack\/bin\/pi\.cmd, \.maxstack\/bin\/pi\.sh/);
  assert.match(run.stdout, /copilot: \.maxstack\/bin\/copilot\.cmd, \.maxstack\/bin\/copilot\.sh/);
  const strict = runInstaller(shell, ctx, ['-PiCommand', MISSING_PI, '-CopilotCommand', MISSING_COPILOT, '-Strict']);
  assert.equal(strict.status, 1, plainOutput(strict));
  assert.match(strict.stdout, /INCOMPLETE:/);
}, {});

const LOCAL_PI_BIN = ['.maxstack', 'npm', 'node_modules', '.bin'];

function writeLocalPi(ctx) {
  mkdirSync(join(ctx.workspace, ...LOCAL_PI_BIN), { recursive: true });
  return writeFakeCli(join(ctx.workspace, ...LOCAL_PI_BIN), 'pi');
}

test('a Pi installed under the workspace is found with none on PATH, and its wrappers survive a run without it', { skip }, async (t) => {
  await t.test('(a) apply writes both wrappers pointing at the workspace-local Pi', () => withFreshWorkspace((ctx) => {
    const stub = writeLocalPi(ctx);
    const run = mustApply(ctx, ['-PiCommand', MISSING_PI]);
    assert.doesNotMatch(plainOutput(run), /Pi CLI not found/, run.stdout);
    assert.ok(wrapperText(ctx, 'pi.cmd').includes(`set "PI_BIN=${stub}"`), 'pi.cmd does not name the workspace-local Pi');
    assert.ok(wrapperText(ctx, 'pi.sh').includes(stub.replaceAll('\\', '/')), 'pi.sh does not name the workspace-local Pi');
  }));

  await t.test('(b) a second apply changes no wrapper and no lock entry', () => withFreshWorkspace((ctx) => {
    writeLocalPi(ctx);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const before = { cmd: wrapperText(ctx, 'pi.cmd'), sh: wrapperText(ctx, 'pi.sh'), lock: withoutTimestamp(readJson(lockPath(ctx))) };
    const run = mustApply(ctx, ['-PiCommand', MISSING_PI]);
    assert.doesNotMatch(plainOutput(run), /Removed the stale wrapper|Kept .*pi\.cmd/, run.stdout);
    assert.deepEqual({ cmd: wrapperText(ctx, 'pi.cmd'), sh: wrapperText(ctx, 'pi.sh'), lock: withoutTimestamp(readJson(lockPath(ctx))) }, before);
  }));

  await t.test('(c) with the Pi CLI gone, apply warns and keeps the recorded wrappers', () => withFreshWorkspace((ctx) => {
    const stub = writeLocalPi(ctx);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const before = { cmd: wrapperText(ctx, 'pi.cmd'), sh: wrapperText(ctx, 'pi.sh') };
    rmSync(stub);
    const run = mustApply(ctx, ['-PiCommand', MISSING_PI]);
    assert.match(plainOutput(run), /Pi CLI not found/, run.stdout);
    assert.match(plainOutput(run), /Kept .*pi\.cmd.*because Pi was not found/, run.stdout);
    assert.equal(wrapperText(ctx, 'pi.cmd'), before.cmd, 'the Pi wrapper changed');
    assert.equal(wrapperText(ctx, 'pi.sh'), before.sh, 'the Pi script changed');
    const lock = readJson(lockPath(ctx));
    assert.ok(ownedRecord(lock, '.maxstack/bin/pi.cmd', 'file'), 'the lock dropped the Pi wrapper it recorded');
    assert.ok(ownedRecord(lock, '.maxstack/bin/pi.sh', 'file'), 'the lock dropped the Pi script it recorded');
    if (process.platform === 'win32') {
      assert.ok(ownedRecord(lock, '.maxstack/bin/pi-self-update.mjs', 'file'), 'the lock dropped the updater helper it recorded');
    }
  }));

  await t.test('(d) status reports the kept wrappers as matching', () => withFreshWorkspace((ctx) => {
    const stub = writeLocalPi(ctx);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const withStub = statusRows(runStatus(ctx, ['-PiCommand', MISSING_PI]));
    rmSync(stub);
    mustApply(ctx, ['-PiCommand', MISSING_PI]);
    const run = runStatus(ctx, ['-PiCommand', MISSING_PI]);
    assert.equal(run.status, 0, run.stderr);
    for (const rows of [withStub, statusRows(run)]) {
      for (const name of ['.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh']) {
        assert.deepEqual(rows.find((row) => row.label === name), { state: 'matching', label: name }, `${name} is not reported as matching`);
      }
      if (process.platform === 'win32') {
        const helper = '.maxstack/bin/pi-self-update.mjs';
        assert.deepEqual(rows.find((row) => row.label === helper), { state: 'matching', label: helper }, `${helper} is not reported as matching`);
      }
    }
  }));
});

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

  const run = spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8', env });
  assert.notEqual(run.status, 0, 'the verifier passed with the Pi CLI on PATH and no Pi wrapper');
  assert.match(plainOutput(run), /the pi CLI is on PATH.*rerun Install-Workspace\.ps1 -Apply/);
}, {});

withWorkspaceNeeding('python', python, 'the verifier fails when a workspace-local Pi has no recorded wrapper, as the installer finds it before PATH', (ctx) => {
  mustApply(ctx, ['-PiCommand', MISSING_PI]);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  writeLocalPi(ctx);
  const run = spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'the verifier passed with a workspace-local Pi and no Pi wrapper');
  assert.match(plainOutput(run), /the pi CLI is installed under .*rerun Install-Workspace\.ps1 -Apply/);
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
    const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });

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
. (Join-Path (Split-Path -Parent $Installer) 'Install-Ordinal.ps1')
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
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', harness, installer], { windowsHide: true, encoding: 'utf8' });
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
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });

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
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
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

withWorkspaceNeeding('python', python, 'the workspace verifier checks each owned path against the disk and refuses a malformed record', (ctx) => {
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
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

withWorkspace('a link retargeted by hand is modified, and a file changed in a pinned claude copy is modified', (ctx) => {
  mustApply(ctx);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  rmdirSync(child);
  const other = join(ctx.base, 'other-target');
  mkdirSync(other);
  writeFileSync(join(other, 'keep.txt'), 'outside bytes');
  symlinkSync(other, child, 'junction');
  appendFileSync(join(ctx.workspace, '.claude', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md'), 'edit\n');

  assert.deepEqual(problemRows(runStatus(ctx)), [
    { state: 'modified', label: '.claude/plugins/pstack' },
    { state: 'modified', label: '.claude/plugins/simpsonm09-org-ai-plugin' },
  ]);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'outside bytes', 'status followed the escaped link');
  mustApply(ctx);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'outside bytes', 'replacement changed the escaped target');
  assert.equal(realpathSync(child), realpathSync(join(ctx.workspace, ...ORG_FOLDER.split('/'))));
  assert.deepEqual(problemRows(runStatus(ctx)), []);
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
  for (const line of drift) assert.match(line, /: (?:matching|matches|missing)$/, line);
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

withWorkspaceNeeding('python', python, 'the owned list names only selected outputs, and both verifiers accept a partial install', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const owned = readJson(lockPath(ctx)).owned.map((record) => record.path);
  assert.ok(owned.includes('.claude/plugins/simpsonm09-org-ai-plugin'), 'the copy of a local layer is not owned');
  for (const path of owned) {
    assert.doesNotMatch(path, /^(opencode\.jsonc|\.opencode\/|\.pi\/)|pi\.(cmd|sh)$/, `${path} belongs to an unselected runtime`);
  }
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  const manifests = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { windowsHide: true, encoding: 'utf8' });
  assert.equal(manifests.status, 0, `${manifests.stdout}\n${manifests.stderr}`);
}, {});

// Removal: -Remove and -Uninstall. Each test installs, removes or uninstalls, and reads what is left. The
// round trip is the proof of the deletion rules: after -Uninstall the tree equals the tree before the install.
const LOCAL_PLUGINS = ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'];

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

withWorkspace('a local source reached through a junction is compared by the folder it names, and refused as inside .claude', (ctx) => {
  const toClaude = join(ctx.base, 'to-claude');
  mkdirSync(join(ctx.workspace, '.claude'), { recursive: true });
  symlinkSync(join(ctx.workspace, '.claude'), toClaude, 'junction');
  const viaJunction = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${toClaude}`], { apply: false });
  assert.notEqual(viaJunction.status, 0, 'a junction into .claude was accepted');
  assert.match(plainOutput(viaJunction), /is inside \.claude/, viaJunction.stdout);

}, {});

// N2: an unowned folder whose name differs from a retired folder by a zero width space is kept.
withWorkspace('item N2: an unowned folder named like a retired one, with a zero width space, is kept by apply', (ctx) => {
  mustApply(ctx);
  const folder = join(ctx.workspace, '.opencode', 'plugins', `pstack-opencode${ZWSP}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'user.txt'), 'mine\n');
  mustApply(ctx);
  assert.ok(existsSync(join(folder, 'user.txt')), 'an apply deleted a folder the installer does not own');
}, {});
