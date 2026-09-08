// The payload travels as one tar, so a path the header cannot hold is a file the compiler cannot
// find. CODAL's nRF5 SDK paths are well past the 100 bytes a plain ustar name field allows.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { flatten, packTar, unpackTar } from '../lib/tar.js';

const bytes = (text) => new TextEncoder().encode(text);

test('round-trips files, including sizes that are not a block multiple', () => {
  const entries = {
    'codal/a.h': bytes('#pragma once\n'),
    'codal/deep/b.h': new Uint8Array(1000).fill(7),
    'build/empty.a': new Uint8Array(0),
  };

  assert.deepEqual(flatten(unpackTar(packTar(entries))), entries);
});

test('splits a path too long for the name field at a slash', () => {
  const long = `codal/libraries/codal-microbit-nrf5sdk/nRF5SDK/components/libraries/bootloader/dfu/${'x'.repeat(60)}.h`;
  assert.ok(long.length > 100, 'the fixture has to exercise the prefix field');

  const back = flatten(unpackTar(packTar({ [long]: bytes('ok') })));
  assert.deepEqual(Object.keys(back), [long]);
});

test('an archive cannot reach Object.prototype through a __proto__ entry', () => {
  const tree = unpackTar(packTar({ '__proto__/polluted': bytes('x') }));

  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(flatten(tree)), ['__proto__/polluted']);
});

test('refuses a truncated or corrupt archive instead of returning short files or hanging', () => {
  const archive = packTar({ 'a.h': new Uint8Array(1000).fill(1) });

  assert.throws(() => unpackTar(archive.subarray(0, 600)), /does not hold/);

  const corrupt = archive.slice();
  corrupt[0] ^= 0xff; // a flipped byte in the name no longer matches the stored checksum
  assert.throws(() => unpackTar(corrupt), /checksum/);
});

test('refuses a path no ustar header can hold', () => {
  const impossible = `${'d'.repeat(160)}/${'f'.repeat(120)}.h`;
  assert.throws(() => packTar({ [impossible]: bytes('x') }), /too long for a ustar header/);
});
