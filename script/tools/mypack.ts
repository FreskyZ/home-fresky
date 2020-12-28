import * as fs from 'fs';
import * as path from 'path';
import * as chalk from 'chalk';
import { SHA256 as sha256 } from 'crypto-js';
import * as filesize from 'filesize';
import { SourceMapGenerator, SourceMapConsumer } from 'source-map';
import { minify } from 'terser';
import { logInfo, logError } from '../common';

// my bundler, input list of name/content of js file/source map
// output minified js and source map

// // you will be amazing how these options are added from the very first version of mypack
export interface MyPackOptions {
    type: 'lib' | 'app',       // lib will reexport entry
    entry: string,             // entry name should be in file list
    files: { name: string, content: string }[],
    sourceMap?: boolean,       // default to false
    output: string,            // source map file is output + '.map'
    printModules?: boolean,    // default to false
    minify?: boolean,          // default to false
    shebang?: boolean,         // default to false
    cleanupFiles?: boolean,    // see tools/typescript:TypeScriptChecker::watch, default to true, should be false for multi entry targets like self
}

export type MyPackResult = {
    success: boolean,
    hasChange?: boolean, // this hash = last hash
}

interface Source { 
    filename: string, 
    jsContent: string,
    mapContent: string, // can be missing even if source map is on
}

interface ModuleRequest {
    index: number, // index in source content
    raw: string,   // require parameterr value
    resolvedFileName: string,
    resolvedModuleName: string,
}
interface Module {
    name: string,  // module name is relative path to entry, omit .js and index
    source: Source,
    requests: ModuleRequest[],
    content: string, // content after updating require to myrequire
    hash: string,    // hash of previous content
}

interface EmitHost {
    sb: string, // string builder
    generator: SourceMapGenerator,
    lineOffset: number, // offset from generated line to original line, because column will not be change in this packing process
}

class MyPacker {

    private lastHash: string = null;
    private lastModules: Module[] = null;

    public constructor(public readonly options: MyPackOptions) {
    }

    private sources: Source[];
    private getSources() {
        this.sources = this.options.files.filter(f => f.name.endsWith('.js')).map(({ name, content }) => ({
            filename: name,
            jsContent: content,
            mapContent: this.options.files.find(f => f.name == name + '.map')?.content,
        }));
    }

    private processModule(source: Source): Module {
        let moduleName = path.relative(path.dirname(this.options.entry), source.filename);
        if (moduleName.endsWith('.js')) { moduleName = moduleName.slice(0, -3); }
        if (moduleName.endsWith('index')) { moduleName = moduleName.slice(0, -5); }
        if (moduleName.length == 0) { moduleName = '.'; } // entry index.js will be empty string after previous operations
    
        // find all usage of 'require(".', which resolves to my code
        const requests: ModuleRequest[] = [];
        const pattern = /require\("(?<request>\.[\.\w\-\/]*)"\);/g; // rest part length 12
        do {
            const match = pattern.exec(source.jsContent);
            if (!match) { break; }

            const raw = match.groups['request'];
            const fullRequest = path.resolve(path.dirname(source.filename), raw);
            const requiredFileName = 
                this.sources.some(s => s.filename == fullRequest) ? fullRequest
                : this.sources.some(s => s.filename == fullRequest + '.js') ? fullRequest + '.js'
                : this.sources.some(s => s.filename == fullRequest + '/index.js') ? fullRequest + '/index.js' 
                : null;
            if (!requiredFileName) {
                logError('mpk', `${source.filename}: invalid module name ${raw} at ${match.index}`);
                return null;
            }

            // similar to previous moduleName
            let requiredModuleName = path.relative(path.dirname(this.options.entry), requiredFileName);
            requiredModuleName = requiredModuleName.slice(0, -3); // required module name is name in sources list, so it must end with .js
            if (requiredModuleName.endsWith('index')) { requiredModuleName = requiredModuleName.slice(0, -5); }
            if (requiredModuleName.length == 0) { requiredModuleName = '.'; } // entry

            requests.push({ index: match.index, raw, resolvedFileName: requiredFileName, resolvedModuleName: requiredModuleName });
        } while (true);

        let previousEndIndex = 0; // previous request end index in source content
        let moduleContent = '';
        for (const { index, raw, resolvedModuleName } of requests) {
            moduleContent += source.jsContent.slice(previousEndIndex, index);
            moduleContent += `myimport("${resolvedModuleName}");`;
            previousEndIndex = index + raw.length + 12;
        }
        moduleContent += source.jsContent.slice(previousEndIndex); // also correct for no request

        return { name: moduleName, source, requests, content: moduleContent, hash: sha256(moduleContent).toString() };
    }

    // return true for has circular reference and should abort
    private checkCircularReference(modules: Module[]): boolean {
        // this is actually similar to runtime initialize process

        const loadings: Module[] = [];
        function load($module: Module) {
            loadings.push($module);
            for (const request of $module.requests) {
                const requestedModule = modules.find(m => m.name == request.resolvedModuleName);
                if (loadings.some(o => o.name == requestedModule.name)) { // this also checks self references, but how and why will anyone write self reference?
                    throw new Error('circular reference');
                }
                load(requestedModule);
            }
            loadings.pop();
        }

        try {
            load(modules[0]); // modules[0] is entry
            return false;
        } catch (ex) {
            if (ex.message == 'circular reference') {
                logInfo('mpk', 'circular reference');
                return true;
            }
            throw ex;
        }
    }

    private emitRuntimePrefix(host: EmitHost, entryModuleName: string) {
        if (this.options.shebang) {
            host.sb += '#!/usr/bin/env node\n';
            host.lineOffset += 1;
        }

        host.sb += this.options.type == 'app'
            ? `((modules) => { const mycache = {};\n`
                + `(function myrequire(modulename) { if (!(modulename in mycache)) { mycache[modulename] = {}; modules[modulename](mycache[modulename], myrequire); } return mycache[modulename]; })('${entryModuleName}'); })({\n`
            : `module.exports = ((modules) => { const mycache = {};\n`
                + `return (function myrequire(modulename) { if (!(modulename in mycache)) { mycache[modulename] = {}; modules[modulename](mycache[modulename], myrequire); } return mycache[modulename]; })('${entryModuleName}'); })({\n`
        host.lineOffset += 2;
    }
    private async emitModule(host: EmitHost, $module: Module) {
        host.sb += `'${$module.name}': (exports, myimport) => {\n${$module.content}}, `;
        host.lineOffset += 1;

        if (host.generator) {
            let firstMappingLine: number = null; // first mapping line is 3/4 (diff by whether have export) which maps to packed js line `lineMovement + 1`
            const consumer = await new SourceMapConsumer(JSON.parse($module.source.mapContent));
            consumer.eachMapping(mapping => {
                if (firstMappingLine === null) {
                    firstMappingLine = mapping.generatedLine;
                }

                host.generator.addMapping({ 
                    source: path.resolve(mapping.source), 
                    original: { line: mapping.originalLine, column: mapping.originalColumn },
                    generated: { line: mapping.generatedLine - firstMappingLine + host.lineOffset + 1, column: mapping.generatedColumn },
                });
            });
            host.lineOffset += $module.content.split('\n').length - 1;
        }
    }
    private emitRuntimePostfix(host: EmitHost) {
        // although this is small, but this is for do not add any sb+= in main function
        host.sb += '})\n';
    }
    
    private cleanupMemoryFile(modules: Module[], files: MyPackOptions['files']) {
        const unusedFiles = files.filter(f => !modules.some(m => m.source.filename == f.name) && !modules.some(m => m.source.filename + '.map' == f.name));
        for (const unusedFile of unusedFiles) {
            files.splice(files.indexOf(unusedFile), 1);
            if (!unusedFile.name.endsWith('.map')) {
                console.log(chalk`   {gray - ${unusedFile.name}}`);
            }
        }
    }

    private printResult(assetSize: number, modules: Module[]) {
        logInfo('mpk', chalk`completed with {yellow 1} asset {yellow ${filesize(assetSize)}}`);
        if (this.options.printModules) {
            if (this.lastModules) {
                for (const addedModule of modules.filter(n => !this.lastModules.some(p => p.source.filename == n.source.filename))) {
                    console.log(chalk`  {gray +} ${addedModule.name} ({gray ${addedModule.source.filename}}) ${filesize(addedModule.content.length)}`);
                }
                for (const [updatedModule] of modules
                    .map(n => [n, this.lastModules.find(p => p.source.filename == n.source.filename)])
                    .filter(([currentModule, previousModule]) => previousModule && currentModule.hash != previousModule.hash)) {
                    console.log(chalk`  {gray *} ${updatedModule.name} ({gray ${updatedModule.source.filename}}) ${filesize(updatedModule.content.length)}`);
                }
                for (const removedModule of this.lastModules.filter(p => !modules.some(n => n.source.filename == p.source.filename))) {
                    console.log(chalk`  {gray - removed} ${removedModule.name} ({gray ${removedModule.source.filename}})`);
                }
            } else {
                for (const { name, source, content } of modules) {
                    console.log(chalk`   {gray +} ${name} ({gray ${source.filename}}) ${filesize(content.length)}`);
                }
            }
        }
    }

    public async run(): Promise<MyPackResult> {
        const entry = this.options.entry; // entry file name
        logInfo('mpk', this.lastHash ? 'repack' : chalk`pack {yellow ${entry.startsWith('/vbuild/') ? entry.slice(8) : entry}}`);

        this.getSources();
        if (!this.sources.some(s => s.filename == entry)) {
            logError('mpk', 'invalid entry');
            return { success: false };
        }

        // bfs require
        const modules: Module[] = [];
        const requiredFileNames: string[] = [entry]; // items already checked in this.sources
        for (let moduleIndex = 0; moduleIndex < requiredFileNames.length; ++moduleIndex) {
            const $module = this.processModule(this.sources.find(s => s.filename == requiredFileNames[moduleIndex]));
            if (!$module) { return { success: false }; }
            requiredFileNames.push(...$module.requests.map(r => r.resolvedFileName).filter(f => !requiredFileNames.includes(f)));
            modules.push($module);
        }

        if (this.checkCircularReference(modules)) {
            return { success: false };
        }

        const emitHost: EmitHost = { sb: '', lineOffset: 0, generator: !this.options.sourceMap ? null : new SourceMapGenerator({ file: this.options.output }) }
        this.emitRuntimePrefix(emitHost, modules[0].name);
        for (const $module of modules) {
            await this.emitModule(emitHost, $module);
        }
        this.emitRuntimePostfix(emitHost);

        let resultJs = emitHost.sb;
        let resultMap = emitHost.generator?.toString();
        if (this.options.minify) {
            const minifyResult = await minify(resultJs, { 
                sourceMap: !this.options.sourceMap ? false: { 
                    content: resultMap,
                    filename: this.options.output,     // this is new SourceMapGenerator({ file }), which I do not use
                    url: this.options.output + '.map', // this is generated //#sourceMapURL, which I do not use
                },
                format: {
                    max_line_len: 'MAKA_SELF_MULTILINE' in process.env ? 120 : undefined,
                }
            });
            resultJs = minifyResult.code;
            resultMap = typeof minifyResult.map == 'object' ? JSON.stringify(minifyResult.map) : minifyResult.map; // type says result.map is string|RawSourceMap, so stringify it if is object
        }

        const hash = sha256(resultJs).toString();
        const hasChange = hash != this.lastHash;
        this.lastHash = hash;

        if (!hasChange) {
            logInfo('mpk', chalk`completed with {blue no change}`);
        } else {
            this.printResult(resultJs.length, modules);
        }
        
        if (!('cleanupFiles' in this.options) || this.options.cleanupFiles) {
            this.cleanupMemoryFile(modules, this.options.files);
        }

        // remove content to reduce memory usage
        for (const $module of modules) {
            $module.content = null;
            $module.source.jsContent = null;
            $module.source.mapContent = null;
        }
        this.lastModules = modules;

        await fs.promises.writeFile(this.options.output, resultJs);
        if (this.options.sourceMap) {
            await fs.promises.writeFile(this.options.output + '.map', resultMap);
        }

        return { success: true, hasChange };
    }
}

export function mypack(options: MyPackOptions) { return new MyPacker(options); }

// TODO: check removed file actually removed
// TODO: check circular reference checker
// TODO: check source map mapped correctly
