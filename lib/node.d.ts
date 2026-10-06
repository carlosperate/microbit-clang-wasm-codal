export * from './index.js';

import type { Compile, Complete, Manifest } from './index.js';

/** Reads the package's own assets from disk, so no loader has to be supplied. */
export const compile: Compile;

export const complete: Complete;

export function manifest(): Promise<Manifest>;
