# microbit-clang-wasm-codal

**Builds a BBC micro:bit C++ program to a hex file, in a browser or in Node, with nothing
installed.** Give it your sources, get back the hex, the link map, and the compiler's output both as
text and read into errors and warnings. It also lists what can be typed at a position, for an
editor's completions.

It is not a copy of CODAL on npm. Three things come together here: CODAL prebuilt as static
libraries, **the build recipe captured from CODAL's own native CMake build** so the flags are the
ones the supported toolchain uses rather than a hand-written imitation, and the logic that drives
[microbit-clang-wasm](https://github.com/carlosperate/microbit-clang-wasm)'s WebAssembly Clang
through the compile, link and hex steps. The CODAL sources ship too: a program can include any
header in the tree, and a `codal.json` with other settings has CODAL compiled from them.

On a desktop you install `arm-none-eabi-gcc` and provide CODAL yourself through
[microbit-v2-samples](https://github.com/lancaster-university/microbit-v2-samples). Here the
compiler is the toolchain package and CODAL is this one, so a browser, Node or a VS Code extension
can build a micro:bit program with nothing else installed and nothing downloaded at run time.

Status: pre-release, work in progress.

## Using it

```js
import { compile } from 'microbit-clang-wasm-codal';

const { ok, hex, map, output, diagnostics } = await compile({ 'main.cpp': source });
```

`compile` takes the user's files, keyed by workspace-relative path, and returns the Intel hex to
flash, the link map, and everything the tools wrote to stderr. On a compile or link error `ok` is
false, `hex` is null, and `output` names the file, by the path you gave, with its line and column.
Every source is compiled even after one fails, so each file's errors are there; the link runs only
once they all compiled.

`diagnostics` holds the errors and warnings, read by
[microbit-clang-wasm](https://github.com/carlosperate/microbit-clang-wasm)'s `readDiagnostics`:
file, line, column, message, the warning option, the notes and the include chain. Your files are
named as you named them, the linker's references included; CODAL's own headers appear as
`codal/...` and the C and C++ libraries as `/usr/...`. A linker note pointing into CODAL's prebuilt
libraries, such as where a symbol you also defined lives, names the path they were built at, which
exists on no machine you have. Each of `steps` carries its own output read the same way, summary
lines included, so joining their `text` gives that step's `stderr` back.

**Key order is link order.** The objects are numbered in the order the sources arrive and linked in
that order, so hand them over sorted, or in whatever fixed order you choose, if you want the same
bytes from the same input every time.

**C++ only for now** (`.cpp`, `.cc`, `.cxx`): the package carries one compile recipe, taken from a
C++ translation unit, so a `.c` file is rejected rather than quietly compiled as C++. Headers can be
any name, and go in the same object. Builds are serialised, so a second `compile` while one is
running waits rather than overwriting it.

Two options: `onStep` is called with each tool's arguments, exit code and output as it finishes, for
a build log that streams; `signal` is an `AbortSignal`, and aborting stops the build between steps
and rejects with the signal's reason.

```js
await compile(files, { onStep: (step) => console.log(step.tool, step.exitCode), signal: controller.signal });
```

## Completions

`complete` lists what can go at a position in one of your files, for an editor's completion list:
the members after `uBit.` or `uBit.display.`, anything in scope, a call's overloads, with each
one's type, parameters, defaults and the first sentence of CODAL's documentation. It runs the same
recipe and `codal.json` settings a build would, up to the position, and compiles no CODAL, so a
changed `codal.json` changes the list at once.

```js
import { complete } from 'microbit-clang-wasm-codal';

const { completions } = await complete({ 'main.cpp': source }, { file: 'main.cpp', line: 7, column: 10 });
```

It needs only the file, the headers it may include and `codal.json`. The line counts from 1 and the
column in bytes of UTF-8, as Clang does. The records are
[microbit-clang-wasm](https://github.com/carlosperate/microbit-clang-wasm)'s `readCompletions`,
with your own file names, and of the 14,000 macros CODAL brings in only the ones a program passes
to it or gets back: component IDs (`MICROBIT_ID_BUTTON_A`), event values
(`MICROBIT_BUTTON_EVT_CLICK`), listen flags (`MESSAGE_BUS_LISTENER_IMMEDIATE`), the event service's
(`MES_…`) and error codes (`MICROBIT_OK`, `MICROBIT_NO_DATA`). Your own `#define`s are listed too,
and so are the settings you write in `codal.json`'s `config`.
The deep-sleep members every CODAL component inherits from `CodalComponent` are left out. A
request takes a tenth to a quarter of a second in Node once loaded; the first after a
change of settings also lists CODAL's macros, about a quarter of a second more. Completions run in a filesystem of their
own, so one never waits for a build or changes it, and they queue only behind each other. A
`signal` aborted before a request starts drops it.

## Loading it

In Node the package reads its own files from disk. Anywhere else, hand it a loader for the two
assets it ships, `codal/manifest.json` and `codal/payload.tar`:

```js
import { createCodal } from 'microbit-clang-wasm-codal';

const codal = createCodal({ loadAsset: async (name) => bytesFor(name) });
```

## Your `codal.json`

Put a `codal.json` at the root of the files you pass, as in
[microbit-v2-samples](https://github.com/lancaster-university/microbit-v2-samples), and its
`config` settings take effect:

```js
await compile({ 'main.cpp': source, 'codal.json': '{ "config": { "MICROBIT_BLE_ENABLED": 1 } }' });
```

CODAL is shipped compiled with one set of settings, microbit-v2-samples' default: the SoftDevice
present and the BLE stack off. Every setting is a `#define` in a header that all of CODAL is
compiled with, so other settings mean compiling CODAL again: 199 files, about 15 to 30 seconds in a
browser on a recent laptop. CODAL comes first and your own files after it, so a log reads in order.
CODAL's steps come through `onStep` like any other, with a `codal` field naming the file each
built (`codal-core/source/core/CodalFiber.cpp`, `libcodal-core.a`) and how many are done. The result is kept in memory for the next build with the same settings, four sets
at most, and nothing is saved anywhere.

The header is made by the same rule as CODAL's CMake: your settings in the order you wrote them,
then the defaults of CODAL's `target-locked.json` you did not set, numbers exactly as written
(`52.0` stays `52.0`), and `DEVICE_BLE` set to 1 also bringing the SoftDevice and its linker script.
Each value is written as it is, so a setting the compiler cannot use fails in the compiler.

`compile` rejects, before compiling anything, a `codal.json` it cannot follow, and the message says
what to change: one that is not valid JSON; a `target` other than the CODAL in this package (leave
`target` out, or name exactly this one); `application` or `output_folder`, since every C++ file you
pass is compiled and the hex comes back to you; a `config` that is not an object; and
`SOFTDEVICE_PRESENT` without `DEVICE_BLE` set to 1, which CODAL's own build refuses too. The
message's first line says what is wrong and what to do, short enough for a notification; anything
longer, such as the `"target"` to paste, follows on the lines after it, JSON laid out as in
`codal.json`. Without a `codal.json`, the shipped settings are used.

## What it does not do yet

- **One CODAL version**, v0.3.5. A `target` naming another is refused.
- **CODAL compiled for your settings is not saved.** It lasts as long as the package is loaded.

## How it is built

CI checks out the build harness named by `codal.buildSystem` in `package.json` — a
[microbit-v2-samples](https://github.com/carlosperate/microbit-v2-samples) fork carrying the CLANG
toolchain files — points it at the pinned CODAL with `tools/configure-harness.mjs`, builds it with
`CODAL_TOOLCHAIN=CLANG` against the Arm Toolchain for Embedded release the installed
`microbit-clang-wasm` was built from (`npm view microbit-clang-wasm llvm`), and runs
`tools/generate.mjs` over that build's own `ninja -t commands`. Everything authored is in
`package.json`; the ATfE release is deliberately not repeated here. The
recipe in `codal/manifest.json` is therefore the native build's flags, rewritten for a virtual
filesystem rather than written by hand: the compile for your files, CODAL's own 199 compiles and 4
archives, the link and the hex. Before that, CI builds the same checkout with the settings in
`test/configs/` for the tests below, each from clean.

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
    │   └┬┘  └┬┘
    │    │    └─── JS package version
    │    └──────── CODAL combined minor.patch (3.05)
    └───────────── CODAL major
```

So `~0.305.0` locks to CODAL v0.3.5 while taking packaging fixes. While the packaging of a CODAL
release is still changing it is published as a prerelease, `0.305.0-alpha.1`, under the `next`
dist-tag. Which CODAL is inside is pinned in `package.json` under `codal` — `buildSystem` names
the build harness, `codalJson` the keys written over its `codal.json` — and recorded in
`codal/manifest.json`.

## Tests

`npm test` compiles a program, checks the hex, and checks that errors in the program, in CODAL's
headers because of it, and at the link are read into diagnostics naming the caller's files; that a
`codal.json` with other settings compiles CODAL once and is then reused; the header rule and
every refusal; and what `complete` lists, which macros among it, and that a build running beside it
gives the same hex. It needs nothing installed.

Further tests compare against native builds, and run only when pointed at them:

```sh
MICROBIT_SAMPLES=<built samples tree> MICROBIT_CONFIGS=<one folder per test configuration> npm test
```

They compile that tree's own program through the WebAssembly compiler and require the hex to match
byte for byte: with the shipped CODAL, with CODAL compiled here for the same settings, and for each
configuration in `test/configs/`, whose header and command list must also match CMake's. That
agreement is what says the browser build is the same build. CI does it on every run, against native
builds made minutes earlier from the pinned sources, so there is no reference file here to go stale.

## Licences

Several, so `package.json` says `SEE LICENSE IN LICENSES`. This package's code is MIT, CODAL is MIT,
and the Nordic SDK sources and binary objects carry Nordic's licence, which permits use only with
Nordic Semiconductor chips. See [LICENSES](LICENSES).
