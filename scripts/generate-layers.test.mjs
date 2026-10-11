import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  libPath, makeLayer, outputText, ownership, rejects, runCli, runGenerator, saveOwnership, skillText, succeeds, treeBytes, withTemp, write,
} from './generate-layers.test-helpers.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const sortedByBytes = (names) => [...names].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
const skillPath = (layer, skill, file = 'SKILL.md') => `.claude/plugins/${layer}/skills/${skill}/${file}`;

test('CLI requires a runtime, an output, and layer roots, and rejects unknown options and runtimes', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    rejects(runCli(['--out', join(root, 'o'), '--layers', layer]), /--runtime is required/);
    rejects(runCli(['--runtime', 'claude', '--layers', layer]), /--out is required/);
    rejects(runCli(['--runtime', 'claude', '--out', join(root, 'o')]), /--layers requires/);
    rejects(runCli(['--runtime', 'claude', '--out', join(root, 'o'), '--layers', layer, '--unknown']), /Unknown option/);
    rejects(runGenerator('cursor', [layer], join(root, 'o')), /unsupported runtime "cursor"/);
  });
});

test('skills are byte copies for every runtime: frontmatter keys, BOM, CRLF, and binary assets are unchanged', () => {
  withTemp((root) => {
    const skill = Buffer.from('﻿---\r\nname: sample\r\ndescription: "Say \\"hi\\": ok"\r\nuser-invocable: true\r\nlicense: MIT\r\nmetadata: {"team": "x"}\r\nfuture-key: y\r\n---\r\nBody\r\n');
    const icon = Buffer.from([0, 255, 13, 10, 1, 128]);
    const layer = makeLayer(root, 'sample', { skills: {}, files: { 'skills/sample/SKILL.md': skill, 'skills/sample/assets/icon.bin': icon } });
    for (const runtime of ['claude', 'copilot', 'opencode', 'pi']) {
      const out = join(root, `out-${runtime}`);
      succeeds(runGenerator(runtime, [layer], out), runtime);
      const base = runtime === 'opencode' ? '.opencode/skills/sample' : runtime === 'pi' ? '.pi/agent/skills/sample' : '.claude/plugins/sample/skills/sample';
      assert.deepEqual(treeBytes(out).get(`${base}/SKILL.md`), skill, `${runtime} SKILL.md bytes`);
      assert.deepEqual(treeBytes(out).get(`${base}/assets/icon.bin`), icon, `${runtime} asset bytes`);
    }
    const pi = join(root, 'out-pi');
    assert.deepEqual([...treeBytes(pi).keys()].filter((path) => !path.startsWith('.pi/agent/skills/') && path !== 'generator.owned.json'), [],
      'Pi output is skills and the ownership record only: no settings.json, no AGENTS.md, which the installer merges');
  });
});

test('skill validation refuses a folder that differs from its name, a missing description, a model key, and a missing SKILL.md', () => {
  withTemp((root) => {
    const cases = [
      ['name differs from folder', makeLayer(join(root, 'a'), 'sample', { skills: { sample: skillText('other') } }), /must equal the folder name/],
      ['empty description', makeLayer(join(root, 'b'), 'sample', { skills: { sample: '---\nname: sample\ndescription:\n---\nbody\n' } }), /description is missing or empty/],
      ['model key', makeLayer(join(root, 'c'), 'sample', { skills: { sample: '---\nname: sample\ndescription: d\nmodel: opus\n---\nbody\n' } }), /maxstack sets no model/],
      ['lowercase skill.md', makeLayer(join(root, 'd'), 'sample', { skills: {} }), /exactly SKILL\.md/],
    ];
    write(join(root, 'd', 'sample'), 'skills/sample/skill.md', skillText('sample'));
    cases.forEach(([label, layer, diagnostic], index) => {
      rejects(runGenerator('claude', [layer], join(root, `out-${index}`)), diagnostic, label);
      assert.equal(existsSync(join(root, `out-${index}`)), false, `${label} creates no output`);
    });
  });
});

test('skills top level ignores dotfiles, warns about loose files, and never copies node_modules', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', {
      files: { 'skills/README.md': 'read me\n', 'skills/.gitkeep': '', 'skills/sample/node_modules/pkg/index.js': 'x\n' },
    });
    const out = join(root, 'out');
    const result = runGenerator('claude', [layer], out);
    succeeds(result);
    assert.match(result.stderr, /warning: ignored skills\/README\.md/);
    assert.equal(treeBytes(out).has(skillPath('sample', 'sample', 'node_modules/pkg/index.js')), false);
  });
});

test('layer identity comes from the folder or name=path, and an uppercase folder needs name=path', () => {
  withTemp((root) => {
    const folder = makeLayer(root, 'Mixed', { plugin: null });
    rejects(runGenerator('claude', [folder], join(root, 'a')), /use name=path/);
    const out = join(root, 'b');
    succeeds(runGenerator('claude', [`alpha=${folder}`], out));
    assert.ok(treeBytes(out).has('.claude/plugins/alpha/.claude-plugin/plugin.json'));
  });
});

test('a folder with no skills, manifest, or fragment is refused as not a layer, so a mistyped root cannot clear output', () => {
  withTemp((root) => {
    write(root, 'notes/README.md', 'not a layer\n');
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [makeLayer(root, 'sample')], out));
    rejects(runGenerator('claude', [join(root, 'notes')], out), /is not a layer/);
    assert.ok(treeBytes(out).has('.claude/plugins/sample/.claude-plugin/plugin.json'), 'the existing output is untouched');
  });
});

test('a layer root whose path contains ; is one root when the whole value is a directory, and ; still splits real roots', () => {
  withTemp((root) => {
    const semi = makeLayer(root, 'layer;semi', { plugin: null });
    const out = join(root, 'out-semi');
    succeeds(runCli(['--runtime', 'claude', '--out', out, '--layers', `semi=${semi}`]), 'a ; inside one directory name');
    assert.ok(treeBytes(out).has('.claude/plugins/semi/skills/sample/SKILL.md'));

    const first = makeLayer(root, 'first');
    const second = makeLayer(root, 'second');
    const both = join(root, 'out-both');
    succeeds(runCli(['--runtime', 'claude', '--out', both, '--layers', `${first};${second}`]), 'two real roots in one value');
    assert.ok(treeBytes(both).has('.claude/plugins/first/skills/sample/SKILL.md'));
    assert.ok(treeBytes(both).has('.claude/plugins/second/skills/sample/SKILL.md'));
  });
});

test('duplicate layer names and a plugin name that differs from the layer are refused', () => {
  withTemp((root) => {
    const first = makeLayer(join(root, 'a'), 'same');
    const second = makeLayer(join(root, 'b'), 'same');
    rejects(runGenerator('claude', [first, second], join(root, 'o1')), /duplicate layer name same/);
    const mismatch = makeLayer(root, 'folder', { plugin: 'other' });
    rejects(runGenerator('claude', [mismatch], join(root, 'o2')), /must match layer folder/);
  });
});

test('reversed layer order applies, passes --check, and writes byte-sorted ownership records and layer lists', () => {
  withTemp((root) => {
    const server = (command) => ({ mcp: { servers: { shared: { type: 'local', command: [command] } } } });
    const zeta = makeLayer(root, 'zeta', { skills: { Beta: skillText('Beta'), alpha: skillText('alpha') }, fragment: server('zeta') });
    const alpha = makeLayer(root, 'alpha', { skills: { sample: skillText('sample') }, fragment: server('alpha') });
    const out = join(root, 'out');
    const plainZeta = makeLayer(join(root, 'plain'), 'zeta', { skills: { Beta: skillText('Beta'), alpha: skillText('alpha') } });
    const plainAlpha = makeLayer(join(root, 'plain'), 'alpha', { skills: { sample: skillText('sample') } });
    succeeds(runGenerator('claude', [plainZeta, plainAlpha], out));
    succeeds(runGenerator('claude', [plainZeta, plainAlpha], out, ['--check']));
    const owned = ownership(out).owned;
    const paths = owned.map((record) => record.path);
    assert.deepEqual(paths, sortedByBytes(paths), 'owned records are sorted by UTF-8 bytes');
    assert.ok(paths.indexOf(skillPath('zeta', 'Beta')) < paths.indexOf(skillPath('zeta', 'alpha')), 'uppercase B sorts before lowercase a');
    const shared = join(root, 'shared');
    succeeds(runGenerator('opencode', [zeta, alpha], shared));
    succeeds(runGenerator('opencode', [zeta, alpha], shared, ['--check']));
    const contributors = ownership(shared).owned.find((record) => record.path === 'opencode.jsonc').layers;
    assert.deepEqual(contributors, ['alpha', 'zeta'], 'a shared file lists its layers sorted, not in command order');
    assert.equal(JSON.parse(readFileSync(join(shared, 'opencode.jsonc'), 'utf8')).mcp.servers.shared.command[0], 'alpha', 'the later layer wins');
  });
});

test('OpenCode projects V2 MCP servers with later layers winning, disabled kept, and contributing layers recorded', () => {
  withTemp((root) => {
    const first = makeLayer(root, 'first', { skills: {}, fragment: { mcp: { servers: {
      shared: { type: 'local', command: ['old'] },
      '10': { type: 'remote', url: 'https://ten.example/mcp' },
      '2': { type: 'remote', url: 'https://two.example/mcp', disabled: true },
    } } } });
    const second = makeLayer(root, 'second', { skills: {}, fragment: { mcp: { servers: { shared: { type: 'local', command: ['new', '--flag'] } } } } });
    const out = join(root, 'out');
    succeeds(runGenerator('opencode', [first, second], out));
    const text = readFileSync(join(out, 'opencode.jsonc'), 'utf8');
    assert.ok(text.indexOf('"10"') < text.indexOf('"2"'), 'keys sort by UTF-8 bytes');
    assert.deepEqual(JSON.parse(text), { mcp: { servers: {
      10: { type: 'remote', url: 'https://ten.example/mcp' },
      2: { type: 'remote', url: 'https://two.example/mcp', disabled: true },
      shared: { type: 'local', command: ['new', '--flag'] },
    } } });
    assert.deepEqual(ownership(out).owned.find((record) => record.path === 'opencode.jsonc').layers, ['first', 'second']);
  });
});

test('empty MCP is accepted for every runtime and writes no servers file', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { fragment: '{}' });
    for (const runtime of ['claude', 'copilot', 'opencode', 'pi']) {
      const out = join(root, `out-${runtime}`);
      succeeds(runGenerator(runtime, [layer], out), runtime);
      assert.equal(treeBytes(out).has('opencode.jsonc'), false);
    }
  });
});

test('nonempty MCP fails closed for claude, copilot, and pi before any output is written', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { fragment: { mcp: { servers: { x: { type: 'remote', url: 'https://service.example/mcp' } } } } });
    for (const runtime of ['claude', 'copilot', 'pi']) {
      const out = join(root, `out-${runtime}`);
      rejects(runGenerator(runtime, [layer], out), new RegExp(`nonempty MCP is not projected for ${runtime}`));
      assert.equal(existsSync(out), false);
    }
  });
});

const badFragments = [
  ['environment references', { mcp: { servers: { x: { type: 'local', command: ['s'], environment: { T: 'v' } } } } }, /unsupported key "environment"/],
  ['credentialed URL', { mcp: { servers: { x: { type: 'remote', url: 'https://placeholder-user:placeholder-secret@service.example/mcp' } } } }, /credentials are forbidden/],
  ['raw whitespace in URL', { mcp: { servers: { x: { type: 'remote', url: 'https://service.example/a b' } } } }, /without whitespace or control/],
  ['C1 control in URL', { mcp: { servers: { x: { type: 'remote', url: 'https://service.example/\u0085' } } } }, /without whitespace or control/],
  ['case-only server names', { mcp: { servers: { Search: { type: 'local', command: ['a'] }, search: { type: 'local', command: ['b'] } } } }, /case collision/],
  ['empty command', { mcp: { servers: { x: { type: 'local', command: [] } } } }, /non-empty array/],
  ['unsupported top-level key', { mcp: { servers: {} }, plugin: [] }, /unsupported key "plugin"/],
];

for (const [label, fragment, diagnostic] of badFragments) {
  test(`MCP refuses ${label} before output`, () => {
    withTemp((root) => {
      const layer = makeLayer(root, 'sample', { fragment });
      const out = join(root, 'out');
      rejects(runGenerator('opencode', [layer], out), diagnostic, label);
      assert.equal(existsSync(out), false);
    });
  });
}

test('a duplicate JSON property in the OpenCode fragment is refused', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { fragment: '{"mcp":{"servers":{"x":{"type":"local","command":["a"]},"x":{"type":"local","command":["b"]}}}}' });
    rejects(runGenerator('opencode', [layer], join(root, 'out')), /duplicate JSON property "x"/);
  });
});

test('the strict JSON reader refuses a byte order mark and non-JSON whitespace in the manifest and fragment', () => {
  withTemp((root) => {
    const cases = [
      ['manifest with a leading BOM', '﻿{"name":"bom"}', 'plugin.json', /byte order mark/],
      ['manifest with an NBSP between tokens', '{"name": "nbsp"}', 'plugin.json', /invalid JSON value/],
      ['fragment with a leading BOM', '﻿{}', 'fragment', /byte order mark/],
      ['fragment with an NBSP between tokens', '{"mcp": {}}', 'fragment', /invalid JSON value/],
    ];
    cases.forEach(([label, text, which, diagnostic], index) => {
      const name = `json${index}`;
      const layer = makeLayer(join(root, label.replace(/\W+/g, '-')), name, { plugin: null, skills: {} });
      if (which === 'plugin.json') write(layer, '.claude-plugin/plugin.json', text);
      else write(layer, 'opencode.fragment.jsonc', text);
      rejects(runGenerator('opencode', [layer], join(root, `out-${index}`)), diagnostic, label);
    });
  });
});

test('a neutral-layer.json descriptor is refused rather than silently ignored', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    write(layer, 'neutral-layer.json', '{"version":1}');
    rejects(runGenerator('claude', [layer], join(root, 'out')), /neutral-layer\.json is not read/);
  });
});

test('a forged ownership record with unsorted records, unsorted layers, or a runtime mismatch is refused', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { fragment: { mcp: { servers: { x: { type: 'local', command: ['a'] } } } } });
    const other = makeLayer(root, 'other', { skills: { other: skillText('other') }, fragment: { mcp: { servers: { y: { type: 'local', command: ['b'] } } } } });
    const out = join(root, 'out');
    succeeds(runGenerator('opencode', [layer, other], out));
    const original = ownership(out);
    const reversed = { ...original, owned: [...original.owned].reverse() };
    const unsortedLayers = { ...original, owned: original.owned.map((record) => ({ ...record, layers: [...record.layers].reverse() })) };
    const mismatch = { ...original, runtime: 'pi' };
    const before = treeBytes(out);
    const ownershipPath = join(out, 'generator.owned.json');
    for (const [label, forged, diagnostic] of [
      ['unsorted records', reversed, /unique and sorted/],
      ['unsorted layers', unsortedLayers, /sorted, unique list/],
      ['runtime mismatch', mismatch, /does not match opencode/],
    ]) {
      saveOwnership(out, forged);
      rejects(runGenerator('opencode', [layer, other], out), diagnostic, label);
      writeFileSync(ownershipPath, before.get('generator.owned.json'));
      assert.deepEqual(treeBytes(out), before, `${label} leaves the tree unchanged`);
    }
  });
});

test('a record outside the runtime namespace or not attributed to its layer is refused and its file kept', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [layer], out));
    const kept = Buffer.from('keep me\n');
    write(out, 'user.txt', kept);
    const document = ownership(out);
    saveOwnership(out, { ...document, owned: [...document.owned, { path: 'user.txt', sha256: sha(kept), layers: ['sample'] }].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) });
    rejects(runGenerator('claude', [layer], out), /outside the claude output namespace/);
    assert.deepEqual(readFileSync(join(out, 'user.txt')), kept);
    saveOwnership(out, { ...document, owned: document.owned.map((record) => (record.path === skillPath('sample', 'sample') ? { ...record, layers: ['other'] } : record)) });
    rejects(runGenerator('claude', [layer], out), /not attributed to layer sample/);
  });
});

test('a forged in-namespace record naming a user file in a surviving skill is refused and the file is kept', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'alpha');
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [layer], out));
    const notes = Buffer.from('my private notes\n');
    write(out, '.claude/plugins/alpha/skills/sample/my-notes.txt', notes);
    const document = ownership(out);
    saveOwnership(out, { ...document, owned: [...document.owned, { path: '.claude/plugins/alpha/skills/sample/my-notes.txt', sha256: sha(notes), layers: ['alpha'] }]
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) });
    rejects(runGenerator('claude', [layer], out), /stale but .*still generates output/, 'forged in-namespace record');
    assert.deepEqual(readFileSync(join(out, '.claude/plugins/alpha/skills/sample/my-notes.txt')), notes);
  });
});

test('a modified owned file and an unknown file are refused and left unchanged', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [layer], out));
    const target = join(out, ...skillPath('sample', 'sample').split('/'));
    const original = readFileSync(target);
    writeFileSync(target, 'hand edited\n');
    const edited = treeBytes(out);
    rejects(runGenerator('claude', [layer], out), /owned file was modified/);
    assert.deepEqual(treeBytes(out), edited);
    writeFileSync(target, original);
    write(out, 'notes.txt', 'unknown\n');
    rejects(runGenerator('claude', [layer], out, ['--check']), /unknown files are not owned/);
  });
});

test('stale files in a removed skill and a removed layer are deleted with their empty folders', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { skills: { sample: skillText('sample'), gone: skillText('gone') }, files: { 'skills/gone/old.txt': 'old\n' } });
    const other = makeLayer(root, 'other');
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [layer, other], out));
    rmSync(join(root, 'sample', 'skills', 'gone'), { recursive: true });
    succeeds(runGenerator('claude', [layer, other], out));
    assert.equal(existsSync(join(out, '.claude', 'plugins', 'sample', 'skills', 'gone')), false);
    succeeds(runGenerator('claude', [layer], out));
    assert.equal(existsSync(join(out, '.claude', 'plugins', 'other')), false, 'a removed layer leaves no empty folder');
    succeeds(runGenerator('claude', [layer], out, ['--check']));
  });
});

test('a stale asset inside a surviving skill is refused until the output is regenerated clean', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { files: { 'skills/sample/old.txt': 'old\n' } });
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [layer], out));
    const before = treeBytes(out);
    rmSync(join(root, 'sample', 'skills', 'sample', 'old.txt'));
    rejects(runGenerator('claude', [layer], out), /still generates output; regenerate into a clean output directory/);
    assert.deepEqual(treeBytes(out), before);
    succeeds(runGenerator('claude', [layer], join(root, 'clean')));
  });
});

test('--check is read-only: a missing output drifts without being created, and an extra file drifts unchanged', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    const missing = join(root, 'missing');
    rejects(runGenerator('claude', [layer], missing, ['--check']), /--check drift: missing/);
    assert.equal(existsSync(missing), false);
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [layer], out));
    succeeds(runGenerator('claude', [layer], out, ['--check']), 'matching tree');
    write(out, 'unexpected.txt', 'keep exactly\n');
    const before = treeBytes(out);
    rejects(runGenerator('claude', [layer], out, ['--check']), /unknown files/);
    assert.deepEqual(treeBytes(out), before);
  });
});

test('output paths refuse device names, alternate data streams, trailing dots, .git, and a missing parent', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    rejects(runGenerator('claude', [layer], join(root, 'CON.txt')), /reserved Windows device name/);
    rejects(runGenerator('claude', [layer], join(root, 'output:stream')), /invalid path segment/);
    rejects(runGenerator('claude', [layer], join(root, 'trailing.')), /invalid path segment/);
    rejects(runGenerator('claude', [layer], join(root, '.git', 'out')), /\.git paths are forbidden/);
    const parent = join(root, 'missing-parent', 'out');
    rejects(runGenerator('claude', [layer], parent), /parent must already exist/);
    assert.equal(existsSync(join(root, 'missing-parent')), false);
  });
});

test('device, extended-length, and UNC output paths are refused as written', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    const target = join(root, 'out');
    rejects(runGenerator('claude', [layer], `\\\\?\\${target}`), /extended-length paths are not accepted/);
    rejects(runGenerator('claude', [layer], `\\\\.\\${target}`), /extended-length paths are not accepted/);
    rejects(runGenerator('claude', [layer], '\\\\localhost\\C$\\maxstack-out'), /UNC/);
    rejects(runGenerator('claude', [`named=\\\\?\\${layer}`], join(root, 'o')), /extended-length paths are not accepted/, 'named layer root');
    assert.equal(existsSync(target), false);
  });
});

test('an output overlapping a layer source is refused for equal, child, and parent paths', () => {
  withTemp((root) => {
    const layer = makeLayer(join(root, 'sources'), 'sample');
    rejects(runGenerator('claude', [layer], layer), /overlaps layer sample/, 'equal');
    rejects(runGenerator('claude', [layer], join(layer, 'generated')), /overlaps layer sample/, 'child');
    rejects(runGenerator('claude', [layer], join(root, 'sources')), /overlaps layer sample/, 'parent');
  });
});

test('a junction to a layer source cannot hide an overlap, and an output junction is refused', (t) => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    const link = join(root, 'alias');
    try {
      symlinkSync(layer, link, 'junction');
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('junction creation is unavailable on this host');
      throw error;
    }
    rejects(runGenerator('claude', [layer], join(link, 'generated')), /symbolic link or junction/, 'junction output');
    rejects(runGenerator('claude', [link], join(root, 'out')), /symbolic link or junction/, 'junction source');
    assert.equal(existsSync(join(layer, 'generated')), false, 'no output is created inside the source');
  });
});

test('an 8.3 short-name alias of a layer source is refused as an overlap', (t) => {
  withTemp((root) => {
    const layer = makeLayer(join(root, 'long-directory-name-for-alias'), 'sample');
    const script = `"for %I in ("${layer}") do @echo %~sI"`;
    const shortName = spawnSync('cmd.exe', ['/d', '/s', '/c', script], { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8' }).stdout.trim();
    if (process.platform !== 'win32' || !shortName || shortName === layer || !existsSync(shortName)) {
      return t.skip('no 8.3 short name is available for this path on this host');
    }
    rejects(runGenerator('claude', [layer], join(shortName, 'generated')), /overlaps layer sample/);
  });
});

test('a workspace marker above the output refuses it', () => {
  withTemp((root) => {
    const layer = makeLayer(join(root, 'sources'), 'sample');
    write(root, 'workspace/stack.lock.json', '{}');
    rejects(runGenerator('claude', [layer], join(root, 'workspace', 'generated')), /detected repository or workspace/);
  });
});

test('an in-process write failure restores every prior byte, including a removed file and the ownership record', async () => {
  const { generateLayers } = await import(pathToFileURL(libPath).href);
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { skills: { sample: skillText('sample'), gone: skillText('gone') } });
    const out = join(root, 'out');
    succeeds(runGenerator('claude', [layer], out));
    const before = treeBytes(out);
    rmSync(join(root, 'sample', 'skills', 'gone'), { recursive: true });
    write(root, 'sample/skills/sample/SKILL.md', skillText('sample', 'changed'));
    assert.throws(() => generateLayers({
      runtime: 'claude',
      layers: [layer],
      out,
      faultHook: ({ kind, path }) => {
        if (kind === 'write' && path.endsWith('sample/SKILL.md')) throw new Error('injected write failure');
      },
    }), /injected write failure/);
    assert.deepEqual(treeBytes(out), before);
    assert.equal(existsSync(join(out, '.generator-incomplete')), false, 'the marker is removed after a clean rollback');
  });
});

test('a hard kill between writes leaves the marker, and apply and --check refuse until a clean output is used', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { skills: { sample: skillText('sample'), other: skillText('other') } });
    const out = join(root, 'out');
    const code = `const { generateLayers } = await import(${JSON.stringify(pathToFileURL(libPath).href)});
generateLayers({ runtime: 'claude', layers: [${JSON.stringify(layer)}], out: ${JSON.stringify(out)},
  faultHook: ({ kind, path }) => { if (kind === 'write' && path.endsWith('other/SKILL.md')) process.exit(7); } });`;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, encoding: 'utf8' });
    assert.equal(killed.status, 7, `child exit\n${outputText(killed)}`);
    assert.equal(existsSync(join(out, '.generator-incomplete')), true, 'the marker survives the kill');
    rejects(runGenerator('claude', [layer], out), /regenerate into a clean output directory/, 'apply after kill');
    rejects(runGenerator('claude', [layer], out, ['--check']), /regenerate into a clean output directory/, '--check after kill');
    succeeds(runGenerator('claude', [layer], join(root, 'clean')));
  });
});

test('a junction inside a layer root is refused where the generator reads the manifest', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { plugin: null });
    write(root, 'external/plugin.json', JSON.stringify({ name: 'sample' }));
    symlinkSync(join(root, 'external'), join(layer, '.claude-plugin'), 'junction');
    const out = join(root, 'out');
    rejects(runGenerator('claude', [layer], out), /symbolic link or junction at .*\.claude-plugin/, 'junction manifest directory');
    assert.equal(existsSync(out), false, 'no output is created');
  });
});

test('a junction at the fragment path inside a layer root is refused', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { skills: {}, plugin: null });
    write(layer, 'README.md', 'a layer with only a fragment\n');
    write(root, 'external/fragment-dir/placeholder.txt', 'outside the layer\n');
    symlinkSync(join(root, 'external', 'fragment-dir'), join(layer, 'opencode.fragment.jsonc'), 'junction');
    rejects(runGenerator('opencode', [layer], join(root, 'out')), /symbolic link or junction at .*opencode\.fragment/, 'junction fragment');
  });
});

test('a file symlink at the fragment path is refused where the host allows one', (t) => {
  withTemp((root) => {
    const linked = makeLayer(root, 'sample', { skills: {}, plugin: null });
    write(linked, 'README.md', 'a layer with only a fragment\n');
    write(root, 'external/fragment.jsonc', '{"mcp":{"servers":{}}}');
    try {
      symlinkSync(join(root, 'external', 'fragment.jsonc'), join(linked, 'opencode.fragment.jsonc'), 'file');
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.skip('file symlink creation is unavailable on this host; the junction case covers the same reader');
      return;
    }
    rejects(runGenerator('opencode', [linked], join(root, 'out')), /symbolic link or junction at .*opencode\.fragment/, 'linked fragment');
  });
});

test('input directory junctions and file symlinks are refused before any output', (t) => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    const outside = write(root, 'outside/data.bin', Buffer.from([0, 1, 2]));
    try {
      symlinkSync(dirname(outside), join(layer, 'skills', 'sample', 'linked'), 'junction');
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.skip('junction creation is unavailable on this host');
      return;
    }
    rejects(runGenerator('claude', [layer], join(root, 'out')), /symbolic link or junction/);
    assert.equal(existsSync(join(root, 'out')), false);
  });
});

test('a symlinked SKILL.md is refused before output when file symlinks are permitted', (t) => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample');
    const source = join(layer, 'skills', 'sample', 'SKILL.md');
    const outside = write(root, 'outside/SKILL.md', skillText('sample'));
    rmSync(source);
    try {
      symlinkSync(outside, source, 'file');
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.skip('file symlink creation is unavailable on this host');
      return;
    }
    rejects(runGenerator('claude', [layer], join(root, 'out')), /symbolic link or junction/);
  });
});

test('two independent runs are byte deterministic, and a second apply over the same tree changes nothing', () => {
  withTemp((root) => {
    const layer = makeLayer(root, 'sample', { files: { 'skills/sample/data.json': '{"b":2,"a":1}\n' }, fragment: { mcp: { servers: { x: { type: 'local', command: ['a'] } } } } });
    const first = join(root, 'first');
    const second = join(root, 'second');
    succeeds(runGenerator('opencode', [layer], first));
    succeeds(runGenerator('opencode', [layer], second));
    assert.deepEqual([...treeBytes(first)], [...treeBytes(second)]);
    const before = [...treeBytes(first)];
    const again = runGenerator('opencode', [layer], first);
    succeeds(again);
    assert.match(again.stdout, /already matches the plan/);
    assert.deepEqual([...treeBytes(first)], before);
  });
});
