// The samples repository's own program, as both hex tests need it. Shared so the two cannot compile
// slightly different programs and still both pass.

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

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
