import { dirname, parse, resolve } from 'node:path';
import { loadLayers } from './layers.mjs';
import { planGeneration } from './plan.mjs';
import { writeOutput } from './output.mjs';
import { assertNoLinkedPath, assertNoWorkspace, canonical, isWithin, rejectDevicePath, safeSegment, statOrNull } from './paths.mjs';

export function generateLayers({ runtime, layers = [], out, check = false, faultHook } = {}) {
  const { layers: sources, warnings } = loadLayers(layers);
  const planned = planGeneration(runtime, sources);
  const target = resolveOutput(out, sources);
  return { summary: writeOutput({ out: target, runtime, planned, check, faultHook }), warnings };
}

// Refuses device, UNC, and link paths as written. Compares identities by canonical path, so an
// 8.3 alias or a junction cannot bypass the overlap check.
export function resolveOutput(out, sources) {
  if (typeof out !== 'string' || !out.trim()) throw new Error('--out requires an explicit directory path');
  rejectDevicePath(out, '--out');
  const absolute = resolve(out);
  const root = parse(absolute).root;
  for (const segment of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) safeSegment(segment, '--out');
  assertNoLinkedPath(absolute, '--out');
  const parent = dirname(absolute);
  if (!statOrNull(parent)?.isDirectory()) throw new Error(`--out parent must already exist as a directory: ${parent}`);
  const key = canonical(absolute);
  for (const { name, root: source } of sources) {
    const sourceKey = canonical(source);
    if (isWithin(key, sourceKey) || isWithin(sourceKey, key)) throw new Error(`--out overlaps layer ${name}`);
  }
  assertNoWorkspace(key);
  return absolute;
}
