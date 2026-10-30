import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeLayer, runGenerator, succeeds, treeBytes, withTemp } from './generate-layers.test-helpers.mjs';

const runtimes = [
  { name: 'claude', path: '.claude/plugins/sample/skills/sample/SKILL.md' },
  { name: 'copilot', path: '.claude/plugins/sample/skills/sample/SKILL.md' },
  { name: 'opencode', path: '.opencode/skills/sample/SKILL.md' },
  { name: 'pi', path: '.pi/agent/skills/sample/SKILL.md' },
  { name: 'cursor', path: '.cursor/skills/sample/SKILL.md' },
];

const nonCommonKeys = {
  license: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
  compatibility: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
  metadata: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
  'allowed-tools': { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
  'user-invocable': {
    claude: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
    copilot: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
    opencode: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
    pi: { status: 'ignored', evidence: 'docs/parity-matrix.md, PSC-PI S07a.' },
    cursor: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
    codex: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
    antigravity: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
  },
  paths: { status: 'unknown', evidence: 'No harness interpretation evidence recorded.' },
  'future-key': { status: 'unknown', evidence: 'Synthetic regression sentinel; no harness interpretation evidence.' },
};

const skill = Buffer.from([
  '---\n',
  'name: sample\n',
  'description: Synthetic metadata preservation fixture.\n',
  'license: MIT\n',
  'compatibility: fixture\n',
  'metadata: {"team": "test"}\n',
  'allowed-tools: Read\n',
  'user-invocable: false\n',
  'paths: src/**\n',
  'future-key: preserved\n',
  '---\n',
  'Fixture body.\n',
].join(''));

function frontmatterKeys(bytes) {
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '---', 'synthetic SKILL.md starts with frontmatter');
  const end = lines.indexOf('---', 1);
  assert.notEqual(end, -1, 'synthetic SKILL.md closes frontmatter');
  return lines.slice(1, end).flatMap((line) => {
    const match = /^([A-Za-z][\w-]*):/.exec(line);
    return match ? [match[1]] : [];
  });
}

test('every synthetic non-common frontmatter key has an interpretation status and evidence note', () => {
  const keys = frontmatterKeys(skill).filter((key) => key !== 'name' && key !== 'description');
  const unaccounted = keys.filter((key) => !Object.hasOwn(nonCommonKeys, key));
  const stale = Object.keys(nonCommonKeys).filter((key) => !keys.includes(key));
  assert.deepEqual(unaccounted, [], `Unaccounted SKILL.md metadata key(s): ${unaccounted.join(', ')}. Add a per-harness status and evidence note.`);
  assert.deepEqual(stale, [], `Metadata status entry missing from the synthetic source fixture: ${stale.join(', ')}. Update the fixture and evidence table together.`);

  for (const key of keys) {
    const entry = nonCommonKeys[key];
    if (key === 'user-invocable') {
      for (const runtime of ['claude', 'copilot', 'opencode', 'pi', 'cursor', 'codex', 'antigravity']) {
        assert.ok(entry[runtime]?.status, `${key}: add ${runtime} interpretation status`);
        assert.ok(entry[runtime]?.evidence, `${key}: add ${runtime} evidence or say none is recorded`);
      }
    } else {
      assert.ok(entry.status, `${key}: add interpretation status`);
      assert.ok(entry.evidence, `${key}: add evidence or say none is recorded`);
    }
  }
});

test('the five generator projections keep synthetic SKILL.md bytes and their documented paths', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { skills: { sample: skill } });
    for (const runtime of runtimes) {
      const out = join(root, `out-${runtime.name}`);
      succeeds(runGenerator(runtime.name, [layer], out), runtime.name);
      const output = treeBytes(out);
      assert.deepEqual(output.get(runtime.path), skill, `${runtime.name} must preserve SKILL.md bytes at ${runtime.path}`);
    }
  });
});
