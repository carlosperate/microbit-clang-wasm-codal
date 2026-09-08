# microbit-clang-wasm-codal

**Builds a BBC micro:bit C++ program to a hex file, in a browser or in Node, with nothing
installed.** Give it your sources, get back the hex, the link map and the compiler's output.

It is not a copy of CODAL on npm. Three things come together here: CODAL prebuilt as static
libraries, **the build recipe captured from CODAL's own native CMake build** so the flags are the
ones the supported toolchain uses rather than a hand-written imitation, and the logic that drives
[microbit-clang-wasm](https://github.com/carlosperate/microbit-clang-wasm)'s WebAssembly Clang
through the compile, link and hex steps. The CODAL sources ship too, because a program can include
any header in the tree.

On a desktop you install `arm-none-eabi-gcc` and provide CODAL yourself through
[microbit-v2-samples](https://github.com/lancaster-university/microbit-v2-samples). Here the
compiler is the toolchain package and CODAL is this one, so a browser, Node or a VS Code extension
can build a micro:bit program with nothing else installed and nothing downloaded at run time.

Status: pre-release, work in progress. Nothing is published yet.

## Using it

```js
import { compile } from 'microbit-clang-wasm-codal';

const { ok, hex, map, output } = await compile({ 'main.cpp': source });
```

`compile` takes the user's files, keyed by workspace-relative path, and returns the Intel hex to
flash, the link map, and everything the tools wrote to stderr. On a compile or link error `ok` is
false, `hex` is null, and `output` names the file, line and column.

**C++ only for now** (`.cpp`, `.cc`, `.cxx`): the package carries one compile recipe, taken from a
C++ translation unit, so a `.c` file is rejected rather than quietly compiled as C++. Headers can be
any name, and go in the same object. Builds are serialised, so a second `compile` while one is
running waits rather than overwriting it.

In Node the package reads its own files from disk. Anywhere else, hand it a loader for the two
assets it ships, `codal/manifest.json` and `codal/payload.tar`:

```js
import { createCodal } from 'microbit-clang-wasm-codal';

const codal = createCodal({ loadAsset: async (name) => bytesFor(name) });
```

## What it does not do yet

- **`codal.json` is fixed.** This version ships one configuration, prebuilt: the repository default
  from microbit-v2-samples, which has the SoftDevice present but the BLE stack off. Changing the
  configuration means rebuilding CODAL, which comes later.
- **No CODAL sources are compiled.** The four archives ship prebuilt; the complete source and header
  trees are here so that any header a program reaches is present, but nothing recompiles them.
- No diagnostics beyond the compiler's own text, no worker pool, no object cache.

## How it is built

CI checks out the build harness named by `codal.buildSystem` in `package.json` — a
[microbit-v2-samples](https://github.com/carlosperate/microbit-v2-samples) fork carrying the CLANG
toolchain files — points it at the pinned CODAL with `tools/configure-harness.mjs`, builds it with
`CODAL_TOOLCHAIN=CLANG` against the Arm Toolchain for Embedded release the installed
`microbit-clang-wasm` was built from (`npm view microbit-clang-wasm llvm`), and runs
`tools/generate.mjs` over that build's own `ninja -t commands`. Everything authored is in
`package.json`; the ATfE release is deliberately not repeated here. The
recipe in `codal/manifest.json` is therefore the native build's flags, rewritten for a virtual
filesystem rather than written by hand.

```sh
node tools/configure-harness.mjs <harness checkout>    # then build it with CODAL_TOOLCHAIN=CLANG
node tools/generate.mjs --samples <harness checkout> --out .
npm test
```

## Versioning scheme

The package version follows `MAJOR.MINOR.PATCH`, but it combines the CODAL version with the version
of this package's own build logic, where:

- MAJOR is the CODAL major version
- MINOR is the CODAL minor and patch versions joined as one number, the patch padded to two digits:
  CODAL 0.3.5 → `305`, CODAL 0.2.71 → `271`
- PATCH is a single number for the packaging: the recipe, the JavaScript, the payload

```
    0 . 305 . 2
    │   └┬┘   └┬┘
    │    │     └── packaging version
    │    └──────── CODAL minor.patch (3.05)
    └───────────── CODAL major
```

So `~0.305.0` locks to CODAL 0.3.5 while taking packaging fixes. While the packaging of a CODAL
release is still changing it is published as a prerelease, `0.305.0-alpha.1`, under the `next`
dist-tag. Which CODAL is inside is pinned in `package.json` under `codal` — `buildSystem` names
the build harness, `codalJson` the keys written over its `codal.json` — and recorded in
`codal/manifest.json`.

## Tests

`npm test` compiles a program, checks the hex and checks an error is reported usefully. Two further
tests run only when they are given what they need, and both compare against the hex the native
toolchain produced:

```sh
MICROBIT_SAMPLES=<built samples tree> npm test
ATFE_HOME=<ATfE install> ATFE_SYSROOT=<flat sysroot> MICROBIT_SAMPLES=<tree> npm test
```

The first replays this package's recipe through the WebAssembly compiler, the second through the
native one from a directory holding nothing else. Both have to reproduce the reference hex byte for
byte; that agreement is what says the browser build is the same build.

## Licences

Several, so `package.json` says `SEE LICENSE IN LICENSES`. This package's code is MIT, CODAL is MIT,
and the Nordic SDK sources and binary objects carry Nordic's licence, which permits use only with
Nordic Semiconductor chips. See [LICENSES](LICENSES).
