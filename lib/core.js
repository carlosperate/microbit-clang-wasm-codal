// Compiles a user program against CODAL: the prebuilt archives, or CODAL compiled here for the
// settings in the caller's codal.json.
//
// The recipes come from `codal/manifest.json`, generated from the native build's own command list,
// so this runs the flags the native toolchain runs.

import { createSession, readDiagnostics, sysroot } from 'microbit-clang-wasm';

import { CONFIG_HEADER, configure } from './config.js';
import { SOURCE, plan } from './recipe.js';
import { unpackTar } from './tar.js';

// C++ only: the manifest carries one compile recipe, taken from a C++ translation unit, so a .c file
// would be compiled as C++ and fail on valid C. A C recipe means capturing one in the generator.
const UNSUPPORTED_SOURCE = /\.(c|s|S|asm)$/;

// At the root of the caller's files, as the native harness reads it from its own root.
const CODAL_JSON = 'codal.json';

// Configurations CODAL was compiled for, kept besides the prebuilt one: about 8 MB of archives each.
const KEEP = 4;

/**
 * @param {{ loadAsset: (name: string) => Promise<Uint8Array> | Uint8Array }} options
 */
export function createCodal({ loadAsset } = {}) {
  if (typeof loadAsset !== 'function') {
    throw new Error('createCodal needs a loadAsset(name) function to read this package\'s codal/ files');
  }

  // The promise, not its result: two callers arriving before the first finishes would otherwise
  // each build a session. Dropped again if it fails, so a failed asset read can be retried.
  let loaded = null;
  const load = () => (loaded ??= open(loadAsset).catch((error) => {
    loaded = null;
    throw error;
  }));

  // One session means one filesystem at fixed paths, so builds have to be serialised: a second one
  // starting mid-build would delete the first one's sources under it.
  let queue = Promise.resolve();

  const build = async (files, { onStep, signal } = {}) => {
    signal?.throwIfAborted();
    const codal = await load();
    const { manifest, session } = codal;
    // Checked whether or not there are C++ sources: skipping a .c file that sits beside a .cpp one
    // would report a successful build of only half the program.
    const unsupported = Object.keys(files).filter((name) => UNSUPPORTED_SOURCE.test(name));
    if (unsupported.length) {
      throw new Error(`only C++ sources are supported for now, and these are not: ${unsupported.join(', ')}`);
    }
    const sources = Object.keys(files).filter((name) => SOURCE.test(name));
    if (sources.length === 0) throw new Error('no source file to compile; expected at least one .cpp');
    for (const name of Object.keys(files)) assertWorkspacePath(name);

    const given = files[CODAL_JSON];
    const { header, softdevice } = configure(
      given === undefined ? codal.defaultJson : typeof given === 'string' ? given : new TextDecoder().decode(given),
      codal.targetJson,
      manifest.codal.target
    );
    const recipe = plan(manifest, Object.keys(files), { sysroot, softdevice });
    signal?.throwIfAborted();
    for (const path of recipe.stale) await session.remove(path);
    for (const [name, content] of Object.entries(files)) {
      await session.writeFile(`${manifest.layout.project}/${name}`, content);
    }
    await session.writeFile(CONFIG_HEADER, header);

    const steps = [];
    const run = async (command, progress = null) => {
      // A whole build is one unbroken chain of microtasks, so an abort arriving as a message or a
      // timer is never delivered while it runs. This hands the event queue back between steps.
      if (signal) await new Promise((resolve) => setTimeout(resolve, 0));
      // Between steps only: a tool already running cannot be interrupted, so it finishes first.
      signal?.throwIfAborted();
      const step = { ...(await invoke(session, command, manifest.layout.project)), codal: progress };
      steps.push(step);
      onStep?.(step);
      return step.exitCode === 0;
    };

    // CODAL first, so a log reads in order: the libraries, then the program built on them.
    let archives = codal.archivesFor(header);
    if (!archives) {
      // Removed first, as in a clean native build: a tool writing over an existing file in the
      // toolchain's filesystem leaves the old one in place, exit code 0.
      codal.current = null;
      for (const path of recipe.codalOutputs) await session.remove(path);
      for (const [index, command] of recipe.codal.entries()) {
        if (!(await run(command, { done: index + 1, total: recipe.codal.length, file: command.file }))) return failure(steps);
      }
      archives = {};
      for (const path of recipe.archives) archives[path] = await session.readFile(path);
      codal.keep(header, archives);
    }
    // Null after any rebuild, finished or not, so the session's archives are always rewritten then.
    if (codal.current !== header) {
      for (const [path, bytes] of Object.entries(archives)) await session.writeFile(path, bytes);
      codal.current = header;
    }

    // Every source is compiled, so each file's errors are reported; only the link needs them all.
    let compiled = true;
    for (const command of recipe.compiles) compiled = (await run(command)) && compiled;
    if (!compiled) return failure(steps);

    let hex = null;
    for (const command of recipe.tail) {
      if (!(await run(command))) return failure(steps);
      if (command.captureStdout) hex = steps.at(-1).stdout;
    }

    const map = await session.readFile(recipe.map);
    return {
      ok: true,
      hex: new TextDecoder().decode(hex),
      map: map === null ? null : new TextDecoder().decode(map),
      ...report(steps),
    };
  };

  return {
    async manifest() {
      return (await load()).manifest;
    },

    /**
     * @param {Record<string, string | Uint8Array>} files user sources and headers, workspace-relative
     * @param {{ onStep?: (step: object) => void, signal?: AbortSignal }} options
     */
    compile(files, options) {
      const result = queue.then(() => build(files, options));
      queue = result.then(() => {}, () => {}); // a failed build must not poison the queue
      return result;
    },
  };
}

// Names go into a virtual filesystem that resolves `..` and an empty segment to nothing, so a path
// clang then cannot open. Rejecting here says which file, rather than leaving a puzzling error.
function assertWorkspacePath(name) {
  const bad =
    name.startsWith('/') ? 'is absolute'
    : name.includes('\\') ? 'uses backslashes'
    : name.split('/').some((part) => part === '' || part === '.' || part === '..') ? 'has an empty or relative segment'
    : null;
  if (bad) throw new Error(`file name ${JSON.stringify(name)} ${bad}; give a path relative to the workspace`);
}

// One session for the life of the package: it holds the unpacked sysroot and the CODAL payload, so
// only the first build pays for putting a filesystem together. The session's archives are those of
// the configuration in `current`, the prebuilt one to start with.
async function open(loadAsset) {
  const manifest = JSON.parse(new TextDecoder().decode(await loadAsset('codal/manifest.json')));
  const session = createSession();
  await session.writeTree(unpackTar(await loadAsset('codal/payload.tar')));
  const text = async (path) => new TextDecoder().decode(await session.readFile(path));

  const prebuilt = { header: await text(CONFIG_HEADER), archives: {} };
  for (const { output } of manifest.library.archives) prebuilt.archives[output] = await session.readFile(output);
  const built = new Map();

  return {
    manifest,
    session,
    defaultJson: await text('codal/codal.json'),
    targetJson: await text(`codal/libraries/${manifest.codal.target.name}/target-locked.json`),
    current: prebuilt.header,
    archivesFor(header) {
      if (header === prebuilt.header) return prebuilt.archives;
      const archives = built.get(header);
      if (archives) {
        built.delete(header); // to the back, as the most recently used
        built.set(header, archives);
      }
      return archives ?? null;
    },
    keep(header, archives) {
      built.set(header, archives);
      if (built.size > KEEP) built.delete(built.keys().next().value);
    },
  };
}

// Only the capturing step keeps its stdout; the others would hold a copy of the hex for nothing.
// Diagnostics name files as the caller did, so the virtual project prefix comes off them before
// they are read, one step at a time, since an include chain carries over only within one run.
async function invoke(session, { source = null, tool, args, captureStdout }, project) {
  const chunks = [];
  const decoder = new TextDecoder();
  let stderr = '';

  const exitCode = await session.run([tool, ...args], {
    stdout: captureStdout ? (bytes) => bytes && chunks.push(Uint8Array.from(bytes)) : null,
    stderr: (bytes) => bytes && (stderr += decoder.decode(bytes, { stream: true })),
  });
  stderr = stripProject(stderr + decoder.decode(), project);
  return { source, tool, args, exitCode, stderr, stdout: captureStdout ? join(chunks) : null, diagnostics: readDiagnostics(stderr) };
}

// Only where a path starts is the prefix ours: a caller whose own file sits under `project/source/`
// gets it twice in the virtual path, and removing both would name a file they do not have. The
// linker's `>>>` lines also give it absolute, in parentheses: `(/project/source/main.cpp:7)`.
function stripProject(text, project) {
  const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`(^|\\s)${escaped}/`, 'gm'), '$1')
    .replace(new RegExp(`^(>>> .*?\\()/${escaped}/`, 'gm'), '$1');
}

function report(steps) {
  return {
    output: steps.map((step) => step.stderr).join(''),
    diagnostics: steps.flatMap((step) => step.diagnostics.filter((record) => record.severity !== null)),
    steps,
  };
}

function failure(steps) {
  return { ok: false, hex: null, map: null, ...report(steps) };
}

function join(chunks) {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
