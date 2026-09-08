// Applies package.json's `codal.codalJson` to a checkout of the CODAL build harness, so the CODAL it
// builds is the one this package pins rather than whatever the harness's own codal.json names.
//
// Each top-level key in codalJson replaces the harness's; keys it does not name are kept. An
// existing libraries/ is removed, because the build leaves a checkout alone once it is there.
//
// Usage: node tools/configure-harness.mjs <harness checkout>

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const harness = process.argv[2];
if (!harness) throw new Error('usage: configure-harness.mjs <harness checkout>');

const { codal } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const codalJsonPath = path.join(harness, 'codal.json');
const codalJson = { ...JSON.parse(await readFile(codalJsonPath, 'utf8')), ...codal.codalJson };

await writeFile(codalJsonPath, JSON.stringify(codalJson, null, 4) + '\n');
await rm(path.join(harness, 'libraries'), { recursive: true, force: true });

console.log(`${codalJsonPath}: target ${codalJson.target.name} at ${codalJson.target.branch}`);
