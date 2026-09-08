// The generator reads real command lines, so a mangled token here becomes a wrong flag in a build
// that still succeeds. These are the forms ninja and CMake actually emit.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tokenise } from '../tools/tokenise.mjs';

test('splits on whitespace and keeps empty tokens out', () => {
  assert.deepEqual(tokenise('clang++  -c   main.cpp'), ['clang++', '-c', 'main.cpp']);
  assert.deepEqual(tokenise(''), []);
});

test('strips quotes, including a quoted tail on a flag', () => {
  assert.deepEqual(tokenise('-T"/a b/x.ld"'), ['-T/a b/x.ld']);
  assert.deepEqual(tokenise("-include '/a b/h.h'"), ['-include', '/a b/h.h']);
  assert.deepEqual(tokenise('"" -o out'), ['', '-o', 'out']);
});

test('handles the escapes a defined string macro brings', () => {
  assert.deepEqual(tokenise('-DNAME=\\"micro:bit\\"'), ['-DNAME="micro:bit"']);
  assert.deepEqual(tokenise('-DX="a\\"b"'), ['-DX=a"b']);
  // Inside double quotes a backslash is literal unless it escapes one of " \\ $ `
  assert.deepEqual(tokenise('"a\\nb"'), ['a\\nb']);
});

test('refuses a line it cannot split faithfully', () => {
  assert.throws(() => tokenise('clang "unterminated'), /unterminated double quote/);
  assert.throws(() => tokenise('clang trailing\\'), /trailing backslash/);
});
