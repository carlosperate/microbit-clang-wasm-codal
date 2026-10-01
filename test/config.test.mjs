// codal.json to CODAL's config header, without a compiler. CI also compares the BLE and
// DEVICE_BLE=0 headers with CMake's own (configurations.test.mjs); these are the rules around them.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { ConfigError, configure } from '../lib/config.js';
import { flatten, unpackTar } from '../lib/tar.js';

const payload = flatten(unpackTar(await readFile(new URL('../codal/payload.tar', import.meta.url))));
const { codal } = JSON.parse(await readFile(new URL('../codal/manifest.json', import.meta.url), 'utf8'));
const text = (path) => new TextDecoder().decode(payload[path]);
const TARGET_JSON = text(`codal/libraries/${codal.target.name}/target-locked.json`);

const header = (config) => configure(JSON.stringify({ config }), TARGET_JSON, codal.target);
const refusal = (json) => () => configure(typeof json === 'string' ? json : JSON.stringify(json), TARGET_JSON, codal.target);

test('the prebuilt codal.json gives the prebuilt header, CMake\'s, byte for byte', () => {
  const { header, softdevice } = configure(text('codal/codal.json'), TARGET_JSON, codal.target);
  assert.equal(header, text('codal/codal_extra_definitions.h'));
  assert.equal(softdevice, true);
});

test('writes the caller\'s settings first, in file order, then the target\'s they did not set', () => {
  const lines = header({ ZED: 1, DEVICE_STACK_SIZE: 4096, ALPHA: 'x' }).header.split('\n');
  assert.deepEqual(lines.slice(0, 3), [' #define ZED\t 1', ' #define DEVICE_STACK_SIZE\t 4096', ' #define ALPHA\t x']);
  assert.equal(lines.filter((line) => line.startsWith(' #define DEVICE_STACK_SIZE\t')).length, 1);
});

test('keeps a number as written and a string\'s text, as CMake does', () => {
  const written = configure('{ "config": { "LEVEL": 60.0, "BIG": 1e3, "NAME": "\\"hi\\"" } }', TARGET_JSON, codal.target).header;
  assert.match(written, /^ #define LEVEL\t 60\.0\n #define BIG\t 1e3\n #define NAME\t "hi"\n/);
  // The target's own 52.0 too, which JSON.parse would have turned into 52.
  assert.match(written, / #define LEVEL_DETECTOR_SPL_8BIT_000_POINT\t 52\.0\n/);
});

test('a setting written twice takes its last value', () => {
  const { header: written } = configure('{ "config": { "TWICE": 1, "TWICE": 2 } }', TARGET_JSON, codal.target);
  assert.deepEqual(written.split('\n').filter((line) => line.includes('TWICE')), [' #define TWICE\t 2']);
});

test('writes an odd value plainly and leaves it to the compiler', () => {
  assert.match(header({ F: 1.5, LIST: [1, 2], ON: true }).header, /^ #define F\t 1\.5\n #define LIST\t \[1,2\]\n #define ON\t true\n/);
});

test('the SoftDevice follows DEVICE_BLE written as 1, and CODAL refuses SOFTDEVICE_PRESENT without it', () => {
  assert.equal(header({ DEVICE_BLE: 0 }).softdevice, false);
  assert.doesNotMatch(header({ DEVICE_BLE: 0 }).header, /SOFTDEVICE_PRESENT/);
  assert.equal(header({ DEVICE_BLE: '1' }).softdevice, true);
  assert.equal(header({ DEVICE_BLE: true }).softdevice, false);
  assert.ok(header({ DEVICE_BLE: 1 }).header.endsWith('\n #define SOFTDEVICE_PRESENT    1'));

  assert.throws(refusal({ config: { DEVICE_BLE: 0, SOFTDEVICE_PRESENT: 1 } }), /Do not define SOFTDEVICE_PRESENT in your configuration, use DEVICE_BLE instead/);
  assert.equal(header({ SOFTDEVICE_PRESENT: 1 }).softdevice, true, 'with DEVICE_BLE 1, CODAL\'s own build accepts it');
});

test('accepts a codal.json with no target or no config, and the target in any key order', () => {
  assert.doesNotThrow(refusal({ config: {} }));
  assert.doesNotThrow(refusal({ target: codal.target }));
  const reversed = Object.fromEntries(Object.entries(codal.target).reverse());
  assert.doesNotThrow(refusal({ target: reversed, config: {} }));
});

test('refuses what it cannot follow, saying what to write instead', () => {
  const refuses = (json, message) => assert.throws(refusal(json), (error) => error instanceof ConfigError && message.test(error.message));

  refuses('{ "config": { "A": 1, } }', /not valid JSON at line 1, column 23: expected a quoted name, found "}"/);
  refuses('{ "config": {\n  "A": 1\n  "B": 2 } }', /line 3, column 3: expected "}"/);
  refuses('[]', /has to hold one JSON object/);
  // The first line says it all; the block to paste follows, laid out as codal.json is.
  refuses({ target: { ...codal.target, branch: 'master' } }, new RegExp(`only ${codal.target.name} ${codal.target.branch}, so remove "target" or set it to exactly that one\\.\n"target": \\{\n    "name": "${codal.target.name}",\n`));
  refuses({ target: { ...codal.target, dev: true } }, /asks for a CODAL this build does not have/);
  refuses({ application: 'src' }, /sets "application".*Remove "application" from codal\.json/);
  refuses({ output_folder: 'out' }, /sets "output_folder".*Remove "output_folder" from codal\.json/);
  refuses({ config: [1] }, /"config" in codal\.json has to be an object of settings/);
  refuses({ config: null }, /"config" in codal\.json has to be an object of settings/);
});
