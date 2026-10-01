// Compiles the samples repository's own program and compares the hex with its native CLANG build's.
// The test the design rests on: the two paths agree byte for byte, or nothing else here means much.
//
// Skipped unless MICROBIT_SAMPLES points at a built samples tree.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { compile } from '../lib/node.js';
import { sampleFiles, sha256 } from './samples.mjs';

const SAMPLES = process.env.MICROBIT_SAMPLES;

const skip = SAMPLES ? false : 'set MICROBIT_SAMPLES to a built samples tree';

test('reproduces the native build\'s hex', { skip }, async () => {
  const result = await compile(await sampleFiles(SAMPLES));
  assert.equal(result.ok, true, result.output);

  const reference = await readFile(path.join(SAMPLES, 'MICROBIT.hex'));
  assert.equal(sha256(Buffer.from(result.hex)), sha256(reference));
});

// Another key order is another header, so CODAL is compiled here rather than taken prebuilt.
test('reproduces it with CODAL compiled here', { skip }, async () => {
  const { target, config } = JSON.parse(await readFile(path.join(SAMPLES, 'codal.json'), 'utf8'));
  const reordered = JSON.stringify({ target, config: Object.fromEntries(Object.entries(config).reverse()) });
  assert.ok(Object.keys(config).length > 1, 'the harness\'s codal.json needs two settings to reorder');

  const result = await compile({ ...(await sampleFiles(SAMPLES)), 'codal.json': reordered });
  assert.equal(result.ok, true, result.output);
  assert.ok(result.steps.some((step) => step.codal !== null), 'CODAL was compiled');

  const reference = await readFile(path.join(SAMPLES, 'MICROBIT.hex'));
  assert.equal(sha256(Buffer.from(result.hex)), sha256(reference));
});
