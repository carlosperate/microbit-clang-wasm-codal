# Changelog

## 0.305.0-alpha.1

First release: builds a BBC micro:bit C++ program to a hex, in a browser or in Node, with nothing
installed.

- Ships CODAL v0.3.5 prebuilt, in the configuration `microbit-v2-samples` uses by default, with the
  complete source and header trees so any header a program includes is there.
- The build recipe is taken from CODAL's own CMake build rather than written by hand, so the
  compiler flags are the ones the supported toolchain uses.
- The hex is byte for byte identical to the one the native Clang toolchain produces, checked on
  every CI run against a native build made from the same pinned sources.
- `compile(files)` returns the hex, the link map and the compiler's output. Errors name the file by
  the path you gave, with the line and column.
- `onStep` reports each tool as it finishes and an `AbortSignal` stops a build between steps, so a
  host can show progress and cancel.
- C++ only for now, and `codal.json` is fixed. Changing the configuration means compiling CODAL from
  source, which comes later.
- Alpha while the packaging settles, so it is published under the `next` tag on npm and not under
  `latest`.
