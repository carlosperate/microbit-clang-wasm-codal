// Browser and bundler entry point. The host supplies the two assets, because there is no filesystem
// to read them from: see lib/node.js for what that looks like when there is one.

export { createCodal } from './core.js';
export { packTar, unpackTar, flatten } from './tar.js';
