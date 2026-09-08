// The package's own promise: a user program in, a micro:bit hex out, with nothing downloaded.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { compile, manifest } from '../lib/node.js';

const BLINKY = `
#include "MicroBit.h"

MicroBit uBit;

int main() {
    uBit.init();
    while (true) {
        uBit.display.scroll("HI");
        uBit.sleep(500);
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
  const result = await compile({ 'main.cpp': BLINKY });

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
    compile({ 'main.cpp': BLINKY }),
    compile({ 'main.cpp': BLINKY.replace('HI', 'HO') }),
  ]);

  assert.equal(first.ok, true, first.output);
  assert.equal(second.ok, true, second.output);
  assert.notEqual(first.hex, second.hex, 'the two programs differ, so their hexes should too');
});

test('rejects sources it has no recipe for, and paths the filesystem cannot hold', async () => {
  await assert.rejects(compile({ 'main.c': 'int main(void) { return 0; }\n' }), /only C\+\+ sources/);
  // Beside a valid .cpp too, or half the program would be dropped from a build reported as ok.
  await assert.rejects(compile({ 'main.cpp': BLINKY, 'extra.c': 'int f(void);\n' }), /only C\+\+ sources/);
  await assert.rejects(compile({ '/main.cpp': BLINKY }), /is absolute/);
  await assert.rejects(compile({ '../main.cpp': BLINKY }), /empty or relative segment/);
});

test('reports a compile error with the file, line and column', async () => {
  const result = await compile({ 'main.cpp': 'int main() { oops; }\n' });

  assert.equal(result.ok, false);
  assert.match(result.output, /main\.cpp:1:14: error: use of undeclared identifier 'oops'/);
  assert.equal(result.hex, null);
  assert.equal(result.steps.at(-1).exitCode, 1);
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
