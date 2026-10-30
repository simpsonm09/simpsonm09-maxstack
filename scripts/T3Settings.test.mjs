#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(root, 'scripts', 'Install-T3Settings.ps1');
const shell = 'pwsh';

function runReport(file, workspace, stop = false) {
  return runReportWithHelper(file, workspace, helper, stop);
}

function runReportWithHelper(file, workspace, helperPath, stop = false, preamble = '') {
  const command = `${stop ? "$ErrorActionPreference = 'Stop'; " : ''}. '${helperPath.replaceAll("'", "''")}'; ${preamble}; Get-T3SettingsReport -Path '${file.replaceAll("'", "''")}' -Workspace '${workspace.replaceAll("'", "''")}' -RuntimeNames @('claude','copilot','pi') | ConvertTo-Json -Depth 64 -Compress`;
  const env = { ...process.env };
  delete env.MAXSTACK_T3_SETTINGS;
  delete env.T3CODE_HOME;
  return spawnSync(shell, ['-NoProfile', '-Command', command], { cwd: root, encoding: 'utf8', windowsHide: true, env });
}

test('report classifies a synthetic T3 file without copying excluded values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    const secret = ['fixture', 'credential', 'canary', '7129'].join('_');
    const unknownValue = ['fixture', 'unknown', 'canary', '3681'].join('_');
    const sensitiveKey = `apiKey${'a'.repeat(24)}`;
    writeFileSync(input, JSON.stringify({ defaultAutoPull: true, github: secret, sidebarLayout: unknownValue, [sensitiveKey]: unknownValue, providerInstances: {} }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${secret}|${unknownValue}`));
    const report = JSON.parse(result.stdout);
    assert.equal(report.snapshot.defaultAutoPull, true);
    assert.equal(report.counts.excluded, 1);
    assert.equal(report.counts.unknown, 2);
    assert.ok(report.unknownKeys.includes('[redacted key name]'));
    assert.deepEqual(report.strictFailures, ['unknown', 'missing', 'differs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime policy controls persisted fields and exact top keys reject case variants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-policy-'));
  try {
    const scripts = join(dir, 'scripts');
    const t3 = join(dir, 't3');
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(scripts);
    mkdirSync(t3);
    mkdirSync(workspace);
    copyFileSync(helper, join(scripts, 'Install-T3Settings.ps1'));
    const policy = JSON.parse(readFileSync(join(root, 't3', 'allowlist.json'), 'utf8'));
    policy.drivers.claudeAgent.allowed = policy.drivers.claudeAgent.allowed.filter((key) => key !== 'launchArgs');
    writeFileSync(join(t3, 'allowlist.json'), JSON.stringify(policy));
    copyFileSync(join(root, 't3', 'defaults.json'), join(t3, 'defaults.json'));
    writeFileSync(input, JSON.stringify({ DefaultAutoPull: true, providerInstances: {
      claudeWorkspace: { driver: 'claudeAgent', config: { binaryPath: 'claude', launchArgs: '', LaunchArgs: 'private case variant' } },
    } }));
    const result = runReportWithHelper(input, workspace, join(scripts, 'Install-T3Settings.ps1'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.snapshot.DefaultAutoPull, undefined);
    assert.equal(report.snapshot.providerInstances['claude{Workspace}'].config.launchArgs, undefined);
    assert.ok(report.unknownKeys.includes('DefaultAutoPull'));
    assert.ok(report.unknownKeys.includes('providerInstances.claude{Workspace}.config.launchArgs'));
    assert.ok(report.unknownKeys.includes('providerInstances.claude{Workspace}.config.LaunchArgs'));
    assert.doesNotMatch(result.stdout, /private case variant/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown driver config and environment fields are counted without preserving their names or values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const secret = ['fixture', 'hidden', 'canary', '4792'].join('_');
    writeFileSync(input, JSON.stringify({ providerInstances: {
      'private-instance-label': { driver: 'fork-driver', enabled: true, environment: { 'PRIVATE_VAR': secret }, config: { 'authToken': secret, custom: secret } },
      'public-agent-name': { driver: 'claudeAgent', enabled: true, config: { binaryPath: 'claude', launchArgs: '' } },
    } }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${secret}|private-instance-label|public-agent-name|PRIVATE_VAR|authToken`));
    const report = JSON.parse(result.stdout);
    assert.equal(report.counts.environment, 1);
    assert.equal(report.snapshot.providerInstances.mapextra1.driver, undefined);
    assert.equal(report.snapshot.providerInstances.mapextra1.enabled, true);
    assert.equal(report.snapshot.providerInstances.mapextra1.config, undefined);
    assert.ok(report.drift.some((item) => item.state === 'unverifiable'));
    assert.ok(report.drift.some((item) => item.state === 'extra'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlisted wrong types and unapproved arguments are omitted and strict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const bait = ['fixture', 'free', 'text', 'canary', '8091'].join('_');
    writeFileSync(input, JSON.stringify({ defaultAutoPull: bait, providerInstances: { claudeWork: { driver: 'claudeAgent', enabled: true, config: { binaryPath: 'claude', launchArgs: `--plugin-dir ${bait}` } } } }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(bait));
    const report = JSON.parse(result.stdout);
    assert.equal(report.snapshot.defaultAutoPull, undefined);
    assert.equal(report.drift.find((entry) => entry.id === 'defaultAutoPull').state, 'unverifiable');
    assert.match(JSON.stringify(report.snapshot), /\{args: 2 tokens\}/);
    assert.ok(report.strictFailures.includes('unverifiable'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('path values normalize only reviewed workspace wrapper paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const wrapper = join(workspace, '.maxstack', 'bin', 'copilot.cmd');
    const outside = join(dir, 'outside', 'private.exe');
    writeFileSync(input, JSON.stringify({ providerInstances: { claudeWork: { driver: 'claudeAgent', enabled: true, config: { binaryPath: wrapper, launchArgs: '' } }, piWork: { driver: 'pi', enabled: true, config: { binaryPath: outside, launchArgs: '' } } } }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.match(JSON.stringify(report.snapshot), /\{workspace\}\/\.maxstack\/bin\/copilot\.cmd/);
    assert.match(JSON.stringify(report.snapshot), /\{path\}/);
    assert.doesNotMatch(JSON.stringify(report.snapshot), /private\.exe|outside/);
    assert.ok(report.strictFailures.includes('unverifiable'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict parser rejects duplicates, invalid UTF-8, deep input, and oversized files safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const cases = [
      ['duplicate', Buffer.from('{"defaultAutoPull":true,"defaultAutoPull":false}')],
      ['utf8', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])],
      ['deep', Buffer.from(`${'{"x":'.repeat(66)}0${'}'.repeat(66)}`)],
      ['large', Buffer.alloc(2 * 1024 * 1024 + 1, 32)],
    ];
    for (const [name, contents] of cases) {
      const input = join(dir, `${name}.json`);
      writeFileSync(input, contents);
      const result = runReport(input, workspace);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.ok(['malformed', 'unreadable'].includes(report.sourceState), `${name}: ${report.sourceState}`);
      assert.ok(report.strictFailures.includes('malformedSource'));
      assert.doesNotMatch(result.stdout + result.stderr, /\xff|line \d+|exception/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('absent and directory sources are informational and do not report missing instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const missing = runReport(join(dir, 'absent.json'), workspace);
    assert.equal(missing.status, 0, missing.stderr);
    const absentReport = JSON.parse(missing.stdout);
    assert.equal(absentReport.sourceState, 'missing');
    assert.deepEqual(absentReport.strictFailures, []);
    assert.deepEqual(absentReport.drift, []);
    const folder = join(dir, 'as-directory.json');
    mkdirSync(folder);
    const directory = runReport(folder, workspace);
    assert.equal(directory.status, 0, directory.stderr);
    assert.equal(JSON.parse(directory.stdout).sourceState, 'unreadable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UTF-8 BOM is accepted and invalid enum and retention values are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const text = JSON.stringify({ defaultAutoPull: true, responseStreamingMode: 'sentence', defaultRuntimeMode: 'web', storageCleanup: { worktreeAfterDays: 0, worktreeOnMerge: false, unexpected: true } });
    writeFileSync(input, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sourceState, 'present');
    assert.equal(report.snapshot.defaultAutoPull, true);
    assert.equal(report.snapshot.responseStreamingMode, undefined);
    assert.equal(report.snapshot.storageCleanup, undefined);
    assert.ok(report.strictFailures.includes('unverifiable'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all known drivers keep only their reviewed envelope and config fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const map = {
      claudeTest: { driver: 'claudeAgent', enabled: true, displayName: 'private label', accentColor: 'private color', config: { binaryPath: 'claude', launchArgs: '', homePath: 'private home', customModels: ['private model'], enabled: false } },
      codexTest: { driver: 'codex', enabled: false, config: { binaryPath: 'codex', launchArgs: '', shadowHomePath: 'private home', enabled: true } },
      piTest: { driver: 'pi', config: { binaryPath: 'pi', launchArgs: '' } },
      opencodeTest: { driver: 'opencode', config: { binaryPath: 'opencode', serverUrl: 'private host', serverPassword: 'private password' } },
      antigravityTest: { driver: 'antigravity', config: { binaryPath: 'antigravity', authMethod: 'private account' } },
      acpTest: { driver: 'acpRegistry', config: { source: 'registry', agentId: 'github-copilot-cli', distribution: 'auto', commandPath: 'copilot', commandArgs: ['--plugin-dir', join(workspace, '.claude', 'plugins')] } },
    };
    writeFileSync(input, JSON.stringify({ providerInstances: map }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const serialized = JSON.stringify(report.snapshot);
    for (const forbidden of ['private label', 'private color', 'private home', 'private model', 'private host', 'private password', 'private account', 'homePath', 'serverPassword', 'customModels', 'authMethod']) {
      assert.doesNotMatch(serialized, new RegExp(forbidden));
    }
    assert.equal(report.snapshot.providerInstances.mapextra1.config.agentId, 'github-copilot-cli');
    assert.deepEqual(report.snapshot.providerInstances.mapextra1.config.commandArgs, ['--plugin-dir', '{workspace}/.claude/plugins']);
    assert.equal(report.snapshot.providerInstances.mapextra2.config.binaryPath, 'antigravity');
    assert.equal(report.snapshot.providerInstances.mapextra3.config.binaryPath, 'claude');
    assert.equal(report.snapshot.providerInstances.mapextra4.config.binaryPath, 'codex');
    assert.equal(report.snapshot.providerInstances.mapextra5.config.binaryPath, 'opencode');
    assert.equal(report.snapshot.providerInstances.mapextra6.config.binaryPath, 'pi');
    assert.equal(report.snapshot.providerInstances.mapextra3.enabled, false);
    assert.equal(report.snapshot.providerInstances.mapextra6.enabled, false);
    assert.ok(report.counts.excluded >= 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot rules omit model selections and keep unknown property values private at random nesting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const secret = ['runtime', 'generated', 'canary', String(Math.floor(Math.random() * 1e9))].join('_');
    const keys = Array.from({ length: 12 }, (_, index) => `newNested${index}_${Math.floor(Math.random() * 1e6)}`);
    const instance = { driver: 'claudeAgent', enabled: true, config: {} };
    for (const key of keys) instance.config[key] = secret;
    writeFileSync(input, JSON.stringify({ defaultModelSelection: { instanceId: 'known', model: secret }, textGenerationModelSelection: { instanceId: 'known', model: secret }, providerInstances: { claudeTest: instance } }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    const report = JSON.parse(result.stdout);
    assert.equal(report.snapshot.defaultModelSelection, undefined);
    assert.equal(report.snapshot.textGenerationModelSelection, undefined);
    for (const key of keys) assert.ok(report.unknownKeys.some((name) => name.endsWith(key)));
    assert.ok(report.strictFailures.includes('unknown'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local T3 contract comparison accepts an explicit fixture source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const fixture = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 't3', 'server-settings-keys.json'), 'utf8'));
    const source = join(dir, 'settings.ts');
    const schema = fixture.keys.map((key) => `  ${key}: Schema.optionalKey(Schema.Unknown),`).join('\n');
    const allowlist = JSON.parse(readFileSync(join(root, 't3', 'allowlist.json'), 'utf8'));
    const schemaNames = { claudeAgent: 'ClaudeSettings', codex: 'CodexSettings', pi: 'PiSettings', opencode: 'OpenCodeSettings', antigravity: 'AntigravitySettings', acpRegistry: 'AcpRegistrySettings' };
    const providerSchemas = Object.entries(schemaNames).map(([driver, name]) => `export const ${name} = Schema.Struct({ enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(${allowlist.driverEnabledDefaults[driver]}))) });`).join('\n');
    const legacyDrivers = ['claudeAgent', 'codex', 'pi', 'opencode', 'antigravity'].map((driver) => `    ${driver}: Schema.Unknown,`).join('\n');
    writeFileSync(source, `${providerSchemas}\nexport const ServerSettings = Schema.Struct({\n${schema}\n  providers: Schema.Struct({\n${legacyDrivers}\n  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),\n});\n`);
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
    const python = spawnSync('python', [join(root, 'scripts', 'verify-manifests.py'), '--t3-contract', source], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('known driver config fields reject nested unknowns and ACP IDs stay closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const value = ['fixture', 'nested', 'canary', String(Math.floor(Math.random() * 1e9))].join('_');
    const drivers = ['claudeAgent', 'codex', 'pi', 'opencode', 'antigravity', 'acpRegistry'];
    const providers = Object.fromEntries(drivers.map((driver, index) => [`instance-${index}`, { driver, enabled: true, config: { newDriverField: value, ...(driver === 'acpRegistry' ? { agentId: value } : {}) } }]));
    writeFileSync(input, JSON.stringify({ providerInstances: providers }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(value));
    const report = JSON.parse(result.stdout);
    assert.ok(report.unknownKeys.length >= drivers.length);
    assert.ok(report.strictFailures.includes('unknown'));
    assert.doesNotMatch(JSON.stringify(report.snapshot), /newDriverField|instance-[0-9]|agentId/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACP config policy withdrawal blocks every copied field before normalization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-acp-policy-'));
  try {
    const scripts = join(dir, 'scripts');
    const t3 = join(dir, 't3');
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(scripts);
    mkdirSync(t3);
    mkdirSync(workspace);
    copyFileSync(helper, join(scripts, 'Install-T3Settings.ps1'));
    copyFileSync(join(root, 't3', 'defaults.json'), join(t3, 'defaults.json'));
    const values = { source: 'registry', distribution: 'auto', agentId: 'github-copilot-cli', commandPath: 'copilot', commandArgs: [] };
    const canary = ['fixture', 'acp', 'field', 'canary', String(Math.floor(Math.random() * 1e9))].join('_');
    for (const field of Object.keys(values)) {
      const policy = JSON.parse(readFileSync(join(root, 't3', 'allowlist.json'), 'utf8'));
      policy.drivers.acpRegistry.allowed = policy.drivers.acpRegistry.allowed.filter((key) => key !== field);
      writeFileSync(join(t3, 'allowlist.json'), JSON.stringify(policy));
      const config = { ...values, [field]: field === 'commandArgs' ? ['--plugin-dir', canary] : field === 'commandPath' ? canary : values[field] };
      writeFileSync(input, JSON.stringify({ providerInstances: { copilotWork: { driver: 'acpRegistry', config } } }));
      const result = runReportWithHelper(input, workspace, join(scripts, 'Install-T3Settings.ps1'));
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(canary));
      const report = JSON.parse(result.stdout);
      assert.equal(report.snapshot.providerInstances.mapextra1.config?.[field], undefined, `${field} must not be persisted after policy withdrawal`);
      assert.ok(report.unknownKeys.includes(`providerInstances.mapextra1.config.${field}`), `${field} should be classified as unknown`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('null enum handling distinguishes nonnullable fields from approved nullable fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-null-enums-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    writeFileSync(input, JSON.stringify({ responseStreamingMode: null, branchNamingMode: null, defaultRuntimeMode: null, defaultThreadEnvMode: null, pullRequestMergeMethod: null }));
    const result = runReport(input, workspace, true);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    for (const field of ['responseStreamingMode', 'branchNamingMode', 'defaultRuntimeMode']) {
      assert.equal(report.snapshot[field], undefined);
      assert.ok(report.unverifiableKeys.includes(field));
    }
    assert.equal(report.snapshot.defaultThreadEnvMode, null);
    assert.equal(report.snapshot.pullRequestMergeMethod, null);
    assert.equal(report.counts.unverifiable, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('providerInstances top policy controls map copying and classification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-top-policy-'));
  try {
    const scripts = join(dir, 'scripts');
    const t3 = join(dir, 't3');
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(scripts);
    mkdirSync(t3);
    mkdirSync(workspace);
    copyFileSync(helper, join(scripts, 'Install-T3Settings.ps1'));
    copyFileSync(join(root, 't3', 'defaults.json'), join(t3, 'defaults.json'));
    const secret = ['fixture', 'provider', 'map', 'canary', String(Math.floor(Math.random() * 1e9))].join('_');
    writeFileSync(input, JSON.stringify({ providerInstances: { synthetic: { driver: 'pi', enabled: true, config: { privateValue: secret } } } }));
    for (const classification of ['unknown', 'excluded']) {
      const policy = JSON.parse(readFileSync(join(root, 't3', 'allowlist.json'), 'utf8'));
      delete policy.top.providerInstances;
      if (classification === 'excluded') policy.excluded.providerInstances = 'fixture exclusion';
      writeFileSync(join(t3, 'allowlist.json'), JSON.stringify(policy));
      const result = runReportWithHelper(input, workspace, join(scripts, 'Install-T3Settings.ps1'));
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
      const report = JSON.parse(result.stdout);
      assert.equal(report.snapshot.providerInstances, undefined);
      assert.equal(report.counts[classification], 1);
      assert.equal(report.counts.unverifiable, 0);
      assert.equal(report.counts.unknown, classification === 'unknown' ? 1 : 0);
      assert.equal(report.counts.excluded, classification === 'excluded' ? 1 : 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runProviderEnvelopePolicyCase(field, classification) {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-envelope-policy-'));
  try {
    const scripts = join(dir, 'scripts');
    const t3 = join(dir, 't3');
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(scripts);
    mkdirSync(t3);
    mkdirSync(workspace);
    copyFileSync(helper, join(scripts, 'Install-T3Settings.ps1'));
    copyFileSync(join(root, 't3', 'defaults.json'), join(t3, 'defaults.json'));
    const secret = ['fixture', 'envelope', 'canary', String(Math.floor(Math.random() * 1e9))].join('_');
    const policy = JSON.parse(readFileSync(join(root, 't3', 'allowlist.json'), 'utf8'));
    policy.providerEnvelope.allowed = policy.providerEnvelope.allowed.filter((key) => key !== field);
    Object.assign(policy.providerEnvelope.excluded, classification === 'excluded' ? { [field]: 'fixture exclusion' } : {});
    writeFileSync(join(t3, 'allowlist.json'), JSON.stringify(policy));
    const instance = { driver: 'claudeAgent', enabled: true, config: { binaryPath: 'claude', launchArgs: '' } };
    instance[field] = field === 'config' ? { privateValue: secret } : secret;
    writeFileSync(input, JSON.stringify({ providerInstances: { synthetic: instance } }));
    const result = runReportWithHelper(input, workspace, join(scripts, 'Install-T3Settings.ps1'));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    const report = JSON.parse(result.stdout);
    const safe = report.snapshot.providerInstances.mapextra1;
    assert.equal(safe[field], undefined, `${field} must not be persisted after policy withdrawal`);
    assert.equal(report.counts[classification], 1);
    assert.equal(report.counts.unknown, classification === 'unknown' ? 1 : 0);
    assert.equal(report.counts.excluded, classification === 'excluded' ? 1 : 0);
    if (field === 'config') assert.equal(safe.config, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('provider envelope policy controls driver enabled and config copying', () => {
  for (const field of ['driver', 'enabled', 'config']) {
    for (const classification of ['unknown', 'excluded']) runProviderEnvelopePolicyCase(field, classification);
  }
});

test('command path normalization rejects sibling prefixes and traversal, while handling case and extended prefixes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const wrapper = join(workspace, '.maxstack', 'bin', 'copilot.cmd');
    const sibling = `${workspace}-backup/.maxstack/bin/copilot.cmd`;
    const values = [wrapper.toUpperCase().replaceAll('\\', '/'), `\\\\?\\${wrapper}`, sibling, `${workspace}/../outside/copilot.cmd`, '.maxstack/bin/copilot.cmd'];
    const instances = Object.fromEntries(values.map((binaryPath, index) => [`path-${index}`, { driver: 'codex', config: { binaryPath, launchArgs: '' } }]));
    writeFileSync(input, JSON.stringify({ providerInstances: instances }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const serialized = JSON.stringify(JSON.parse(result.stdout).snapshot);
    assert.equal((serialized.match(/\{workspace\}\/\.maxstack\/bin\/copilot\.cmd/g) ?? []).length, 2);
    assert.equal((serialized.match(/\{path\}/g) ?? []).length, 3);
    assert.doesNotMatch(serialized, /backup|outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launchArgs accepts the workspace plugin root and refuses paths outside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const input = join(dir, 'settings.json');
    const workspace = join(dir, 'workspace with spaces');
    const plugins = join(workspace, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const outside = join(dir, 'outside', 'plugins');
    mkdirSync(outside, { recursive: true });
    writeFileSync(input, JSON.stringify({ providerInstances: {
      claudeWorkspaceWithSpaces: { driver: 'claudeAgent', config: { binaryPath: 'claude', launchArgs: `--plugin-dir "${plugins}"` } },
      piWorkspaceWithSpaces: { driver: 'pi', config: { binaryPath: 'pi', launchArgs: `--plugin-dir "${outside}"` } },
    } }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout).snapshot;
    assert.equal(snapshot.providerInstances['claude{Workspace}'].config.launchArgs, '--plugin-dir {workspace}/.claude/plugins');
    assert.match(snapshot.providerInstances['pi{Workspace}'].config.launchArgs, /\{args: 2 tokens\}/);
    assert.equal(JSON.parse(result.stdout).drift.find((item) => item.id === 'claude{Workspace}').state, 'matching');
    assert.doesNotMatch(JSON.stringify(snapshot), /outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy config enabled folds into the envelope with false winning and stable canonical output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const firstPath = join(dir, 'first.json');
    const secondPath = join(dir, 'second.json');
    writeFileSync(firstPath, JSON.stringify({ providerInstances: { claudeWorkspace: { driver: 'claudeAgent', config: { enabled: true, binaryPath: 'claude', launchArgs: '' } }, piWorkspace: { driver: 'pi', enabled: true, config: { enabled: false, binaryPath: 'pi', launchArgs: '' } } } }));
    writeFileSync(secondPath, JSON.stringify({ providerInstances: { claudeWorkspace: { driver: 'claudeAgent', enabled: true, config: { binaryPath: 'claude', launchArgs: '' } }, piWorkspace: { driver: 'pi', enabled: false, config: { binaryPath: 'pi', launchArgs: '' } } } }));
    const first = runReport(firstPath, workspace);
    const second = runReport(secondPath, workspace);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const left = JSON.parse(first.stdout).snapshot;
    const right = JSON.parse(second.stdout).snapshot;
    assert.deepEqual(left, right);
    assert.equal(left.providerInstances['claude{Workspace}'].enabled, true);
    assert.equal(left.providerInstances['pi{Workspace}'].enabled, false);
    assert.equal(left.providerInstances['claude{Workspace}'].config.enabled, undefined);
    assert.equal(left.providerInstances['pi{Workspace}'].config.enabled, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift report emits matching, differs, missing, unset, unverifiable, extra, unknown, and excluded states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, '.claude', 'plugins'), { recursive: true });
    const input = join(dir, 'settings.json');
    const providers = {
      claudeWorkspace: { driver: 'claudeAgent', enabled: true, config: { binaryPath: 'claude', launchArgs: `--plugin-dir ${join(workspace, '.claude', 'plugins')}` } },
      copilotWorkspace: { driver: 'acpRegistry', enabled: true, config: { source: 'registry', agentId: 'github-copilot-cli', distribution: 'auto', commandPath: join(workspace, '.maxstack', 'bin', 'copilot.cmd') } },
      piWorkspace: { driver: 'pi', enabled: true, config: { binaryPath: join(workspace, '.maxstack', 'bin', 'pi.cmd'), launchArgs: '' } },
      codexUser: { driver: 'codex', enabled: true, config: { binaryPath: 'codex', launchArgs: '' } },
    };
    const live = { defaultAutoPull: false, responseStreamingMode: 'sentence', github: { token: 'hidden' }, unknownSetting: 'hidden', providerInstances: providers };
    writeFileSync(input, JSON.stringify(live));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const states = Object.fromEntries(report.drift.map((item) => [item.id, item.state]));
    assert.equal(states['claude{Workspace}'], 'matching');
    assert.equal(states['copilot{Workspace}'], 'matching');
    assert.equal(states['pi{Workspace}'], 'matching');
    assert.equal(states.defaultAutoPull, 'differs');
    assert.equal(report.drift.find((item) => item.id === 'defaultAutoPull').wanted, true);
    assert.equal(report.drift.find((item) => item.id === 'defaultAutoPull').observed, false);
    assert.equal(states.defaultThreadEnvMode, 'differs');
    assert.ok(report.drift.some((item) => item.state === 'extra'));
    assert.ok(report.strictFailures.includes('differs'));
    assert.ok(report.strictFailures.includes('unknown'));
    assert.ok(report.strictFailures.includes('unverifiable'));
    assert.doesNotMatch(result.stdout + result.stderr, /hidden|codexUser/);

    delete live.providerInstances.piWorkspace;
    live.providerInstances.claudeWorkspace.config.launchArgs = '--api-key private-value';
    writeFileSync(input, JSON.stringify(live));
    const changed = JSON.parse(runReport(input, workspace).stdout);
    const changedStates = Object.fromEntries(changed.drift.map((item) => [item.id, item.state]));
    assert.equal(changedStates['pi{Workspace}'], 'missing');
    assert.equal(changedStates['claude{Workspace}'], 'unverifiable');
    assert.ok(changed.strictFailures.includes('missing'));
    assert.doesNotMatch(JSON.stringify(changed), /private-value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace instance suffixes start with a letter and stay within the documented limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, `9-${'a'.repeat(80)}`);
    mkdirSync(workspace);
    const input = join(dir, 'settings.json');
    writeFileSync(input, JSON.stringify({ providerInstances: {} }));
    const report = JSON.parse(runReport(input, workspace).stdout);
    const id = report.drift.find((item) => item.id.startsWith('claude'))?.id;
    assert.ok(id);
    assert.equal(id, 'claude{Workspace}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an inaccessible source handle is reported without exposing the I/O error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    writeFileSync(input, JSON.stringify({ providerInstances: {} }));
    const escapedHelper = helper.replaceAll("'", "''");
    const escapedInput = input.replaceAll("'", "''");
    const escapedWorkspace = workspace.replaceAll("'", "''");
    const command = `. '${escapedHelper}'; $held = [IO.File]::Open('${escapedInput}', 'Open', 'ReadWrite', 'None'); try { Get-T3SettingsReport -Path '${escapedInput}' -Workspace '${escapedWorkspace}' | ConvertTo-Json -Depth 64 -Compress } finally { $held.Dispose() }`;
    const env = { ...process.env };
    delete env.MAXSTACK_T3_SETTINGS;
    delete env.T3CODE_HOME;
    const result = spawnSync(shell, ['-NoProfile', '-Command', command], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sourceState, 'unreadable');
    assert.doesNotMatch(result.stdout + result.stderr, /sharing violation|exception|path/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sparse providers work with Stop, reject array ACP ids, and redact token-shaped names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    const canary = ['probe', 'array', 'secret', String(Math.random())].join('_');
    const hexKey = 'ab'.repeat(24);
    writeFileSync(input, JSON.stringify({
      providerInstances: {
        sparse: { driver: 'claudeAgent', config: { binaryPath: 'claude', launchArgs: '' } },
        acp: { driver: 'acpRegistry', config: { agentId: ['github-copilot-cli', canary] } },
        wrongDriver: { driver: ['acpRegistry', canary], config: { agentId: 'github-copilot-cli' } },
      },
      [hexKey]: canary,
    }));
    const result = runReport(input, workspace, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${canary}|${hexKey}`));
    const report = JSON.parse(result.stdout);
    assert.equal(report.snapshot.providerInstances.mapextra1.driver, 'acpRegistry');
    assert.equal(report.snapshot.providerInstances.mapextra1.config?.agentId, undefined);
    assert.equal(report.snapshot.providerInstances.mapextra3.driver, undefined);
    assert.equal(report.snapshot.providerInstances.mapextra3.config, undefined);
    assert.ok(report.strictFailures.includes('unverifiable'));
    assert.ok(report.unknownKeys.includes('[redacted key name]'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown credential key names redact before truncation and across punctuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-key-name-'));
  try {
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    const entropy = Array.from({ length: 32 }, (_, index) => ((index * 7 + 3) % 16).toString(16)).join('');
    const embedded = Array.from({ length: 40 }, (_, index) => String.fromCharCode(65 + ((index * 11 + 5) % 26))).join('');
    const longPrefix = `prefix-${'x-'.repeat(50)}-apiKey:${entropy}`;
    const credentialName = `metadata:${embedded}:credential/${entropy}`;
    const ordinary = 'zzNewKey';
    writeFileSync(input, JSON.stringify({ [longPrefix]: 'private', [credentialName]: 'private', [ordinary]: 'private', providerInstances: {} }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${entropy}|${embedded}`));
    assert.equal(report.unknownKeys.filter((name) => name === '[redacted key name]').length, 2);
    assert.ok(!report.unknownKeys.includes(longPrefix.slice(0, 80)));
    assert.ok(!report.unknownKeys.includes(credentialName));
    assert.ok(report.unknownKeys.includes('zzNewKey'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider instances, configs, and ACP argument shapes fail closed without leaking values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-shapes-'));
  try {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const input = join(dir, 'settings.json');
    const badPath = join(workspace, '.claude', `plugins${String.fromCharCode(0)}${['fixture', 'path', String(Math.random())].join('_')}`);
    const fixtures = [
      { providerInstances: 'private provider map' },
      { providerInstances: { badInstance: ['private instance'] } },
      { providerInstances: { badConfig: { driver: 'claudeAgent', config: 'private config' } } },
      { providerInstances: { badLaunchType: { driver: 'claudeAgent', config: { launchArgs: ['--plugin-dir', badPath] } } } },
      { providerInstances: { badLaunchSyntax: { driver: 'claudeAgent', config: { launchArgs: '--other private-argument' } } } },
      { providerInstances: { badAcpArgsType: { driver: 'acpRegistry', config: { agentId: 'github-copilot-cli', commandArgs: 'private argument' } } } },
      { providerInstances: { badAcpArgsFlag: { driver: 'acpRegistry', config: { agentId: 'github-copilot-cli', commandArgs: ['--other', join(workspace, '.claude', 'plugins')] } } } },
      { providerInstances: { badAcpArgsPath: { driver: 'acpRegistry', config: { agentId: 'github-copilot-cli', commandArgs: ['--plugin-dir', 7] } } } },
      { providerInstances: { badAcpId: { driver: 'acpRegistry', config: { agentId: 'fixture-agent', commandArgs: [] } } } },
    ];
    for (const fixture of fixtures) {
      writeFileSync(input, JSON.stringify(fixture));
      const result = runReport(input, workspace, true);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.doesNotMatch(result.stdout + result.stderr, /private provider map|private instance|private config|private argument|fixture-agent/);
      assert.ok(JSON.parse(result.stdout).strictFailures.includes('unverifiable'));
    }

    writeFileSync(input, JSON.stringify({ providerInstances: { copilotExtra: { driver: 'acpRegistry', config: { agentId: 'github-copilot-cli', commandArgs: ['--plugin-dir', join(workspace, '.claude', 'plugins')] } } } }));
    const valid = JSON.parse(runReport(input, workspace).stdout);
    assert.deepEqual(valid.snapshot.providerInstances.mapextra1.config.commandArgs, ['--plugin-dir', '{workspace}/.claude/plugins']);

    const expectedArgs = "$script:T3DefaultsTemplate.instances['copilot{Workspace}'].config.commandArgs = @('--plugin-dir', '{workspace}/.claude/plugins')";
    writeFileSync(input, JSON.stringify({ providerInstances: { copilotWorkspace: { driver: 'acpRegistry', enabled: true, config: { source: 'registry', agentId: 'github-copilot-cli', distribution: 'auto', commandPath: join(workspace, '.maxstack', 'bin', 'copilot.cmd'), commandArgs: ['--plugin-dir', join(workspace, '.claude', 'plugins')] } } } }));
    const known = JSON.parse(runReportWithHelper(input, workspace, helper, false, expectedArgs).stdout);
    assert.deepEqual(known.snapshot.providerInstances['copilot{Workspace}'].config.commandArgs, ['--plugin-dir', '{workspace}/.claude/plugins']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('known driver defaults fill missing config fields and unknown wanted fields stay unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-config-defaults-'));
  try {
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    writeFileSync(input, JSON.stringify({ providerInstances: { claudeWorkspace: { driver: 'claudeAgent', enabled: true, config: {} } } }));
    const withDefaults = JSON.parse(runReport(input, workspace).stdout);
    const defaultDrift = withDefaults.drift.find((entry) => entry.id === 'claude{Workspace}');
    assert.equal(defaultDrift.state, 'differs');
    assert.equal(defaultDrift.observed.config, undefined);
    assert.equal(defaultDrift.wanted.config.binaryPath, 'claude');

    const preamble = "$script:T3DefaultsTemplate.instances['claude{Workspace}'].config.launchArgs = ''; $script:T3DefaultsTemplate.instances['claude{Workspace}'].config.unlistedFixtureField = 'fixture value'";
    const withUnknownWantedField = JSON.parse(runReportWithHelper(input, workspace, helper, false, preamble).stdout);
    assert.equal(withUnknownWantedField.drift.find((entry) => entry.id === 'claude{Workspace}').state, 'differs');
    assert.equal(withUnknownWantedField.drift.find((entry) => entry.id === 'claude{Workspace}').observed.config, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin path parsing rejects invalid syntax and returns stale on snapshot read failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-read-failures-'));
  try {
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    const invalidPluginPath = join(workspace, '.claude', `plugins${String.fromCharCode(0)}fixture`);
    writeFileSync(input, JSON.stringify({ providerInstances: { invalidPath: { driver: 'claudeAgent', config: { launchArgs: `--plugin-dir "${invalidPluginPath}"` } } } }));
    const invalidPath = JSON.parse(runReport(input, workspace).stdout);
    assert.match(invalidPath.snapshot.providerInstances.mapextra1.config.launchArgs, /\{args: 2 tokens\}/);

    const snapshot = join(workspace, '.maxstack', 't3', 'settings.snapshot.json');
    mkdirSync(join(workspace, '.maxstack', 't3'), { recursive: true });
    writeFileSync(snapshot, '{}\n');
    const code = `. '${helper.replaceAll("'", "''")}'; $held = [IO.File]::Open('${snapshot.replaceAll("'", "''")}', 'Open', 'ReadWrite', 'None'); try { Get-T3SettingsReport -Path '${input.replaceAll("'", "''")}' -Workspace '${workspace.replaceAll("'", "''")}' | ConvertTo-Json -Depth 64 -Compress } finally { $held.Dispose() }`;
    const env = { ...process.env };
    delete env.MAXSTACK_T3_SETTINGS;
    delete env.T3CODE_HOME;
    const result = spawnSync(shell, ['-NoProfile', '-Command', code], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).stale, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace wrapper paths fail closed when the workspace cannot be resolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-workspace-path-'));
  try {
    const workspace = join(dir, 'missing-workspace');
    const input = join(dir, 'settings.json');
    writeFileSync(input, JSON.stringify({ providerInstances: { copilotMissingWorkspace: { driver: 'acpRegistry', config: { commandPath: join(workspace, '.maxstack', 'bin', 'copilot.cmd') } } } }));
    const report = JSON.parse(runReport(input, workspace).stdout);
    assert.equal(report.snapshot.providerInstances['copilot{Workspace}'].config.commandPath, '{path}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage cleanup policy copies valid nullable values and reports unknowns with wrong types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-storage-'));
  try {
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    const canary = ['nested', 'fixture', String(Math.random())].join('_');
    writeFileSync(input, JSON.stringify({
      storageCleanup: { worktreeAfterDays: null, worktreeOnMerge: false, worktreeOnDelete: true, worktreeUnchanged: false, browserArtifactsAfterDays: 3650, logsAfterDays: 1 },
    }));
    const valid = runReport(input, workspace);
    assert.equal(valid.status, 0, valid.stderr);
    const value = JSON.parse(valid.stdout).snapshot.storageCleanup;
    assert.deepEqual(value, { worktreeAfterDays: null, worktreeOnMerge: false, worktreeOnDelete: true, worktreeUnchanged: false, browserArtifactsAfterDays: 3650, logsAfterDays: 1 });

    writeFileSync(input, JSON.stringify({ storageCleanup: { worktreeAfterDays: canary, logsAfterDays: 0, newCleanupKey: canary, WorktreeOnMerge: true } }));
    const invalid = runReport(input, workspace);
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, new RegExp(canary));
    const report = JSON.parse(invalid.stdout);
    assert.equal(report.snapshot.storageCleanup, undefined);
    assert.ok(report.unknownKeys.includes('storageCleanup.newCleanupKey'));
    assert.ok(report.unknownKeys.includes('storageCleanup.WorktreeOnMerge'));
    assert.ok(report.strictFailures.includes('unverifiable'));
    assert.ok(report.strictFailures.includes('unknown'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed provider maps and values report unverifiable states instead of missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-provider-shape-'));
  try {
    const workspace = join(dir, 'workspace');
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    writeFileSync(input, JSON.stringify({ providerInstances: 'private provider payload' }));
    const map = JSON.parse(runReport(input, workspace).stdout);
    assert.equal(map.drift.find((item) => item.id === 'claude{Workspace}').state, 'unverifiable');
    assert.equal(map.drift.some((item) => item.state === 'missing'), false);
    assert.doesNotMatch(JSON.stringify(map), /private provider payload/);

    writeFileSync(input, JSON.stringify({ providerInstances: { claudeWorkspace: 37 } }));
    const value = JSON.parse(runReport(input, workspace).stdout);
    assert.equal(value.drift.find((item) => item.id === 'claude{Workspace}').state, 'unverifiable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('null declared defaults differ from requested defaults and known ids are templated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, `marker-${['credential', String(Math.random())].join('_')}`);
    const input = join(dir, 'settings.json');
    mkdirSync(workspace);
    const slug = workspace.split(/[\\/]/).at(-1).split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
    writeFileSync(input, JSON.stringify({ providerInstances: {
      [`claude${slug}`]: { driver: 'claudeAgent', config: { binaryPath: 'claude', launchArgs: `--plugin-dir "${join(workspace, '.claude', 'plugins')}"` } },
    } }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.drift.find((entry) => entry.id === 'defaultThreadEnvMode').state, 'differs');
    assert.doesNotMatch(result.stdout + result.stderr, /marker-|credential/);
    assert.ok(report.snapshot.providerInstances['claude{Workspace}']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot temp path cannot be preplanted and escaping plugin junctions are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-'));
  try {
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    mkdirSync(join(workspace, '.maxstack', 't3'), { recursive: true });
    mkdirSync(outside);
    const input = join(dir, 'settings.json');
    writeFileSync(input, JSON.stringify({ providerInstances: {} }));
    const destination = join(workspace, '.maxstack', 't3', 'settings.snapshot.json.maxstack-tmp');
    writeFileSync(destination, 'planted');
    const helperPath = helper.replaceAll("'", "''");
    const inputPath = input.replaceAll("'", "''");
    const workspacePath = workspace.replaceAll("'", "''");
    const code = `. '${helperPath}'; $report = Get-T3SettingsReport -Path '${inputPath}' -Workspace '${workspacePath}'; try { $null = Write-T3Snapshot -Workspace '${workspacePath}' -Report $report; 'unexpected' } catch { 'refused' }`;
    const env = { ...process.env };
    delete env.MAXSTACK_T3_SETTINGS;
    delete env.T3CODE_HOME;
    const result = spawnSync(shell, ['-NoProfile', '-Command', code], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /refused/);
    assert.equal(readFileSync(destination, 'utf8'), 'planted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('physical link targets stay inside the workspace for wrappers and plugin arguments', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-t3-links-'));
  try {
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    const input = join(dir, 'settings.json');
    mkdirSync(join(workspace, '.maxstack'), { recursive: true });
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(workspace, '.maxstack', 'bin'), 'junction');
      symlinkSync(outside, join(workspace, '.claude', 'plugins'), 'junction');
    } catch (error) {
      t.skip(`junction creation is unavailable: ${error.code ?? error.message}`);
      return;
    }
    writeFileSync(input, JSON.stringify({ providerInstances: {
      command: { driver: 'codex', config: { binaryPath: join(workspace, '.maxstack', 'bin', 'copilot.cmd'), launchArgs: '' } },
      plugins: { driver: 'claudeAgent', config: { binaryPath: 'claude', launchArgs: `--plugin-dir "${join(workspace, '.claude', 'plugins')}"` } },
    } }));
    const result = runReport(input, workspace);
    assert.equal(result.status, 0, result.stderr);
    const serialized = JSON.stringify(JSON.parse(result.stdout).snapshot);
    assert.match(serialized, /\{path\}/);
    assert.match(serialized, /\{args: 2 tokens\}/);
    assert.doesNotMatch(serialized + result.stderr, /outside/);

    const insideWorkspace = join(dir, 'inside-workspace');
    const target = join(insideWorkspace, '.opencode', 'plugins');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(insideWorkspace, '.claude'), { recursive: true });
    symlinkSync(target, join(insideWorkspace, '.claude', 'plugins'), 'junction');
    const insideInput = join(dir, 'inside.json');
    writeFileSync(insideInput, JSON.stringify({ providerInstances: {
      claudeInsideWorkspace: { driver: 'claudeAgent', config: { binaryPath: 'claude', launchArgs: `--plugin-dir "${join(insideWorkspace, '.claude', 'plugins')}"` } },
    } }));
    const inside = runReport(insideInput, insideWorkspace);
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(JSON.parse(inside.stdout).snapshot.providerInstances['claude{Workspace}'].config.launchArgs, '--plugin-dir {workspace}/.claude/plugins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
