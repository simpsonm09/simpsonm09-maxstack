import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LAYER_NAME } from './layers.mjs';
import { decodeUtf8, isObject, jsonBytes, parseJsonStrict } from './json.mjs';
import { compareUtf8, safeRelativePath, statOrNull } from './paths.mjs';

export const OWNERSHIP = 'generator.owned.json';
export const MARKER = '.generator-incomplete';
const MARKER_TEXT = 'an apply was interrupted; regenerate into a clean output directory\n';

// A recorded path is removable only inside its runtime's namespace.
const NAMESPACE = {
  claude: ['.claude/plugins/'],
  copilot: ['.claude/plugins/'],
  opencode: ['.opencode/skills/', 'opencode.jsonc'],
  pi: ['.pi/agent/skills/'],
};
// The directory that owns a generated file. A stale file inside a directory the plan still
// produces is refused, because a forged record cannot be told from a retired asset.
const SCOPE = {
  claude: /^\.claude\/plugins\/[^/]+(?:\/skills\/[^/]+)?/,
  copilot: /^\.claude\/plugins\/[^/]+(?:\/skills\/[^/]+)?/,
  opencode: /^\.opencode\/skills\/[^/]+/,
  pi: /^\.pi\/agent\/skills\/[^/]+/,
};

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

export function scanOutput(out) {
  const snapshot = { files: new Map(), dirs: new Set() };
  const stat = statOrNull(out);
  if (!stat) return snapshot;
  if (!stat.isDirectory()) throw new Error(`--out must name a directory: ${out}`);
  walk(out, '', snapshot);
  return snapshot;
}

function walk(dir, prefix, snapshot) {
  for (const name of readdirSync(dir)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(dir, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`--out contains a symbolic link or junction: ${relative}`);
    if (info.isDirectory()) {
      snapshot.dirs.add(relative);
      walk(path, relative, snapshot);
    } else if (info.isFile() && info.nlink === 1) {
      snapshot.files.set(relative, readFileSync(path));
    } else {
      throw new Error(`--out contains an unsupported or hard-linked entry: ${relative}`);
    }
  }
}

function isSortedUnique(names) {
  return names.every((name, index) => index === 0 || compareUtf8(names[index - 1], name) < 0);
}

function checkRecord(record, runtime) {
  const label = OWNERSHIP;
  if (!isObject(record) || Object.keys(record).sort().join() !== 'layers,path,sha256') {
    throw new Error(`${label}: each owned record must have exactly path, sha256, and layers`);
  }
  const path = safeRelativePath(record.path, `${label} path`);
  if (!NAMESPACE[runtime].some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))) {
    throw new Error(`${label}: ${path} is outside the ${runtime} output namespace`);
  }
  if (!/^[0-9A-F]{64}$/.test(record.sha256)) throw new Error(`${label}: invalid SHA-256 for ${path}`);
  const layers = record.layers;
  if (!Array.isArray(layers) || !layers.length || !layers.every((name) => typeof name === 'string' && LAYER_NAME.test(name)) || !isSortedUnique(layers)) {
    throw new Error(`${label}: layers for ${path} must be a non-empty, sorted, unique list of layer names`);
  }
  const plugin = /^\.claude\/plugins\/([^/]+)\//.exec(path);
  if (plugin && !layers.includes(plugin[1])) throw new Error(`${label}: ${path} is not attributed to layer ${plugin[1]}`);
}

function readOwnership(bytes, runtime) {
  if (!bytes) return [];
  const document = parseJsonStrict(decodeUtf8(bytes, OWNERSHIP), OWNERSHIP);
  if (!isObject(document) || Object.keys(document).sort().join() !== 'owned,runtime,version') {
    throw new Error(`${OWNERSHIP} must have exactly version, runtime, and owned`);
  }
  if (document.version !== 1) throw new Error(`${OWNERSHIP}: version must be 1`);
  if (document.runtime !== runtime) throw new Error(`${OWNERSHIP}: runtime ${JSON.stringify(document.runtime)} does not match ${runtime}`);
  if (!Array.isArray(document.owned)) throw new Error(`${OWNERSHIP}: owned must be an array`);
  const paths = document.owned.map((record) => {
    checkRecord(record, runtime);
    return record.path;
  });
  if (!isSortedUnique(paths)) throw new Error(`${OWNERSHIP}: owned records must be unique and sorted by UTF-8 path`);
  return document.owned;
}

function buildOwnership(runtime, planned) {
  const owned = [...planned]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([path, item]) => ({
      path,
      sha256: sha256(item.bytes),
      layers: [...new Set(item.layers)].sort(compareUtf8),
    }));
  return { version: 1, runtime, owned };
}

function directoriesOf(paths) {
  const dirs = new Set();
  for (const path of paths) {
    let dir = path;
    while (dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      dirs.add(dir);
    }
  }
  return dirs;
}

// Decides every write and removal in memory before the first file changes.
export function reconcile(snapshot, runtime, planned) {
  if (snapshot.files.has(MARKER)) {
    throw new Error(`an interrupted apply left ${MARKER}; regenerate into a clean output directory`);
  }
  const owned = readOwnership(snapshot.files.get(OWNERSHIP), runtime);
  for (const record of owned) {
    const current = snapshot.files.get(record.path);
    if (!current) throw new Error(`owned file is missing: ${record.path}`);
    if (sha256(current) !== record.sha256) throw new Error(`owned file was modified: ${record.path}`);
  }
  const ownedPaths = new Set(owned.map((record) => record.path));
  const unknown = [...snapshot.files.keys()].filter((path) => path !== OWNERSHIP && !ownedPaths.has(path));
  if (unknown.length) throw new Error(`unknown files are not owned by the generator: ${unknown.sort(compareUtf8).join(', ')}`);

  const plannedDirs = directoriesOf(planned.keys());
  const removals = [...ownedPaths].filter((path) => !planned.has(path)).sort(compareUtf8);
  for (const path of removals) {
    const scope = SCOPE[runtime].exec(path)?.[0];
    if (scope && plannedDirs.has(scope)) {
      throw new Error(`owned file ${path} is stale but ${scope} still generates output; regenerate into a clean output directory`);
    }
  }
  const wanted = new Map(planned);
  wanted.set(OWNERSHIP, { bytes: jsonBytes(buildOwnership(runtime, planned)), layers: [] });
  for (const path of wanted.keys()) {
    if (snapshot.dirs.has(path)) throw new Error(`destination ${path} is a directory`);
  }
  const writes = [...wanted]
    .filter(([path, item]) => !snapshot.files.get(path)?.equals(item.bytes))
    .sort(([left], [right]) => (left === OWNERSHIP ? 1 : right === OWNERSHIP ? -1 : compareUtf8(left, right)));
  return { removals, writes: writes.map(([path, item]) => ({ path, bytes: item.bytes })) };
}

function describe(plan, snapshot) {
  const writes = plan.writes.map(({ path }) => `${snapshot.files.has(path) ? 'changed' : 'missing'} ${path}`);
  return [...writes, ...plan.removals.map((path) => `extra ${path}`)].join('; ');
}

// Plans, then either reports drift (check) or applies. The marker is written before the first
// change. A clean finish deletes it. An in-process error restores from memory and deletes it.
// A hard kill leaves it behind, and then apply and check both refuse.
export function writeOutput({ out, runtime, planned, check, faultHook }) {
  const snapshot = scanOutput(out);
  const plan = reconcile(snapshot, runtime, planned);
  const changes = plan.removals.length + plan.writes.length;
  if (check) {
    if (changes) throw new Error(`--check drift: ${describe(plan, snapshot)}`);
    return 'generated output matches the plan';
  }
  if (!changes) return 'generated output already matches the plan';
  applyPlan(out, snapshot, plan, faultHook);
  return `applied ${changes} file change(s)`;
}

function applyPlan(out, snapshot, plan, faultHook) {
  const journal = [];
  const marker = join(out, MARKER);
  makeDirs(out, dirname(out), null);
  writeFileSync(marker, MARKER_TEXT, { flag: 'wx' });
  let index = 0;
  try {
    for (const path of plan.removals) {
      const target = join(out, ...path.split('/'));
      const old = snapshot.files.get(path);
      journal.push(() => writeAtomic(target, old));
      unlinkSync(target);
      faultHook?.({ kind: 'remove', path, index: ++index });
    }
    pruneDirs(out, plan.removals, snapshot, journal);
    for (const { path, bytes } of plan.writes) {
      const target = join(out, ...path.split('/'));
      const old = snapshot.files.get(path) ?? null;
      makeDirs(dirname(target), out, journal);
      journal.push(() => (old ? writeAtomic(target, old) : removeIfExists(target)));
      writeAtomic(target, bytes);
      faultHook?.({ kind: 'write', path, index: ++index });
    }
  } catch (error) {
    rollback(journal, marker, error);
  }
  unlinkSync(marker);
}

function rollback(journal, marker, error) {
  const failures = [];
  for (const undo of journal.reverse()) {
    try {
      undo();
    } catch (undoError) {
      failures.push(undoError.message);
    }
  }
  if (failures.length) {
    throw new Error(`${error.message}; rollback failed and ${MARKER} was kept: ${failures.join('; ')}`);
  }
  unlinkSync(marker);
  throw error;
}

function pruneDirs(out, removals, snapshot, journal) {
  const candidates = [...directoriesOf(removals)].sort((left, right) => right.split('/').length - left.split('/').length || compareUtf8(left, right));
  for (const dir of candidates) {
    const target = join(out, ...dir.split('/'));
    if (snapshot.dirs.has(dir) && existsSync(target) && readdirSync(target).length === 0) {
      rmdirSync(target);
      journal.push(() => mkdirSync(target));
    }
  }
}

function makeDirs(target, base, journal) {
  const missing = [];
  for (let dir = target; dir !== base && !statOrNull(dir); dir = dirname(dir)) missing.unshift(dir);
  for (const dir of missing) {
    mkdirSync(dir);
    journal?.push(() => rmdirSync(dir));
  }
}

function writeAtomic(target, bytes) {
  const temporary = `${target}.generator-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    removeIfExists(temporary);
    throw error;
  }
}

function removeIfExists(path) {
  if (statOrNull(path)) unlinkSync(path);
}
