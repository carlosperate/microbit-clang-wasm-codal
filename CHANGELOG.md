# Changelog

## 0.305.0-alpha.2 - Unreleased

- `compile` also returns `diagnostics`: every error and warning read into a record, with file, line,
  column, the warning option, the notes and the include chain, for an editor to show each one at
  its line. Each step carries its own output read the same way.
- A linker error names your file too: `(main.cpp:7)` rather than the package's internal path.
- Every source is compiled even after one fails, so two broken files report both files' errors.
  Only the link waits for all of them.
- Built with `microbit-clang-wasm` 21.11.0-alpha.2, which brings the diagnostics reader.

## 0.305.0-alpha.1 - 2026-09-10

First release: builds a BBC micro:bit C++ program to a hex, in a browser or in Node, with nothing
else installed.

- Ships CODAL v0.3.5 prebuilt, in the configuration `microbit-v2-samples` uses by default, with the
  complete source and header trees so any header a program includes is there.
- The build recipe is taken from CODAL's own CMake build rather than written by hand, so the
  compiler flags are the ones the supported toolchain uses.
- `compile(files)` returns the hex, the link map and the compiler's output. Errors name the file by
  the path you gave, with the line and column.
- `onStep` reports each tool as it finishes and an `AbortSignal` stops a build between steps, so a
  host can show progress and cancel.
- C++ only for now, and `codal.json` is fixed. Changing the configuration means compiling CODAL from
  source, which comes later.
- Alpha while the packaging settles, so it is published under the `next` tag on npm and not under
  `latest`.
