// Turns the manifest into the exact commands a build runs, each with the files it writes.

const SYSROOT_TOKEN = '{sysroot}';

export const SOURCE = /\.(cc|cpp|cxx)$/;

/**
 * @param {object} manifest from codal/manifest.json
 * @param {string[]} names every user file, workspace-relative, sources in link order
 * @param {{ sysroot: string, softdevice: boolean }} options where the toolchain's libraries and
 *   headers are mounted, and whether the configuration links the SoftDevice's linker script
 */
export function plan(manifest, names, { sysroot, softdevice }) {
  const fill = filler(sysroot);
  const { project, build } = manifest.layout;
  const sources = names.filter((name) => SOURCE.test(name));
  const { scripts } = manifest.link;
  const script = (args) => (softdevice ? args : args.map((arg) => (arg === scripts.softdevice ? scripts.plain : arg)));

  // Indexed, because flattening the path would collide `a/b.cpp` with `a_b.cpp` and link one object
  // twice.
  const objects = sources.map((name, index) => `${build}/user/${index}-${name.split('/').pop()}.obj`);
  const flags = userFlags(manifest, names, fill);

  return {
    compiles: sources.map((name, index) => ({
      source: name,
      tool: manifest.compile.tool,
      args: [...flags, '-c', `${project}/${name}`, '-o', objects[index]],
      outputs: [objects[index]],
    })),
    // CODAL's own build, run only when no archives exist yet for this configuration. Each names what
    // it builds as a reader knows it: a source within CODAL's libraries, or an archive.
    codal: [
      ...manifest.library.compiles.map(({ tool, args, source, output }) => ({
        tool,
        args: fill(args),
        outputs: [output],
        file: source.replace(/^codal\/libraries\//, ''),
      })),
      ...manifest.library.archives.map(({ tool, args, output }) => ({ tool, args: fill(args), outputs: [output], file: output.split('/').pop() })),
    ],
    tail: [
      {
        tool: manifest.link.tool,
        args: script([...fill(manifest.link.flagsBefore), ...objects, ...fill(manifest.link.flagsAfter)]),
        outputs: [manifest.link.output, manifest.link.map].filter(Boolean),
      },
      // objcopy writes the hex to stdout: wasi-libc has no chmod, and objcopy otherwise fails
      // mirroring the input's permissions onto a file it has already written correctly.
      { tool: manifest.objcopy.tool, args: fill(manifest.objcopy.args), outputs: [], captureStdout: true },
    ],
    // The last build's own files and objects, which none of this one's outputs would replace.
    stale: [project.split('/')[0], `${build}/user`],
    map: manifest.link.map,
  };
}

/**
 * The user compile recipe run up to a position rather than compiled, macros listed with the rest,
 * and a header parsed on its own as C++. `-E -dM` in place of the completion flags lists every
 * macro the same flags define.
 * @param {string[]} names every user file, workspace-relative, for the include directories
 * @param {{ sysroot: string }} options
 * @param {{ file: string, line: number, column: number } | null} at the position, null for `-E -dM`
 * @param {string} path the file to run on, in the session
 */
export function completion(manifest, names, { sysroot }, at, path) {
  // No warnings: CODAL's headers raise dozens on every request, and a list has no use for them.
  const run = at
    ? ['-fsyntax-only', '-w', '-Xclang', `-code-completion-at=${path}:${at.line}:${at.column}`,
        '-Xclang', '-code-completion-brief-comments', '-Xclang', '-code-completion-macros']
    : ['-E', '-dM'];
  return { tool: manifest.compile.tool, args: [...userFlags(manifest, names, filler(sysroot)), ...run, '-x', 'c++', path] };
}

const filler = (sysroot) => (args) => args.map((arg) => arg.replace(SYSROOT_TOKEN, sysroot));

function userFlags(manifest, names, fill) {
  const { project } = manifest.layout;
  return [...fill(manifest.compile.flags), ...headerDirectories(names).map((dir) => `-I${dir ? `${project}/${dir}` : project}`)];
}

// The native build's rule (CMake RECURSIVE_FIND_DIR in microbit-v2-samples): every directory holding
// a .h, then every one holding a .hpp, without duplicates. '' is the project root.
function headerDirectories(names) {
  const directoriesOf = (pattern) =>
    [...new Set(names.filter((name) => pattern.test(name)).map((name) => name.slice(0, Math.max(0, name.lastIndexOf('/')))))].sort();
  const h = directoriesOf(/\.h$/);
  return [...h, ...directoriesOf(/\.hpp$/).filter((dir) => !h.includes(dir))];
}
