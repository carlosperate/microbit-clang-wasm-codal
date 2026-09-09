// The package's own promise: a user program in, a micro:bit hex out, with nothing downloaded.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

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

test('keeps the caller\'s own path when it looks like the virtual project\'s', async () => {
  const result = await compile({ 'project/source/main.cpp': 'int main() { oops; }\n' });

  assert.equal(result.ok, false);
  // Only the prefix this package added comes off, not the directory the caller named.
  assert.match(result.output, /(^|\s)project\/source\/main\.cpp:1:14: error:/);
});

test('declares the toolchain and CODAL versions it was built with', async () => {
  const packaged = await manifest();
  const { version } = await import('microbit-clang-wasm');

  assert.equal(packaged.toolchain.package, 'microbit-clang-wasm');
  assert.match(packaged.toolchain.version, /^\d+\.\d+\.\d+$/);
  assert.match(packaged.toolchain.llvm.commit, /^[0-9a-f]{40}$/);
  // The hex tests below prove the recipe against whichever toolchain is installed; that is only
  // evidence about the package we ship if the two are the same one.
  assert.equal(packaged.toolchain.version, version, 'the installed toolchain is not the one declared');
  assert.match(packaged.codal.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packaged.codal.libraries.length, 4);
  assert.match(packaged.digest, /^[0-9a-f]{64}$/);
});
