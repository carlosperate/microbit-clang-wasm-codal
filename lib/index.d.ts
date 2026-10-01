/**
 * User files by workspace-relative path. **Key order is link order**, and the objects are numbered
 * by it, so a caller that wants a reproducible binary has to hand them over in a fixed order.
 * A `codal.json` at the root sets CODAL's configuration; without one the prebuilt is used.
 */
export type Files = Record<string, string | Uint8Array>;

import type { Diagnostic, OtherOutput } from 'microbit-clang-wasm';

export type { Diagnostic, DiagnosticLocation, DiagnosticNote, OtherOutput } from 'microbit-clang-wasm';

export type AssetLoader = (name: string) => Promise<Uint8Array> | Uint8Array;

export type Step = {
    /** The caller's file this step compiled, as they named it; null for CODAL's steps, the link and the hex. */
    source: string | null;
    tool: string;
    args: string[];
    exitCode: number;
    /** With the caller's own file names, as are the diagnostics read from it; CODAL's prebuilt
      * libraries keep the path they were built at. */
    stderr: string;
    /** Only the step whose output is the hex keeps it; null everywhere else. */
    stdout: Uint8Array | null;
    /** `stderr` read by the toolchain's `readDiagnostics`: joining every `text` gives it back. */
    diagnostics: (Diagnostic | OtherOutput)[];
    /** CODAL's own steps only: how many are done, and the file built, as
      * `codal-core/source/core/CodalFiber.cpp` or `libcodal-core.a`. */
    codal: { done: number; total: number; file: string } | null;
};

export type Result = {
    ok: boolean;
    /** Intel hex, or null if a step failed. */
    hex: string | null;
    map: string | null;
    /** Every step's stderr, in order. */
    output: string;
    /** Every step's errors, warnings and remarks, in order. */
    diagnostics: Diagnostic[];
    steps: Step[];
};

export type CompileOptions = {
    /** Called as each tool finishes. CODAL comes first, when this configuration needs it compiled,
      * and stops at its first failure; then every source, compiled even after one fails; then the
      * link and the hex, only when they all succeeded. */
    onStep?: (step: Step) => void;
    /** Aborting rejects with the signal's reason between steps; a tool already running finishes first. */
    signal?: AbortSignal;
};

/** Rejects with a `ConfigError`, compiling nothing, for a codal.json it cannot follow. */
export type Compile = (files: Files, options?: CompileOptions) => Promise<Result>;

/** Its message's first line says what is wrong and what to change; any further lines are detail. */
export class ConfigError extends Error {
    name: 'ConfigError';
}

export type Manifest = {
    schema: number;
    generated: string;
    digest: string;
    codal: {
        version: string;
        versionHash: string;
        samples: { url: string | null, commit: string | null };
        libraries: { name: string, url: string | null, commit: string | null }[];
        /** The one `target` a codal.json may name: the CODAL in this package. */
        target: { name: string, url: string, branch: string, type: string };
    };
    toolchain: {
        package: string;
        version: string;
        llvm: { version: string, repository: string, release: string, commit: string };
    };
    config: Record<string, string | number>;
    layout: { build: string, project: string };
};

export type Codal = {
    compile: Compile;
    manifest: () => Promise<Manifest>;
};

/** `loadAsset` is given a package-relative path, such as `codal/payload.tar`. */
export function createCodal(options: { loadAsset: AssetLoader }): Codal;

export function packTar(entries: Record<string, Uint8Array>): Uint8Array;
export function unpackTar(tar: Uint8Array): object;
export function flatten(tree: object, base?: string): Record<string, Uint8Array>;
