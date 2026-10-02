// The package's own promise: a user program in, a micro:bit hex out, with nothing downloaded.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sysroot } from 'microbit-clang-wasm';

import { compile, manifest } from '../lib/node.js';

// The same program the extension's Create Project writes, so what the tests build is what a user gets.
const PROGRAM = `#include "MicroBit.h"

MicroBit uBit;

int main() {
    uBit.init();
    while (true) {
        uBit.display.scroll("HELLO WORLD");
        uBit.sleep(1000);
    }
}
`;

// Nothing here may reach the network: both packages ship every file they need. A throwing stub says
// so far more directly than watching for requests.
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw new Error('the package tried to fetch something; it must load entirely from disk');
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

test('compiles a CODAL program to an Intel hex', async () => {
  const result = await compile({ 'main.cpp': PROGRAM });

  assert.equal(result.ok, true, result.output);
  assert.match(result.hex, /^:/);
  assert.match(result.hex, /:00000001FF\s*$/); // the end-of-file record
  assert.ok(result.hex.length > 100_000, `hex looks too small: ${result.hex.length} bytes`);
  assert.ok(result.map.startsWith('     VMA      LMA     Size Align'), 'the link map is missing its header');
});

test('finds headers in subdirectories the way the native build does', async () => {
  const result = await compile({
    'main.cpp': '#include "project.h"\n#include "MicroBit.h"\nMicroBit uBit;\nint main() { uBit.init(); uBit.display.scroll(GREETING); }\n',
    'include/project.h': '#define GREETING "HI"\n',
  });

  assert.equal(result.ok, true, result.output);
});

test('serialises overlapping builds instead of letting them delete each other', async () => {
  const [first, second] = await Promise.all([
    compile({ 'main.cpp': PROGRAM }),
    compile({ 'main.cpp': PROGRAM.replace('HELLO', 'GOODBYE') }),
  ]);

  assert.equal(first.ok, true, first.output);
  assert.equal(second.ok, true, second.output);
  assert.notEqual(first.hex, second.hex, 'the two programs differ, so their hexes should too');
});

test('reports each step as it finishes, and an aborted build stops at the next step', async () => {
  const seen = [];
  const result = await compile({ 'main.cpp': PROGRAM }, { onStep: (step) => seen.push(step.tool) });

  assert.equal(result.ok, true, result.output);
  assert.deepEqual(seen, result.steps.map((step) => step.tool));

  const controller = new AbortController();
  const aborted = compile({ 'main.cpp': PROGRAM }, { signal: controller.signal, onStep: () => controller.abort() });
  await assert.rejects(aborted, { name: 'AbortError' });
  // The queue survives an abort: the next build runs normally.
  assert.equal((await compile({ 'main.cpp': PROGRAM })).ok, true);
});

test('stops for an abort that arrives from outside the build, as a host\'s does', async () => {
  const controller = new AbortController();
  // Not from onStep: a host aborts from a message or a timer, which is only ever delivered if the
  // build hands the event queue back between steps.
  const timer = setTimeout(() => controller.abort(), 0);

  await assert.rejects(compile({ 'main.cpp': PROGRAM }, { signal: controller.signal }), { name: 'AbortError' });
  clearTimeout(timer);
});

test('rejects sources it has no recipe for, and paths the filesystem cannot hold', async () => {
  await assert.rejects(compile({ 'main.c': 'int main(void) { return 0; }\n' }), /only C\+\+ sources/);
  // Beside a valid .cpp too, or half the program would be dropped from a build reported as ok.
  await assert.rejects(compile({ 'main.cpp': PROGRAM, 'extra.c': 'int f(void);\n' }), /only C\+\+ sources/);
  await assert.rejects(compile({ '/main.cpp': PROGRAM }), /is absolute/);
  await assert.rejects(compile({ '../main.cpp': PROGRAM }), /empty or relative segment/);
});

test('reports a compile error with the file, line and column', async () => {
  const result = await compile({ 'main.cpp': 'int main() { oops; }\n' });

  assert.equal(result.ok, false);
  // Named as the caller named it, not by its place in the virtual filesystem.
  assert.match(result.output, /(^|\s)main\.cpp:1:14: error: use of undeclared identifier 'oops'/);
  assert.equal(result.hex, null);
  assert.equal(result.steps.at(-1).exitCode, 1);
});

// Every file a record names is the caller's, CODAL's or the toolchain's, never the virtual project's.
function assertNamesOwn(result, files) {
  const named = result.diagnostics.flatMap((record) => [record, ...record.notes, ...record.includedFrom]).map((at) => at.file);
  for (const file of named.filter((file) => file !== null)) {
    assert.ok(file in files || file.startsWith('codal/') || file.startsWith(`${sysroot}/`), `a record names ${file}`);
  }
}

test('reads the errors into diagnostics, with each file named as the caller named it', async () => {
  const result = await compile({ 'main.cpp': 'int main() { oops; }\n' });

  const [error] = result.diagnostics;
  assert.deepEqual([error.severity, error.file, error.line, error.column], ['error', 'main.cpp', 1, 14]);
  assert.equal(result.steps[0].diagnostics.map((record) => record.text).join(''), result.steps[0].stderr);
});

test('a macro that breaks CODAL\'s headers leads back to the caller\'s #define and #include', async () => {
  const files = { 'main.cpp': `#define Button 42\n${PROGRAM}` };
  const result = await compile(files);

  assert.equal(result.ok, false);
  // With a file only: past Clang's limit of 20 comes a "too many errors" with none.
  const errors = result.diagnostics.filter((record) => record.severity === 'error' && record.file !== null);
  assert.ok(errors.length > 1 && errors.every((error) => error.file.startsWith('codal/')));
  assert.ok(errors.some((error) => error.notes.some((note) => note.file === 'main.cpp' && note.line === 1)), 'a note names the #define');
  assert.ok(errors.every((error) => error.includedFrom.at(-1)?.file === 'main.cpp'), 'each chain ends at the caller\'s #include');
  assertNamesOwn(result, files);
});

test('a wrong call into CODAL is the caller\'s error, with CODAL\'s candidates as notes', async () => {
  const files = { 'main.cpp': PROGRAM.replace('uBit.display.scroll("HELLO WORLD");', 'uBit.display.scroll(1, 2, 3, 4, 5);') };
  const result = await compile(files);

  const error = result.diagnostics.find((record) => record.severity === 'error');
  assert.deepEqual([error.file, error.line], ['main.cpp', 8]);
  assert.ok(error.notes.length > 0 && error.notes.every((note) => note.file.startsWith('codal/')));
  assertNamesOwn(result, files);
});

test('a link error names the caller\'s file where the symbol is used', async () => {
  const files = { 'main.cpp': `void missing();\n${PROGRAM.replace('uBit.init();', 'uBit.init();\n    missing();')}` };
  const result = await compile(files);

  assert.equal(result.ok, false);
  const error = result.diagnostics.find((record) => record.severity === 'error');
  assert.deepEqual([error.file, error.message], [null, 'undefined symbol: missing()']);
  assert.deepEqual(error.notes.map((note) => [note.file, note.line]), [['main.cpp', 8]]);
  assert.match(result.output, /\(main\.cpp:8\)/);
  assertNamesOwn(result, files);
});

test('compiles every source before stopping, so two broken files report both', async () => {
  const result = await compile({ 'a.cpp': 'int a() { return nope; }\n', 'main.cpp': 'int main() { oops; }\n' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map((step) => step.exitCode), [1, 1], 'two compiles, and no link');
  assert.deepEqual(result.diagnostics.filter((record) => record.severity === 'error').map((error) => error.file), ['a.cpp', 'main.cpp']);
});

test('rewrites only the paths the package made, not a bracket in a name or a message', async () => {
  const named = await compile({ 'folder(project/source/nested)/main.cpp': 'int main() { oops; }\n' });
  assert.equal(named.diagnostics[0].file, 'folder(project/source/nested)/main.cpp');

  const said = await compile({ 'main.cpp': 'static_assert(false, "bad (/project/source/example)");\nint main() {}\n' });
  assert.equal(said.diagnostics[0].message, 'static assertion failed: bad (/project/source/example)');
  assert.match(said.output, /\| static_assert\(false, "bad \(\/project\/source\/example\)"\);/);
});

test('keeps the caller\'s own path when it looks like the virtual project\'s', async () => {
  const result = await compile({ 'project/source/main.cpp': 'int main() { oops; }\n' });

  assert.equal(result.ok, false);
  // Only the prefix this package added comes off, not the directory the caller named.
  assert.match(result.output, /(^|\s)project\/source\/main\.cpp:1:14: error:/);
});

// What the extension's Create Project writes, which is the prebuilt configuration.
const CODAL_JSON = {
  target: { name: 'codal-microbit-v2', url: 'https://github.com/lancaster-university/codal-microbit-v2', branch: 'v0.3.5', type: 'git' },
  config: { MICROBIT_BLE_ENABLED: 0, MICROBIT_BLE_PAIRING_MODE: 0 },
};

test('a codal.json it cannot follow rejects before compiling anything', async () => {
  const steps = [];
  const wrong = JSON.stringify({ ...CODAL_JSON, target: { ...CODAL_JSON.target, branch: 'master' } });

  await assert.rejects(compile({ 'main.cpp': PROGRAM, 'codal.json': wrong }, { onStep: (step) => steps.push(step) }), {
    name: 'ConfigError',
    message: /only codal-microbit-v2 v0\.3\.5/,
  });
  assert.equal(steps.length, 0);
});

test('the prebuilt settings in codal.json compile no CODAL', async () => {
  const result = await compile({ 'main.cpp': PROGRAM, 'codal.json': JSON.stringify(CODAL_JSON, null, 4) });

  assert.equal(result.ok, true, result.output);
  assert.ok(result.steps.every((step) => step.codal === null));
});

test('other settings compile CODAL once, before the program\'s own files, then reuse it', async () => {
  const ble = JSON.stringify({ ...CODAL_JSON, config: { ...CODAL_JSON.config, MICROBIT_BLE_ENABLED: 1 } });
  const reference = await compile({ 'main.cpp': PROGRAM });

  const first = await compile({ 'main.cpp': PROGRAM, 'codal.json': ble });
  assert.equal(first.ok, true, first.output);
  const codal = first.steps.filter((step) => step.codal !== null);
  assert.equal(codal.length, codal[0].codal.total);
  assert.deepEqual(codal.map((step) => step.codal.done), codal.map((_, index) => index + 1));
  // Named as a reader knows them, not by the package's own folders.
  assert.ok(codal.some((step) => step.codal.file === 'codal-core/source/core/CodalFiber.cpp'));
  assert.equal(codal.at(-1).codal.file, 'libcodal-microbit-v2.a');
  assert.deepEqual(first.steps.slice(0, codal.length), codal, 'CODAL compiles before the program');
  assert.equal(first.steps[codal.length].source, 'main.cpp');

  // A broken program with the same settings: its errors, and no CODAL again.
  const broken = await compile({ 'main.cpp': 'int main() { oops; }\n', 'codal.json': ble });
  assert.equal(broken.ok, false);
  assert.ok(broken.steps.every((step) => step.codal === null));

  const again = await compile({ 'main.cpp': PROGRAM, 'codal.json': ble });
  assert.ok(again.steps.every((step) => step.codal === null), 'kept from the first build');
  assert.equal(again.hex, first.hex);

  // Back to the prebuilt settings, whose archives the rebuild replaced in the session.
  const prebuilt = await compile({ 'main.cpp': PROGRAM });
  assert.ok(prebuilt.steps.every((step) => step.codal === null));
  assert.equal(prebuilt.hex, reference.hex, 'the prebuilt archives are back');
});

test('declares the toolchain and CODAL versions it was built with', async () => {
  const packaged = await manifest();
  const { version } = await import('microbit-clang-wasm');

  assert.equal(packaged.toolchain.package, 'microbit-clang-wasm');
  // Both packages carry a prerelease part until their packaging settles.
  assert.match(packaged.toolchain.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  assert.match(packaged.toolchain.llvm.commit, /^[0-9a-f]{40}$/);
  // The hex tests below prove the recipe against whichever toolchain is installed; that is only
  // evidence about the package we ship if the two are the same one.
  assert.equal(packaged.toolchain.version, version, 'the installed toolchain is not the one declared');
  assert.match(packaged.codal.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packaged.codal.libraries.length, 4);
  assert.match(packaged.digest, /^[0-9a-f]{64}$/);
});
