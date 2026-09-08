// Turns a native CLANG build of microbit-v2-samples into this package's payload.
//
// Keeps the three recipes a user program needs — compile one file, link it against the prebuilt
// archives, make the hex — and drops CODAL's own 199 compiles, whose archives ship prebuilt.
//
// Usage: node tools/generate.mjs --samples <built samples tree> --out <package dir>
//        [--commands <ninja -t commands output>]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { packTar } from '../lib/tar.js';
import { tokenise } from './tokenise.mjs';

const { values: args } = parseArgs({
  options: {
    samples: { type: 'string' },
    out: { type: 'string' },
    commands: { type: 'string' },
  },
});
if (!args.samples || !args.out) throw new Error('usage: generate.mjs --samples <tree> --out <dir>');

const SAMPLES = path.resolve(args.samples);
const OUT = path.resolve(args.out);

// Ninja recorded the tree under the path it was configured with, which on macOS is the /tmp form of
// a /private/tmp path. Both spellings have to be rewritten, longest first so the specific one wins.
const sourceAliases = [
  ...new Set([
    SAMPLES,
    SAMPLES.replace(/^\/private\/tmp\//, '/tmp/'),
    SAMPLES.startsWith('/tmp/') ? `/private${SAMPLES}` : SAMPLES,
  ]),
].sort((a, b) => b.length - a.length);

// Dependency files and colour are host build concerns; the sysroot becomes a token the runner fills
// in, since it is /usr inside the toolchain package and a real directory in the native replay.
const DROP_FLAGS = new Set(['-MMD', '-fcolor-diagnostics']);
const DROP_FLAGS_WITH_VALUE = new Set(['-MT', '-MF']);
const SYSROOT_TOKEN = '--sysroot={sysroot}';

// Longest prefix first; the bare source root has to come last.
const pathMap = [
  ['/libraries', 'codal/libraries'],
  ['/build/libraries/codal-core/gen', 'codal/gen'],
  ['/build/codal_extra_definitions.h', 'codal/codal_extra_definitions.h'],
  ['/utils/cmake/toolchains', 'codal/toolchain'],
  ['/source', 'project/source'],
  ['/build', 'build'],
];

const commandsFile = args.commands ? path.resolve(args.commands) : path.join(SAMPLES, 'ninja-commands.txt');
const steps = parseCommands(await readFile(commandsFile, 'utf8'));

const appCompiles = steps.filter((step) => step.kind === 'compile' && step.input.startsWith('project/'));
const links = steps.filter((step) => step.kind === 'link');
const objcopies = steps.filter((step) => step.kind === 'objcopy');
if (appCompiles.length === 0) throw new Error('no application compile found; was the hex target captured?');
if (links.length !== 1) throw new Error(`expected exactly one link step, found ${links.length}`);
if (objcopies.length !== 1) throw new Error(`expected exactly one objcopy step, found ${objcopies.length}`);

// Every application file has to compile the same way, or "the flags for a user file" is a fiction.
const compileFlags = flagsOf(appCompiles[0]);
for (const compile of appCompiles.slice(1)) {
  const other = flagsOf(compile);
  if (JSON.stringify(other) !== JSON.stringify(compileFlags)) {
    throw new Error(`application files do not share one flag set; ${compile.input} differs from ${appCompiles[0].input}`);
  }
}

// The user's own files replace the sample objects, so the link splits around them. They are
// contiguous in the line CMake generates, and everything after them is CODAL's.
const link = links[0];
const appObjects = new Set(appCompiles.map((compile) => compile.output));
const firstObject = link.args.findIndex((arg) => appObjects.has(arg));
const lastObject = link.args.findLastIndex((arg) => appObjects.has(arg));
if (firstObject === -1) throw new Error('the link line names none of the application objects');
const between = link.args.slice(firstObject, lastObject + 1).filter((arg) => !appObjects.has(arg));
if (between.length) throw new Error(`the application objects are not contiguous in the link line: ${between[0]}`);

const payload = await collectPayload();
const codal = await describeSources();
const recipe = {
  compile: { tool: appCompiles[0].tool, flags: compileFlags },
  link: {
    tool: link.tool,
    flagsBefore: portable(dropInertIncludes(link.args.slice(0, firstObject))),
    flagsAfter: portable(dropInertIncludes(link.args.slice(lastObject + 1))),
    output: link.output,
    // Read back from the flag that writes it, so the two cannot drift.
    map: link.args.map((arg) => arg.match(/^-Wl,-Map[,=](.+)$/)?.[1]).find(Boolean) ?? null,
  },
  objcopy: { tool: objcopies[0].tool, args: portable(objcopies[0].args) },
};

// The package version encodes the CODAL release as MAJOR.(100 × minor + patch).ours, so it has to
// agree with the CODAL that was actually built: 0.305.x means CODAL 0.3.5 and nothing else.
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const [major, encoded] = packageJson.version.split('.').map(Number);
const claimed = `${major}.${Math.floor(encoded / 100)}.${encoded % 100}`;
if (claimed !== codal.version) {
  throw new Error(`package version ${packageJson.version} claims CODAL ${claimed}, but ${codal.version} was built`);
}
codal.pin = packageJson.codal.codalJson.target.branch;

const manifest = {
  schema: 1,
  generated: new Date().toISOString().slice(0, 10),
  codal,
  // Read from the installed toolchain, the only thing that knows what it was built from.
  toolchain: await describeToolchain(),
  config: JSON.parse(await readFile(path.join(SAMPLES, 'codal.json'), 'utf8')).config ?? {},
  layout: { build: 'build', project: 'project/source' },
  ...recipe,
  // Covers the recipe as well as the files: a cache keyed on this must miss when a flag changes.
  digest: digest(payload, JSON.stringify(recipe)),
};

checkRecipeInputsExist(payload);

const tar = packTar(payload);
await mkdir(path.join(OUT, 'codal'), { recursive: true });
await writeFile(path.join(OUT, 'codal/payload.tar'), tar);
await writeFile(path.join(OUT, 'codal/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const bytes = Object.values(payload).reduce((total, file) => total + file.length, 0);
console.log(`payload ${Object.keys(payload).length} files, ${(bytes / 1048576).toFixed(1)} MB, tar ${(tar.length / 1048576).toFixed(1)} MB`);
console.log(`CODAL ${codal.version} (${codal.versionHash}), digest ${manifest.digest.slice(0, 16)}`);

// A ninja command line is shell commands joined by &&, with `cd` setting the cwd of what follows and
// `:` as a no-op placeholder. Every cwd in this build is the build directory, which is our default.
function parseCommands(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    for (const part of line.split(' && ')) {
      const argv = tokenise(part.trim());
      if (argv.length === 0 || argv[0] === ':' || argv[0] === 'cd') continue;
      const step = normalise(argv);
      if (step) out.push(step);
    }
  }
  return out;
}

function normalise(argv) {
  const tool = path.basename(argv[0]);
  if (tool === 'llvm-size') return null; // informational, not part of producing the hex

  const args = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '') continue; // CMake leaves empty tokens where a variable expanded to nothing
    if (DROP_FLAGS.has(arg)) continue;
    if (DROP_FLAGS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    // ATfE's newlib-nano.cfg is one line, `--sysroot <CFGDIR>/../lib/clang-runtimes/newlib-nano`,
    // and atfe-sysroot.sh flattens that tree to the one variant we ship. Any other config file is
    // an unknown equivalence, so refuse rather than pass it through.
    if (arg.startsWith('--config=')) {
      if (arg !== '--config=newlib-nano.cfg') throw new Error(`unrecognised config file: ${arg}`);
      args.push(SYSROOT_TOKEN);
      continue;
    }
    args.push(rewrite(arg, argv[i - 1] === '-o'));
  }

  const kind =
    tool === 'llvm-ar' ? 'archive'
    : tool === 'llvm-objcopy' ? 'objcopy'
    : args.includes('-c') ? 'compile'
    : 'link';

  const at = args.indexOf('-o');
  const output = at === -1 ? null : args[at + 1];

  // llvm-objcopy mirrors the input file's permissions onto its output, which WASI cannot do, so it
  // exits non-zero having written a good hex. Its own code skips that when the output is stdout.
  if (kind === 'objcopy') {
    const target = args[args.length - 1];
    return { kind, tool, args: [...args.slice(0, -1), '-'], stdoutTo: path.basename(target) };
  }
  if (kind === 'compile') return { kind, tool, args, output, input: args[args.indexOf('-c') + 1] };
  return { kind, tool, args, output };
}

// Rewrites one argument's path into the package's virtual root: an absolute path through pathMap,
// a relative one as build-directory-relative, which is what ninja's cwd makes it.
function rewrite(arg, isOutput = false) {
  const [prefix, target] = splitPath(arg, isOutput);
  if (target === null) return arg;
  return prefix + (target.startsWith('/') ? fromSourceTree(target) : `build/${target}`);
}

// The path an argument carries, and whatever flag introduces it. A bare argument is a path when it
// looks like one or is a declared output — `-O ihex` is a bare argument that is not.
function splitPath(arg, isOutput = false) {
  if (!arg.startsWith('-')) {
    const isPath = isOutput || arg.includes('/') || /\.(a|o|obj|map|hex|ld)$/.test(arg);
    return ['', isPath ? arg : null];
  }
  const match = arg.match(/^(-(?:I|L|T|B|isystem)|--sysroot=|-Wl,-Map[,=])(.+)$/);
  return match ? [match[1], match[2]] : ['', null];
}

// `.` and `..` resolve for native clang but not in the WASI filesystem, so they are collapsed here.
function fromSourceTree(absolute) {
  const source = sourceAliases.find((alias) => absolute === alias || absolute.startsWith(alias + '/'));
  if (source === undefined) return absolute; // not ours: portable() rejects it rather than guessing
  const rest = absolute.slice(source.length) || '/';
  for (const [from, to] of pathMap) {
    if (rest === from || rest.startsWith(from + '/')) {
      const tail = rest.slice(from.length).replace(/^\/+/, '');
      return path.posix.normalize(tail ? `${to}/${tail}` : to);
    }
  }
  return path.posix.normalize(rest.slice(1)); // under the source root, but not a directory we map
}

// The flags a user file compiles with: everything but the input, the output and the project's own
// include paths, which the runner supplies for wherever the user's files actually live.
function flagsOf(compile) {
  const flags = [];
  for (let i = 0; i < compile.args.length; i++) {
    const arg = compile.args[i];
    if (arg === '-c' || arg === '-o') {
      i++;
      continue;
    }
    if (arg.startsWith('-I') && arg.slice(2).startsWith('project/')) continue;
    flags.push(arg);
  }
  return dropInertIncludes(portable(flags));
}

// CMake emits include paths for directories that do not exist, such as nrfx's per-chip template
// directory. Clang ignores them; carrying them into a virtual filesystem only invites a false
// "missing input" later, so they are dropped here and recorded on the manifest.
function dropInertIncludes(flags) {
  return flags.filter((flag) => {
    if (!flag.startsWith('-I')) return true;
    const source = sourcePathOf(flag.slice(2));
    return source === null || existsSync(source);
  });
}

// The reverse of pathMap, for asking the build tree whether a rewritten path was ever real.
function sourcePathOf(virtualPath) {
  for (const [from, to] of pathMap) {
    if (to === '') continue;
    if (virtualPath === to || virtualPath.startsWith(to + '/')) {
      return path.join(SAMPLES, from, virtualPath.slice(to.length));
    }
  }
  return null;
}

// Nothing above fails loudly if a path form is missed, so the invariants are checked rather than
// assumed: a host path or a `..` reaching clang surfaces much later as a confusing "file not found",
// on a consumer's machine rather than here. Every recipe goes through this, not just the compile.
function portable(args) {
  for (const arg of args) {
    if (sourceAliases.some((source) => arg.includes(source))) throw new Error(`argument still names the build tree: ${arg}`);
    if (/(^|[\/=])\.\.\//.test(arg)) throw new Error(`argument contains a '..' segment, which the WASI filesystem cannot resolve: ${arg}`);
    if (splitPath(arg)[1]?.startsWith('/')) throw new Error(`argument names an absolute path, which the bundle has no way to provide: ${arg}`);
  }
  return args;
}

// The payload is the virtual filesystem the recipes run against: the complete CODAL trees, the four
// prebuilt archives, and the headers CMake generated for this configuration.
async function collectPayload() {
  const skip = new Set(['.git', '.github', '.vscode']);
  // 15 MB of CMSIS register descriptions for debuggers, which no compile opens and every consumer
  // would otherwise hold in memory. A debugger that wants them can take them from CODAL itself.
  const skipExtension = /\.svd$/;
  const payload = {};

  const walk = async (dir, prefix) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (skip.has(entry.name)) continue;
      const from = path.join(dir, entry.name);
      const to = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(from, to);
      else if (entry.isFile() && !skipExtension.test(entry.name)) payload[to] = await readFile(from);
    }
  };
  await walk(path.join(SAMPLES, 'libraries'), 'codal/libraries');

  // The four archives are what this package ships instead of CODAL's 199 compiles.
  for (const entry of await readdir(path.join(SAMPLES, 'build'))) {
    if (/^libcodal-.*\.a$/.test(entry)) payload[`build/${entry}`] = await readFile(path.join(SAMPLES, 'build', entry));
  }

  payload['codal/gen/codal_version.h'] = await readFile(path.join(SAMPLES, 'build/libraries/codal-core/gen/codal_version.h'));
  payload['codal/codal_extra_definitions.h'] = await readFile(path.join(SAMPLES, 'build/codal_extra_definitions.h'));

  // CLANG/platform_includes.h only wraps the ARM_GCC one with `#include "../ARM_GCC/..."`, and that
  // `..` fails in the WASI filesystem. Its own comment says the two are identical, so the wrapper is
  // resolved here and the ARM_GCC file ships under the include path the build uses.
  payload['codal/toolchain/CLANG/platform_includes.h'] = await readFile(
    path.join(SAMPLES, 'utils/cmake/toolchains/ARM_GCC/platform_includes.h'),
  );

  return payload;
}

// Every include path and link input the recipes name has to be in the payload. Without this a
// missing file only shows up as a compile error in whichever consumer hits it first.
function checkRecipeInputsExist(payload) {
  const directories = new Set();
  for (const file of Object.keys(payload)) {
    const parts = file.split('/');
    for (let at = 1; at < parts.length; at++) directories.add(parts.slice(0, at).join('/'));
  }

  const missing = [];
  const recipe = [...manifest.compile.flags, ...manifest.link.flagsBefore, ...manifest.link.flagsAfter];
  for (let i = 0; i < recipe.length; i++) {
    if (recipe[i] === '-o') {
      i++; // the link's own output, written at build time
      continue;
    }
    const [prefix, entry] = splitPath(recipe[i]);
    // The sysroot arrives at run time, and the map is written rather than read.
    if (entry === null || entry === SYSROOT_TOKEN.split('=')[1] || prefix.startsWith('-Wl,-Map')) continue;
    if (!payload[entry] && !directories.has(entry)) missing.push(entry);
  }
  if (missing.length) throw new Error(`recipe input(s) missing from the payload: ${missing.join(', ')}`);
}

async function describeToolchain() {
  const path = new URL('../node_modules/microbit-clang-wasm/package.json', import.meta.url);
  const { name, version, llvm } = JSON.parse(await readFile(path, 'utf8'));
  return { package: name, version, llvm };
}

async function describeSources() {
  const version = await readFile(path.join(SAMPLES, 'build/libraries/codal-core/gen/codal_version.h'), 'utf8');
  const field = (name) => version.match(new RegExp(`define ${name}\\s+"?([^"\\s]+)"?`))?.[1];
  const libraries = [];
  for (const name of (await readdir(path.join(SAMPLES, 'libraries'))).sort()) {
    libraries.push({
      name,
      url: git(path.join(SAMPLES, 'libraries', name), ['remote', 'get-url', 'origin']),
      commit: git(path.join(SAMPLES, 'libraries', name), ['rev-parse', 'HEAD']),
    });
  }
  return {
    version: `${field('CODAL_VERSION_MAJOR')}.${field('CODAL_VERSION_MINOR')}.${field('CODAL_VERSION_PATCH')}`,
    versionHash: field('CODAL_VERSION_HASH'),
    samples: {
      url: git(SAMPLES, ['remote', 'get-url', 'origin']),
      commit: git(SAMPLES, ['rev-parse', 'HEAD']),
    },
    libraries,
  };
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null; // a source tree without git history is a warning at most, not a build failure
  }
}

function digest(payload, recipe) {
  const hash = createHash('sha256');
  hash.update(recipe);
  for (const name of Object.keys(payload).sort()) {
    hash.update(name);
    hash.update(payload[name]);
  }
  return hash.digest('hex');
}

