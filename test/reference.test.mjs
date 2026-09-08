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

test('reproduces the native build\'s hex', { skip: SAMPLES ? false : 'set MICROBIT_SAMPLES to a built samples tree' }, async () => {
  const result = await compile(await sampleFiles(SAMPLES));
  assert.equal(result.ok, true, result.output);

  const reference = await readFile(path.join(SAMPLES, 'MICROBIT.hex'));
  assert.equal(sha256(Buffer.from(result.hex)), sha256(reference));
});
