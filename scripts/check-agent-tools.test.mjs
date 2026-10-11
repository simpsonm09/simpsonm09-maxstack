#!/usr/bin/env node
// Prove the agent-tool parity check fails and names the uncovered owner when an
// agent tool is missing, passes when every owner is covered or exempt, and
// passes against the current workspace when the sibling checkouts exist.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeOwner } from './check-agent-tools.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'check-agent-tools.mjs');
const registryRel = join('skills', 'service-integrations', 'SKILL.md');

function buildDevSetup(ids) {
  const lines = ['tools:'];
  for (const id of ids) {
    lines.push(`  - id: ${id}`, '    consumers:', '      - human', '      - agent');
  }
  return `${lines.join('\n')}\n`;
}

function buildSkill(rows) {
  const lines = ['# Service integrations', '', '## Pick the owner', '', '| Job | Owner | Command |', '| --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.job} | ${row.owner} | ${row.command} |`);
  return `${lines.join('\n')}\n`;
}

function buildFixtures({ ids, rows }) {
  const base = mkdtempSync(join(tmpdir(), 'agent-parity-'));
  const devSetup = join(base, 'dev-setup');
  const orgPlugin = join(base, 'org-plugin');
  mkdirSync(devSetup, { recursive: true });
  mkdirSync(dirname(join(orgPlugin, registryRel)), { recursive: true });
  writeFileSync(join(devSetup, 'tools.yaml'), buildDevSetup(ids));
  writeFileSync(join(orgPlugin, registryRel), buildSkill(rows));
  return { base, devSetup, orgPlugin };
}

function runCheck(devSetup, orgPlugin) {
  const args = [script, '--dev-setup', devSetup, '--org-plugin', orgPlugin];
  return spawnSync(process.execPath, args, { windowsHide: true, encoding: 'utf8', cwd: repoRoot });
}

test('normalizeOwner drops npx and a leading at-sign, and takes the first command word', () => {
  assert.equal(normalizeOwner('`npx ctx7`', '`npx ctx7 library`'), 'ctx7');
  assert.equal(normalizeOwner('`gh search code`', '`gh search code "<p>"`'), 'gh');
  assert.equal(normalizeOwner('`@playwright/cli`', '`playwright-cli open`'), 'playwright/cli');
  assert.equal(normalizeOwner('the container runtime', '`docker ps`'), 'docker');
});

test('a missing agent tool fails and names the uncovered owner', () => {
  const { base, devSetup, orgPlugin } = buildFixtures({
    ids: ['gh', 'newman', 'ctx7'],
    rows: [
      { job: 'GitHub', owner: '`gh`', command: '`gh pr view`' },
      { job: 'Library docs', owner: '`npx ctx7`', command: '`npx ctx7 library`' },
      { job: 'Scan', owner: '`trivy`', command: '`trivy fs .`' },
    ],
  });
  try {
    const run = runCheck(devSetup, orgPlugin);
    assert.equal(run.status, 1, `expected a non-zero exit\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /service owner "trivy" is not covered/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('aliases and exemptions cover every owner', () => {
  const { base, devSetup, orgPlugin } = buildFixtures({
    ids: ['gh', 'newman', 'ctx7', 'postman-cli', 'playwright-cli', 'docker'],
    rows: [
      { job: 'GitHub', owner: '`gh`', command: '`gh pr view`' },
      { job: 'Collection runs', owner: '`newman`', command: '`newman run`' },
      { job: 'Library docs', owner: '`npx ctx7`', command: '`npx ctx7 library`' },
      { job: 'Postman cloud', owner: '`postman`', command: '`postman collection get`' },
      { job: 'Browser', owner: '`@playwright/cli`', command: '`playwright-cli open`' },
      { job: 'Local search', owner: 'the `grep` tool', command: '`grep x`' },
      { job: 'Containers', owner: '`docker`', command: '`docker ps`' },
    ],
  });
  try {
    const run = runCheck(devSetup, orgPlugin);
    assert.equal(run.status, 0, `expected a zero exit\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /postman -> postman-cli/);
    assert.match(run.stdout, /PASS/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('docker is required, not exempt, and fails when the agent tool set lacks it', () => {
  const { base, devSetup, orgPlugin } = buildFixtures({
    ids: ['gh'],
    rows: [{ job: 'Containers', owner: '`docker`', command: '`docker ps`' }],
  });
  try {
    const run = runCheck(devSetup, orgPlugin);
    assert.equal(run.status, 1, `expected a non-zero exit\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /service owner "docker" is not covered/);
    assert.doesNotMatch(run.stdout, /docker \(exempt/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function findWorkspaceRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'opencode.jsonc')) || existsSync(join(dir, '.opencode'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(repoRoot);
const devSetupFile = workspaceRoot && join(workspaceRoot, 'projects', 'repos', 'simpsonm09-dev-setup', 'tools.yaml');
const orgPluginFile =
  workspaceRoot && join(workspaceRoot, 'projects', 'repos', 'simpsonm09-org-ai-plugin', registryRel);
const hasSiblings = Boolean(devSetupFile && orgPluginFile && existsSync(devSetupFile) && existsSync(orgPluginFile));

test(
  'the current workspace passes',
  { skip: hasSiblings ? false : 'the sibling checkouts are not present' },
  () => {
    const run = spawnSync(process.execPath, [script], { windowsHide: true, encoding: 'utf8', cwd: repoRoot });
    assert.equal(run.status, 0, `expected a zero exit\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS: the agent tool set covers every service owner/);
  },
);
