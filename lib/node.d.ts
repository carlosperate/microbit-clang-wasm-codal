export * from './index.js';

import type { Compile, Manifest } from './index.js';

/** Reads the package's own assets from disk, so no loader has to be supplied. */
export const compile: Compile;

export function manifest(): Promise<Manifest>;
