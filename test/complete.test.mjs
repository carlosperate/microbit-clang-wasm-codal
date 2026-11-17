// complete(): what can go at a position, by the recipe and the codal.json a build would use.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { ConfigError } from '../lib/index.js';
import { compile, complete } from '../lib/node.js';

// `@` is the cursor; the column counts bytes, as Clang does.
function at(source) {
  const index = source.indexOf('@');
  const before = source.slice(0, index);
  return {
    text: before + source.slice(index + 1),
    line: before.split('\n').length,
    column: new TextEncoder().encode(before.slice(before.lastIndexOf('\n') + 1)).length + 1,
  };
}

const program = (body) => `#include "MicroBit.h"\n\nMicroBit uBit;\n\nint main() {\n    uBit.init();\n${body}\n}\n`;

async function completeWith(source, extra = {}) {
  const { text, line, column } = at(source);
  const started = performance.now();
  const result = await complete({ 'main.cpp': text, ...extra }, { file: 'main.cpp', line, column });
  // A bound for a regression, not a measurement: a warm answer takes about a tenth of this.
  assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
  return result;
}

const completeIn = async (source, extra) => (await completeWith(source, extra)).completions;

const candidate = (records, name) => records.find((record) => record.kind === 'candidate' && record.name === name);
const type = (record) => record?.chunks.find((chunk) => chunk.kind === 'informative')?.text;

// The first request also loads the package, lists CODAL's macros and parses MicroBit.h for the first
// time; the bound below is for the rest.
before(() => complete({ 'main.cpp': at(program('@')).text }, { file: 'main.cpp', line: 7, column: 1 }));

test('uBit. lists its parts with their types', async () => {
  const records = await completeIn(program('    uBit.@'));
  assert.deepEqual(['display', 'buttonA', 'io', 'radio'].map((name) => type(candidate(records, name))),
    ['MicroBitDisplay', 'Button', 'MicroBitIO', 'MicroBitRadio']);
});

test('uBit.display. lists scroll with its documentation', async () => {
  const records = await completeIn(program('    uBit.display.@'));
  assert.match(candidate(records, 'scroll').brief, /^Scrolls the given string across the display/);
  // CodalComponent's deep-sleep plumbing, which every component inherits, is left out.
  assert.deepEqual(records.filter((record) => record.name?.startsWith('deepSleep')), []);
});

// Each from a header precompiled for its own settings: Clang refuses one made for others.
test('the settings in codal.json decide what is listed, with no CODAL compiled', async () => {
  const changed = await completeWith(program('    uBit.@'), { 'codal.json': JSON.stringify({ config: { DEVICE_BLE: 0 } }) });
  assert.equal(candidate(changed.completions, 'bleManager'), undefined);
  assert.equal(changed.precompiled, true);
  const prebuilt = await completeWith(program('    uBit.@'));
  assert.ok(candidate(prebuilt.completions, 'bleManager'), 'the prebuilt settings have it');
  assert.equal(prebuilt.precompiled, true);
});

// The header declares two builtins, reserved names an editor hides, and may reorder one name's overloads.
const comparable = (records) => records
  .filter((record) => record.kind !== 'opening-paren' && !record.name?.startsWith('__builtin_arm_'))
  .map((record) => JSON.stringify(record))
  .sort();

test('MicroBit.h comes precompiled, and lists what parsing it afresh lists', async () => {
  for (const body of ['    uBit.@', '    uBit.display.@', '    uBit.display.scroll(@', '    @']) {
    const fast = await completeWith(program(body));
    // A `;` first changes nothing in the program, and keeps the header out.
    const slow = await completeWith(`;\n${program(body)}`);
    assert.deepEqual([fast.precompiled, slow.precompiled], [true, false]);
    assert.deepEqual(comparable(fast.completions), comparable(slow.completions), body);
  }
});

test('a file with more than comments before the include completes as it builds, without the header', async () => {
  // Each prefix, and whether MicroBit.h is then included: precompiled, with uBit.'s members listed.
  const prefixes = [
    ['// A licence.\n/* More of it. */\n\n', true],
    // MicroBit.h's own guard, defined first, keeps it out of the build.
    ['#define MICROBIT_H\n', false],
    // Each comment ends at its first */, so the #define between two is seen.
    ['/* licence */\n#define MICROBIT_H\n/* why */\n', false],
    // The backslash carries the comment onto the include, so there is none.
    ['// note \\\n', false],
  ];
  for (const [prefix, included] of prefixes) {
    const { precompiled, completions } = await completeWith(`${prefix}${program('    uBit.@')}`);
    assert.deepEqual([precompiled, Boolean(candidate(completions, 'display'))], [included, included], prefix);
  }
  // The caller's own MicroBit.h could be the one an include finds.
  const own = await completeWith(program('    uBit.@'), { 'lib/MicroBit.h': '#pragma once\n' });
  assert.equal(own.precompiled, false);
});

// Within completeWith's time bound: a banner of slashes is read once, not tried every way it splits.
test('a banner comment before ordinary code is read in one pass', async () => {
  const banner = await completeWith(`${'/'.repeat(200)}\nint before;\n${program('    uBit.@')}`);
  assert.equal(banner.precompiled, false);
});

test('a position above the include completes as it builds, without the header', async () => {
  const above = await completeWith(`@\n${program('')}`);
  assert.equal(above.precompiled, false);
  assert.equal(candidate(above.completions, 'MicroBit'), undefined, 'MicroBit.h is not included yet');
});

test('of the macros, only those a program passes to CODAL are listed, and the user\'s own', async () => {
  const records = await completeIn(`#define MY_PIN 3\n${program('    @')}`);
  for (const name of ['MICROBIT_ID_BUTTON_A', 'MICROBIT_BUTTON_EVT_CLICK', 'MESSAGE_BUS_LISTENER_IMMEDIATE', 'MICROBIT_NO_DATA', 'MICROBIT_OK', 'MY_PIN']) {
    assert.ok(candidate(records, name), `${name} is listed`);
  }
  for (const name of ['GPIO_PIN_CNF_DIR_Pos', 'S113', 'MICROBIT_DISPLAY_H']) assert.equal(candidate(records, name), undefined, `${name} is not`);
});

test('a setting written in codal.json is listed, as a #define of the user\'s own would be', async () => {
  const records = await completeIn(program('    @'), { 'codal.json': JSON.stringify({ config: { MY_SETTING: 3 } }) });
  assert.ok(candidate(records, 'MY_SETTING'));
});

// CODAL defines ARRAY_SIZE as a macro, which a header that leaves out MicroBit.h may name a member.
test('a member that shares a CODAL macro\'s name is listed in a header without MicroBit.h', async () => {
  const { text, line, column } = at('struct Table { int ARRAY_SIZE; };\ninline int count(Table t) { return t.@ }\n');
  const { completions } = await complete({ 'main.cpp': program(''), 'source/table.h': text }, { file: 'source/table.h', line, column });
  assert.ok(candidate(completions, 'ARRAY_SIZE'));
});

test('a header completes on its own', async () => {
  const { text, line, column } = at('#pragma once\nstruct Helper { int level; };\ninline void use(Helper h) { h.@ }\n');
  const { completions } = await complete({ 'main.cpp': program(''), 'source/helper.h': text }, { file: 'source/helper.h', line, column });
  assert.ok(candidate(completions, 'level'));
});

test('inside a call, its overloads come with the opening parenthesis in the caller\'s file name', async () => {
  const records = await completeIn(program('    uBit.display.scroll(@'));
  assert.ok(records.some((record) => record.kind === 'overload'));
  const paren = records.find((record) => record.kind === 'opening-paren');
  assert.deepEqual([paren.file, paren.line], ['main.cpp', 7]);
});

// The two sessions take turns between tool runs, so this shows each keeps to its own files.
test('completing while a build runs leaves the build as it would be alone', async () => {
  const files = { 'main.cpp': program('    uBit.display.scroll("HI");') };
  const alone = await compile(files);
  const { text, line, column } = at(program('    uBit.display.@'));
  const [during] = await Promise.all([compile(files), complete({ 'main.cpp': text }, { file: 'main.cpp', line, column })]);
  assert.equal(alone.ok, true, alone.output);
  assert.equal(during.hex, alone.hex);
});

test('refuses what it cannot complete in, before running anything', async () => {
  const files = { 'main.cpp': program(''), 'helper.c': 'int f(void);\n' };
  await assert.rejects(complete(files, { file: 'helper.c', line: 1, column: 1 }), /only C\+\+ sources and headers/);
  await assert.rejects(complete(files, { file: 'other.cpp', line: 1, column: 1 }), /not among the files given/);
  await assert.rejects(complete({ ...files, 'codal.json': '{' }, { file: 'main.cpp', line: 1, column: 1 }), ConfigError);
  await assert.rejects(complete(files, { file: 'main.cpp' }), /is not a position/);
});

test('a request aborted before it starts is dropped', async () => {
  const controller = new AbortController();
  controller.abort(new Error('superseded'));
  await assert.rejects(complete({ 'main.cpp': program('') }, { file: 'main.cpp', line: 1, column: 1, signal: controller.signal }), /superseded/);
});

// A cancel arrives as a message or a timer, which a running request gives no chance to be delivered.
test('a request cancelled while the one before it runs is dropped', async () => {
  const { text, line, column } = at(program('    uBit.@'));
  const controller = new AbortController();
  const first = complete({ 'main.cpp': text }, { file: 'main.cpp', line, column });
  const second = complete({ 'main.cpp': text }, { file: 'main.cpp', line, column, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('superseded')), 0);
  assert.ok(candidate((await first).completions, 'display'));
  await assert.rejects(second, /superseded/);
});
