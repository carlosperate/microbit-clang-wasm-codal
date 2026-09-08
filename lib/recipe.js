// Turns the manifest into the exact commands a build runs.
//
// Shared so the WebAssembly path and the native replay cannot interpret the same manifest
// differently: the runner is then the only difference between them, which is what the replay tests.

const SYSROOT_TOKEN = '{sysroot}';

export const SOURCE = /\.(cc|cpp|cxx)$/;

/**
 * @param {object} manifest from codal/manifest.json
 * @param {string[]} names every user file, workspace-relative, sources in link order
 * @param {{ sysroot: string }} options where the toolchain's libraries and headers are mounted
 */
export function plan(manifest, names, { sysroot }) {
  const fill = (args) => args.map((arg) => arg.replace(SYSROOT_TOKEN, sysroot));
  const { project, build } = manifest.layout;
  const sources = names.filter((name) => SOURCE.test(name));

  // Indexed, because flattening the path would collide `a/b.cpp` with `a_b.cpp` and link one object
  // twice.
  const objects = sources.map((name, index) => `${build}/user/${index}-${name.split('/').pop()}.obj`);
  const includes = headerDirectories(names).map((dir) => `-I${dir ? `${project}/${dir}` : project}`);

  return {
    steps: [
      ...sources.map((name, index) => ({
        tool: manifest.compile.tool,
        args: [...fill(manifest.compile.flags), ...includes, '-c', `${project}/${name}`, '-o', objects[index]],
      })),
      {
        tool: manifest.link.tool,
        args: [...fill(manifest.link.flagsBefore), ...objects, ...fill(manifest.link.flagsAfter)],
      },
      // objcopy writes the hex to stdout: wasi-libc has no chmod, and objcopy otherwise fails
      // mirroring the input's permissions onto a file it has already written correctly.
      { tool: manifest.objcopy.tool, args: fill(manifest.objcopy.args), captureStdout: true },
    ],
    // Cleared before a build, so nothing survives a run that failed halfway.
    stale: [project.split('/')[0], `${build}/user`, manifest.link.output, manifest.link.map],
    map: manifest.link.map,
  };
}

// The native build's rule (CMake RECURSIVE_FIND_DIR in microbit-v2-samples): every directory holding
// a .h, then every one holding a .hpp, without duplicates. '' is the project root.
function headerDirectories(names) {
  const directoriesOf = (pattern) =>
    [...new Set(names.filter((name) => pattern.test(name)).map((name) => name.slice(0, Math.max(0, name.lastIndexOf('/')))))].sort();
  const h = directoriesOf(/\.h$/);
  return [...h, ...directoriesOf(/\.hpp$/).filter((dir) => !h.includes(dir))];
}
