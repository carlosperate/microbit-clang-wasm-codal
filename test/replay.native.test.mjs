// Replays the packaged recipe with the native ATfE toolchain, from a directory holding only what
// this package ships: the control for the WASM path, and proof nothing leaks in from a host
// toolchain. Both derive their commands from lib/recipe.js, so the runner is the only difference.
//
// Skipped unless ATFE_HOME, ATFE_SYSROOT and MICROBIT_SAMPLES are all set.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { plan } from '../lib/recipe.js';
import { flatten, unpackTar } from '../lib/node.js';
import { sampleFiles, sha256 } from './samples.mjs';

const run = promisify(execFile);
const { ATFE_HOME, ATFE_SYSROOT, MICROBIT_SAMPLES } = process.env;
const ready = ATFE_HOME && ATFE_SYSROOT && MICROBIT_SAMPLES;

test('the native toolchain replays the packaged recipe to the same hex', {
  skip: ready ? false : 'set ATFE_HOME, ATFE_SYSROOT and MICROBIT_SAMPLES',
}, async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('codal/manifest.json', root), 'utf8'));
  const payload = flatten(unpackTar(await readFile(new URL('codal/payload.tar', root))));

  const work = await mkdtemp(path.join(tmpdir(), 'codal-replay-'));
  for (const [name, content] of Object.entries(payload)) await write(work, name, content);

  const files = await sampleFiles(MICROBIT_SAMPLES);
  for (const [name, content] of Object.entries(files)) {
    await write(work, `${manifest.layout.project}/${name}`, content);
  }

  const recipe = plan(manifest, Object.keys(files), { sysroot: ATFE_SYSROOT });
  await mkdir(path.join(work, manifest.layout.build, 'user'), { recursive: true });

  let hex = null;
  for (const step of recipe.steps) {
    const { stdout } = await run(path.join(ATFE_HOME, 'bin', step.tool), step.args, {
      cwd: work,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (step.captureStdout) hex = stdout;
  }

  assert.equal(sha256(hex), sha256(await readFile(path.join(MICROBIT_SAMPLES, 'MICROBIT.hex'))));
});

async function write(root, name, content) {
  const full = path.join(root, name);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}
