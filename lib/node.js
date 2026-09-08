// Node entry point: the assets come off disk, so nothing is fetched and nothing has to be supplied.

import { readFile } from 'node:fs/promises';

import { createCodal } from './core.js';

export * from './index.js';

let codal = null;
const shared = () => (codal ??= createCodal({ loadAsset: (name) => readFile(new URL(`../${name}`, import.meta.url)) }));

/** @type {import('./index.js').Compile} */
export const compile = (files, options) => shared().compile(files, options);

export const manifest = () => shared().manifest();
