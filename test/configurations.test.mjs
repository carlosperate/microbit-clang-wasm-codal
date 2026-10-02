// The BLE and DEVICE_BLE=0 configurations against their native builds: the header CMake wrote, the
// commands ninja ran, and the hex. Only CI has those builds, made in the same checkout as the
// default one, so the command lists compare as text.
//
// Skipped unless MICROBIT_SAMPLES and MICROBIT_CONFIGS (a folder per configuration) are set.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { configure } from '../lib/config.js';
import { compile, manifest } from '../lib/node.js';
import { assertHex, sampleFiles } from './samples.mjs';

const { MICROBIT_SAMPLES: SAMPLES, MICROBIT_CONFIGS: CONFIGS } = process.env;
const skip = SAMPLES && CONFIGS ? false : 'set MICROBIT_SAMPLES and MICROBIT_CONFIGS to CI\'s native builds';
const names = skip ? [] : (await readdir(CONFIGS)).sort();
const read = (name, file) => readFile(path.join(CONFIGS, name, file), 'utf8');

test('has the configurations CI builds', { skip }, () => {
  assert.deepEqual(names, ['ble', 'no-softdevice']);
});

for (const name of names) {
  test(`${name}: the header is CMake's`, async () => {
    const { codal } = await manifest();
    const targetJson = await readFile(path.join(SAMPLES, 'libraries', codal.target.name, 'target-locked.json'), 'utf8');
    const { header } = configure(await read(name, 'codal.json'), targetJson, codal.target);
    assert.equal(header, await read(name, 'codal_extra_definitions.h'));
  });

  // A CODAL version adding settings-dependent CMake logic beyond DEVICE_BLE fails here.
  test(`${name}: ninja ran the default's commands, but for the linker script`, async () => {
    const own = (await read(name, 'ninja-commands.txt')).split('\n');
    const prebuilt = (await readFile(path.join(SAMPLES, 'ninja-commands.txt'), 'utf8')).split('\n');
    assert.equal(own.length, prebuilt.length);
    const differing = own.map((line, index) => [line, prebuilt[index]]).filter(([line, other]) => line !== other);
    for (const [line, other] of differing) assert.equal(line.replace('/nrf52833.ld', '/nrf52833-softdevice.ld'), other);
    assert.equal(differing.length, name === 'no-softdevice' ? 1 : 0);
  });

  test(`${name}: CODAL compiled here gives the native hex`, async () => {
    const result = await compile({ ...(await sampleFiles(SAMPLES)), 'codal.json': await read(name, 'codal.json') });
    await assertHex(result, path.join(CONFIGS, name, 'MICROBIT.hex'));
    assert.ok(result.steps.some((step) => step.codal !== null), 'CODAL was compiled');
  });
}
