// Compiles a user program against the prebuilt CODAL in this package.
//
// The recipes come from `codal/manifest.json`, generated from the native build's own command list,
// so this runs the flags the native toolchain runs.

import { createSession, sysroot } from 'microbit-clang-wasm';

import { SOURCE, plan } from './recipe.js';
import { unpackTar } from './tar.js';

// C++ only: the manifest carries one compile recipe, taken from a C++ translation unit, so a .c file
// would be compiled as C++ and fail on valid C. A C recipe means capturing one in the generator.
const UNSUPPORTED_SOURCE = /\.(c|s|S|asm)$/;

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

  const build = async (files, { log } = {}) => {
    const { manifest, session } = await load();
    // Checked whether or not there are C++ sources: skipping a .c file that sits beside a .cpp one
    // would report a successful build of only half the program.
    const unsupported = Object.keys(files).filter((name) => UNSUPPORTED_SOURCE.test(name));
    if (unsupported.length) {
      throw new Error(`only C++ sources are supported for now, and these are not: ${unsupported.join(', ')}`);
    }
    const sources = Object.keys(files).filter((name) => SOURCE.test(name));
    if (sources.length === 0) throw new Error('no source file to compile; expected at least one .cpp');
    for (const name of Object.keys(files)) assertWorkspacePath(name);

    const recipe = plan(manifest, Object.keys(files), { sysroot });
    for (const path of recipe.stale) await session.remove(path);
    for (const [name, content] of Object.entries(files)) {
      await session.writeFile(`${manifest.layout.project}/${name}`, content);
    }

    const steps = [];
    let hex = null;
    for (const command of recipe.steps) {
      const step = await invoke(session, command);
      steps.push(step);
      log?.(`${command.tool} ${step.exitCode === 0 ? 'ok' : `failed (${step.exitCode})`}`);
      if (step.exitCode !== 0) return failure(steps);
      if (command.captureStdout) hex = step.stdout;
    }

    const map = await session.readFile(recipe.map);
    return {
      ok: true,
      hex: new TextDecoder().decode(hex),
      map: map === null ? null : new TextDecoder().decode(map),
      output: steps.map((step) => step.stderr).join(''),
      steps,
    };
  };

  return {
    async manifest() {
      return (await load()).manifest;
    },

    /**
     * @param {Record<string, string | Uint8Array>} files user sources and headers, workspace-relative
     * @param {{ log?: (message: string) => void }} options
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
// only the first build pays for putting a filesystem together.
async function open(loadAsset) {
  const manifest = JSON.parse(new TextDecoder().decode(await loadAsset('codal/manifest.json')));
  const session = createSession();
  await session.writeTree(unpackTar(await loadAsset('codal/payload.tar')));
  return { manifest, session };
}

// Only the capturing step keeps its stdout; the others would hold a copy of the hex for nothing.
async function invoke(session, { tool, args, captureStdout }) {
  const chunks = [];
  const decoder = new TextDecoder();
  let stderr = '';

  const exitCode = await session.run([tool, ...args], {
    stdout: captureStdout ? (bytes) => bytes && chunks.push(Uint8Array.from(bytes)) : null,
    stderr: (bytes) => bytes && (stderr += decoder.decode(bytes, { stream: true })),
  });
  return { tool, args, exitCode, stderr: stderr + decoder.decode(), stdout: captureStdout ? join(chunks) : null };
}

function failure(steps) {
  return { ok: false, hex: null, map: null, output: steps.map((step) => step.stderr).join(''), steps };
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
