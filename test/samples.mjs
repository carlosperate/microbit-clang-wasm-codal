// The samples repository's own program, as every hex test needs it, and the one way they compare a
// hex. Shared so no two can compile slightly different programs and still both pass.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** main.cpp first, then the samples alphabetically: link order decides the layout. */
export async function sampleFiles(samples) {
  const files = { 'main.cpp': await readFile(path.join(samples, 'source/main.cpp')) };
  for (const name of (await readdir(path.join(samples, 'source/samples'))).sort()) {
    if (/\.(cpp|h)$/.test(name)) files[`samples/${name}`] = await readFile(path.join(samples, 'source/samples', name));
  }
  return files;
}

/** The build succeeded and its hex is the one in `file`, byte for byte. */
export async function assertHex(result, file) {
  assert.equal(result.ok, true, result.output);
  assert.equal(sha256(Buffer.from(result.hex)), sha256(await readFile(file)));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
