export type Files = Record<string, string | Uint8Array>;

export type AssetLoader = (name: string) => Promise<Uint8Array> | Uint8Array;

export type Step = {
    tool: string;
    args: string[];
    exitCode: number;
    stderr: string;
    /** Only the step whose output is the hex keeps it; null everywhere else. */
    stdout: Uint8Array | null;
};

export type Result = {
    ok: boolean;
    /** Intel hex, or null if a step failed. */
    hex: string | null;
    map: string | null;
    /** Every step's stderr, in order. */
    output: string;
    steps: Step[];
};

export type Compile =
    (files: Files, options?: { log?: (message: string) => void }) => Promise<Result>;

export type Manifest = {
    schema: number;
    generated: string;
    digest: string;
    codal: {
        version: string;
        versionHash: string;
        samples: { url: string | null, commit: string | null };
        libraries: { name: string, url: string | null, commit: string | null }[];
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
