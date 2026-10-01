// Points a CODAL build harness checkout at the CODAL this package pins: package.json's
// `codal.codalJson` over its codal.json, and libraries/ removed, as the build keeps any checkout.
// `--config` then swaps in a test configuration and leaves libraries/ as it is.
//
// Usage: node tools/configure-harness.mjs <harness checkout> [--config <file holding a config object>]

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ options: { config: { type: 'string' } }, allowPositionals: true });
const harness = positionals[0];
if (!harness) throw new Error('usage: configure-harness.mjs <harness checkout> [--config <file>]');

const { codal } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const codalJsonPath = path.join(harness, 'codal.json');
const codalJson = { ...JSON.parse(await readFile(codalJsonPath, 'utf8')), ...codal.codalJson };
if (values.config) codalJson.config = JSON.parse(await readFile(values.config, 'utf8'));

await writeFile(codalJsonPath, JSON.stringify(codalJson, null, 4) + '\n');
if (!values.config) await rm(path.join(harness, 'libraries'), { recursive: true, force: true });

console.log(`${codalJsonPath}: target ${codalJson.target.name} at ${codalJson.target.branch}`);
