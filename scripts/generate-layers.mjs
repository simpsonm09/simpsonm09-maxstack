#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { generateLayers } from './lib/generate.mjs';
import { splitLayerValue } from './lib/layers.mjs';

try {
  const { values } = parseArgs({
    strict: true,
    options: {
      runtime: { type: 'string' },
      out: { type: 'string' },
      layers: { type: 'string', multiple: true },
      check: { type: 'boolean', default: false },
    },
  });
  if (!values.runtime) throw new Error('--runtime is required');
  if (!values.out) throw new Error('--out is required');
  const layers = (values.layers ?? []).flatMap(splitLayerValue);
  const result = generateLayers({ runtime: values.runtime, layers, out: values.out, check: values.check });
  for (const warning of result.warnings) process.stderr.write(`generate-layers: warning: ${warning}\n`);
  process.stdout.write(`${result.summary}\n`);
} catch (error) {
  process.stderr.write(`generate-layers: ${error.message}\n`);
  process.exitCode = 1;
}
