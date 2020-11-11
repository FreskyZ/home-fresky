// 1. useful stat.toJson result type is not included in webpack 5 type definitions

interface ChunkGroup {
    assets: string[];
    chunks: Array<number | string>;
    children: Record<string, {
        assets: string[];
        chunks: Array<number | string>;
        name: string;
    }>;
    childAssets: Record<string, string[]>;
    isOverSizeLimit?: boolean;
}

type ReasonType
    = 'amd define'
    | 'amd require array'
    | 'amd require context'
    | 'amd require'
    | 'cjs require context'
    | 'cjs require'
    | 'context element'
    | 'delegated exports'
    | 'delegated source'
    | 'dll entry'
    | 'accepted harmony modules'
    | 'harmony accept'
    | 'harmony export expression'
    | 'harmony export header'
    | 'harmony export imported specifier'
    | 'harmony export specifier'
    | 'harmony import specifier'
    | 'harmony side effect evaluation'
    | 'harmony init'
    | 'import() context development'
    | 'import() context production'
    | 'import() eager'
    | 'import() weak'
    | 'import()'
    | 'json exports'
    | 'loader'
    | 'module.hot.accept'
    | 'module.hot.decline'
    | 'multi entry'
    | 'null'
    | 'prefetch'
    | 'require.context'
    | 'require.ensure'
    | 'require.ensure item'
    | 'require.include'
    | 'require.resolve'
    | 'single entry'
    | 'wasm export import'
    | 'wasm import';

interface Reason {
    moduleId: number | string | null;
    moduleIdentifier: string | null;
    module: string | null;
    moduleName: string | null;
    type: ReasonType;
    explanation?: string;
    userRequest: string;
    loc: string;
}

export interface WebpackStatModule {
    assets?: string[];
    built: boolean;
    cacheable: boolean;
    chunks: Array<number | string>;
    depth?: number;
    errors: number;
    failed: boolean;
    filteredModules?: boolean;
    id: number | string;
    identifier: string;
    index: number;
    index2: number;
    issuer: string | undefined;
    issuerId: number | string | undefined;
    issuerName: string | undefined;
    issuerPath: Array<{
        id: number | string;
        identifier: string;
        name: string;
        profile: any; // TODO
    }>;
    modules: WebpackStatModule[];
    name: string;
    optimizationBailout?: string;
    optional: boolean;
    prefetched: boolean;
    profile: any; // TODO
    providedExports?: any; // TODO
    reasons: Reason[];
    size: number;
    source?: string;
    usedExports?: boolean;
    warnings: number;
}

export interface WebpackStat {
    _showErrors: boolean;
    _showWarnings: boolean;
    assets: Array<{
        chunks: Array<number | string>;
        chunkNames: string[];
        emitted: boolean;
        isOverSizeLimit?: boolean;
        name: string;
        size: number;
    }>;
    assetsByChunkName?: Record<string, string | string[]>;
    builtAt?: number;
    children?: Array<WebpackStat & { name?: string }>;
    chunks: Array<{
        children: number[];
        childrenByOrder: Record<string, number[]>;
        entry: boolean;
        files: string[];
        filteredModules?: number;
        hash?: string;
        id: number | string;
        initial: boolean;
        modules: WebpackStatModule[];
        names: string[];
        origins?: Array<{
            moduleId?: string | number;
            module: string;
            moduleIdentifier: string;
            moduleName: string;
            loc: string;
            request: string;
            reasons: string[];
        }>;
        parents: number[];
        reason?: string;
        recorded?: boolean;
        rendered: boolean;
        size: number;
        siblings: number[];
    }>;
    entrypoints?: Record<string, ChunkGroup>;
    errors: Error[];
    env?: Record<string, any>;
    filteredAssets?: number;
    filteredModules?: boolean;
    hash?: string;
    modules?: WebpackStatModule[];
    namedChunkGroups?: Record<string, ChunkGroup>;
    needAdditionalPass?: boolean;
    outputPath?: string;
    publicPath?: string;
    time?: number;
    version?: string;
    warnings: string[];
}

// https://github.com/sass/node-sass#usage
interface SassError {
    message: string,
    line: number,
    column: number,
    status: number,
    file: string,
}

interface SassStats {
    entry: string,
    start: number,
    end: number,
    duration: number,
    includedFiles: number,
}

interface SassResult {
    css: Buffer,
    map: Buffer,
    stats: SassStats,
}

interface SassImporterFunction {
    (url: string, prev: string, done: (file: string, contents: string) => void): void,
}

export interface SassOptions {
    file?: string,
    data?: string,
    importer?: SassImporterFunction | SassImporterFunction[],
    functions?: any,
    includePaths?: string[],
    indentedSyntax?: boolean,
    indentType?: 'space' | 'tab',
    indentWidth?: number,
    linefeed?: 'lf' | 'cr' | 'crlf' | 'lfcr',
    omitSourceMapUrl?: boolean,
    outFile?: string,
    outputStyle?: 'nested' | 'expanded' | 'compact' | 'compressed',
    precision?: number,
    sourceComments?: boolean,
    sourceMap?: boolean | string,
    sourceMapContents?: boolean,
    sourceMapEmbed?: boolean,
    sourceMapRoot?: string,
}

export interface SassRenderFunction {
    (opts: SassOptions, callback: (error: SassError, result: SassResult) => void): void,
}
