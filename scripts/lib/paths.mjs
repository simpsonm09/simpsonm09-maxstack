import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const INVALID_CHARACTERS = /[<>:"|?*\\]/;
const WORKSPACE_MARKERS = ['.git', 'stack.lock.json', 'maxstack.settings.json'];

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function statOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function safeSegment(segment, label) {
  const invalid = !segment || segment === '.' || segment === '..' || INVALID_CHARACTERS.test(segment)
    || /[. ]$/.test(segment) || [...segment].some((char) => char.codePointAt(0) < 32);
  if (invalid) throw new Error(`${label}: invalid path segment ${JSON.stringify(segment)}`);
  if (DEVICE_NAME.test(segment)) throw new Error(`${label}: ${JSON.stringify(segment)} is a reserved Windows device name`);
  if (segment.toLowerCase() === '.git') throw new Error(`${label}: .git paths are forbidden`);
  return segment;
}

export function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) {
    throw new Error(`${label}: path must be relative and use forward slashes`);
  }
  for (const segment of value.split('/')) safeSegment(segment, label);
  return value;
}

export function rejectDevicePath(text, label) {
  if (/^[\\/]{2}[?.][\\/]/.test(text) || /^[\\/]{2}[^\\/]/.test(text)) {
    throw new Error(`${label}: UNC, device, and extended-length paths are not accepted; give a drive path`);
  }
}

// Link checks inspect the path as written. Resolving first would hide a junction.
export function assertNoLinkedPath(target, label) {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = statOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`${label}: symbolic link or junction in the path at ${current}`);
  }
}

// lstat of root/relative, refusing a link or junction at any component below root. Returns null
// when the path is absent. Following a junction inside a layer would read bytes from outside it.
export function statBelow(root, relative, label) {
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    const stat = statOrNull(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw new Error(`${label}: symbolic link or junction at ${current}`);
  }
  return statOrNull(current);
}

// Identity key for overlap and workspace checks: the real path of the longest existing ancestor
// plus the missing tail, folded to lower case on Windows.
export function canonical(target) {
  let base = resolve(target);
  const tail = [];
  while (!statOrNull(base)) {
    const parent = dirname(base);
    if (parent === base) break;
    tail.unshift(basename(base));
    base = parent;
  }
  const real = join(realpathSync.native(base), ...tail);
  return WIN ? real.toLowerCase() : real;
}

export function isWithin(child, parent) {
  const folder = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(folder);
}

export function assertNoWorkspace(key) {
  for (let dir = key; ; dir = dirname(dir)) {
    const marker = WORKSPACE_MARKERS.find((name) => statOrNull(join(dir, name)));
    if (marker) throw new Error(`--out is beneath a detected repository or workspace: ${dir} has ${marker}`);
    if (dirname(dir) === dir) return;
  }
}
