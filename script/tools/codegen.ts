import * as fs from 'fs/promises';
import * as fsnp from 'fs';
import * as zlib from 'zlib';
import * as chalk from 'chalk';
import { toJson as parseXml } from 'xml2json';
import { config } from '../config';
import { logInfo, logError } from '../common';

type PathComponent = {
    type: 'normal',
    value: string,
} | {
    type: 'parameter',
    parameterName: string,
    parameterType: string,
};

interface APIDefinition {
    namespace: string,
    apiName: string,
    method: string,
    apiPath: PathComponent[],
    bodyType: string,
    bodyName: string,
    returnType: string,
}

interface APIDefinitionFile {
    version: string,
    definitions: APIDefinition[],
}

const definitionFile = 'src/api/api.xml';
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const myfetchMethods: { [method: string]: string } = { 'GET': 'get', 'POST': 'post', 'PUT': 'put', 'PATCH': 'patch', 'DELETE': 'del' }; // to lower and DELETE to del

const parameterTypes = ['id', 'number', 'string', 'boolean', 'date', 'time'];
const parameterTypeConfig: { [parameterType: string]: { pattern: string, validator: string, tsType: string } }= {
    'id': { pattern: '\\d+', validator: 'validateId', tsType: 'number' },
    'number': { pattern: '\\d+', validator: 'validateNumber', tsType: 'number' },
    'string': { pattern: '.+', validator: 'validateString', tsType: 'string' },
    'boolean': { pattern: '(true|false)', validator: 'validateBoolean', tsType: 'boolean' },
    'date': { pattern: '\\d{6}', validator: 'validateDate', tsType: 'Dayjs' },  // generated code format date at front end, validate and parse date at backend
    'time': { pattern: '\\d{12}', validator: 'validateTime', tsType: 'Dayjs' }, // generated code format time at front end, validate and parse time at backend
};

const HEADER =
'//-----------------------------------------------------------------------------------------------\n' +
'// This code was generated by a tool.\n' +
'// Changes to this file may cause incorrect behavior and will be lost if the code is regenerated.\n' +
'//-----------------------------------------------------------------------------------------------\n\n';
const snakeToCamel = (vs: string) => vs.split('_').map(v => v.charAt(0).toUpperCase() + v.substring(1)).join('');

// adk files used by app, see target/self.ts and build-script.md
const ADK: { [filename: string]: string } = Object.fromEntries(Object.entries(
// @ts-ignore use this is easier than use .d.ts
    compressedadkfiles
// I completely don't understand what typescript is saying:
// Argument of type '([filename, encoded]: [string, string]) => [string, string]' is not assignable to parameter of type '(value: [string, unknown], index: number, array: [string, unknown][]) => [string, string]'
// @ts-ignore
).map(([filename, encoded]) => [filename, zlib.brotliDecompressSync(Buffer.from(encoded, 'base64')).toString()]));

export async function deployADK(): Promise<void> {
    await fs.mkdir('src/adk', { recursive: true });
    await Promise.all(Object.keys(ADK).map(filename => fs.writeFile(`src/adk/${filename}`, ADK[filename])));
}

function parsePath(apiName: string, rawPath: string): PathComponent[] {
    const result: PathComponent[] = [];

    do {
        const match = /\{(?<parameterName>[\w_]+):(?<parameterType>\w+)\}/.exec(rawPath);
        if (!match) { break; }

        if (result.filter(r => r.type == 'parameter').length == 10) {
            // this is actually prevent infinite loop while developing
            throw new Error(`api ${apiName} too many parameters`);
        }

        const [parameterName, parameterType] = [match.groups!['parameterName'], match.groups!['parameterType']];
        if (!parameterTypes.includes(parameterType)) {
            throw new Error(`api ${apiName} parameter ${parameterName} invalid type ${parameterType}`);
        }

        if (match.index != 0) {
            result.push({ type: 'normal', value: rawPath.slice(0, match.index) });
        }
        result.push({ type: 'parameter', parameterName, parameterType });

        rawPath = rawPath.slice(match.index + parameterName.length + parameterType.length + 3); // because regex cannot match from index, so have to slice it
    } while (true);

    if (rawPath.length) {
        result.push({ type: 'normal', value: rawPath });
    }

    return result;
}

async function loadFile(): Promise<APIDefinitionFile> {
    const xml = await fs.readFile(definitionFile, 'utf-8');
    const { version, api } = parseXml(xml, { object: true })[`${config.appname}-api`] as { version: string, api: any[] };

    const definitions = api.map<APIDefinition>((d, index) => {
        const apiName = d['name'];
        if (!apiName) {
            throw new Error(`index ${index} api name is required`);
        }

        const method = d['method'];
        if (!methods.includes(method)) {
            throw new Error(`api ${apiName} invalid method`);
        }

        const rawPath = d['path'] as string;
        if (!rawPath) {
            throw new Error(`api ${apiName} path is required`);
        }
        if (!rawPath.startsWith('/')) {
            throw new Error(`api ${apiName} path should be absolute`);
        }
        const parsedPath = parsePath(apiName, rawPath);

        const [bodyType, bodyName] = [d['body-type'], d['body-name']];
        if (['POST', 'PUT', 'PATCH'].includes(method) && (!bodyType || !bodyName)) {
            throw new Error(`api ${apiName} body is required for ${method}`);
        }

        return {
            namespace: d['namespace'] || 'default',
            apiName: apiName,
            method: method,
            apiPath: parsedPath,
            bodyType: bodyType,
            bodyName: bodyName,
            returnType: d['return-type'] || 'void',
        };
    });

    return { version, definitions };
}

export interface CodeGenerationResult {
    success: boolean,
}

async function generateServerDefinition(additionalHeader?: string): Promise<CodeGenerationResult> {
    await fs.mkdir('src/api/server', { recursive: true });
    logInfo(`fcg${additionalHeader}`, chalk`generate {yellow api/server}`);

    let definitionFile: APIDefinitionFile;
    try {
        definitionFile = await loadFile();
    } catch (ex) {
        logError(`fcg${additionalHeader}`, ex.message);
        return { success: false };
    }
    const { version, definitions: allDefinitions } = definitionFile;

    // actually only the write file part can be parallel, but still ok for readability
    const tasks: Promise<void>[] = [];

    // [namespace].ts
    const namespaces = allDefinitions.map(d => d.namespace).filter((v, i, a) => a.indexOf(v) == i).map(n => [n, snakeToCamel(n)]);
    tasks.push(...namespaces.map(async ([namespace, namespaceintype]) => {
        const definitions = allDefinitions.filter(d => d.namespace == namespace);

        let b = HEADER;
        b += `import { FineError } from '../../adk/error';\n`;
        b += `import { ForwardContext, Context } from '../../adk/api-server';\n`;

        // because colon is only used for capture type, so validators can be prepared by this
        const validators: string[] = parameterTypes
            .filter(parameterType => definitions.some(d => d.apiPath.some(c => c.type == 'parameter' && c.parameterType == parameterType)))
            .map(parameterType => parameterTypeConfig[parameterType].validator)
            .concat(definitions.some(d => ['PUT', 'POST', 'PATCH'].includes(d.method)) ? ['validateBody'] : []);
        b += `import { ${validators.join(', ')} } from '../../adk/api-server';\n`;

        // typescript is now 4.7 but still cannot understand .filter(c => c.tag == 'sometag').map(c /* this is tagged */)
        const typesFromBody = definitions.filter(d => d.bodyType).map(d => d.bodyType);
        const typesFromReturn = definitions.filter(d => d.returnType != 'void').map(d => d.returnType.endsWith('[]') ? d.returnType.slice(0, -2) : d.returnType);
        const usedTypes = typesFromBody.concat(typesFromReturn)
            .filter((t, index, array) => array.indexOf(t) == index) // dedup
            .filter(t => !['number'].includes(t)); // not builtin types
        b += `import type { ${usedTypes.join(', ')} } from '../types';\n`;

        b += '\n'
        b += `export interface ${namespaceintype}Impl {\n`
        for (const { apiName, apiPath, bodyType, bodyName, returnType } of definitions) {
            b += `    ${apiName}: (ctx: Context`
            for (const { parameterName, parameterType } of apiPath.filter(c => c.type == 'parameter') as { parameterName: string, parameterType: string }[]) {
                b += `, ${parameterName}: ${parameterTypeConfig[parameterType].tsType}`;
            }
            if (bodyType) {
                b += `, ${bodyName}: ${bodyType}`;
            }
            b += `) => Promise<${returnType}>,\n`;
        }
        b += '}\n';

        b += '\n';
        b += `export async function dispatch(ctx: ForwardContext, impl: ${namespaceintype}Impl): Promise<void> {\n`;
        b += `    let match: RegExpExecArray;\n`;
        b += `    const methodPath = \`\${ctx.method} \${ctx.path.slice(${version.length + namespace.length + 3})}\`;\n`; // 4: /v{version}/{namespace}

        b += '\n';
        for (const { apiName, method, apiPath, bodyType, returnType } of definitions) {
            b += `    match = /^${method} `;
            for (const component of apiPath) {
                if (component.type == 'normal') {
                    b += component.value.replaceAll('/', '\\/');
                } else {
                    b += `(?<${component.parameterName}>${parameterTypeConfig[component.parameterType].pattern})`;
                }
            }
            b += `$/.exec(methodPath); if (match) {\n`;

            b += '        ';
            if (returnType != 'void') {
                b += `ctx.body = `;
            }
            b += `await impl.${apiName}(ctx.state`;
            for (const { parameterName, parameterType } of apiPath.filter(c => c.type == 'parameter') as { parameterName: string, parameterType: string }[]) { // tsc fails to infer the type
                b += `, ${parameterTypeConfig[parameterType].validator}('${parameterName}', match.groups['${parameterName}'])`;
            }
            if (bodyType) {
                b += `, validateBody(ctx.body)`;
            }
            b += ');\n';
            if (bodyType && returnType == 'void') {
                b += '        delete ctx.body;\n';
            }

            if (method == 'POST') {
                b += `        ctx.status = 201;\n`;
            } else if (method == 'DELETE') {
                b += `        ctx.status = 204;\n`;
            }

            b += `        return;\n`;
            b += `    }\n`;
        }

        b += `\n`;
        b += `    throw new FineError('not-found', 'invalid invocation');\n`;
        b += '}\n';
        await fs.writeFile(`src/api/server/${namespace}.ts`, b);
    }));

    // index.ts
    tasks.push((async () => {
        let b = HEADER;

        b += `import * as fs from 'fs';\n`;
        b += `import * as net from 'net';\n`;
        b += `import { FineError } from '../../adk/error';\n`;
        b += `import { ForwardContext, setupServer, shutdownServer } from '../../adk/api-server';\n`;
        for (const [namespace, namespaceintype] of namespaces) {
            b += `import { ${namespaceintype}Impl, dispatch as dispatch${namespaceintype} } from './${namespace}';\n`;
        }

        b += '\n';
        b += `export interface Impl {\n`;
        for (const [namespace, namespaceintype] of namespaces) {
            b += `    ${namespace}: ${namespaceintype}Impl,\n`;
        }
        b += '}\n';

        b += '\n'
        b += 'async function dispatch(ctx: ForwardContext, impl: Impl) {\n';
        b += `    if (!ctx.path.startsWith('/v${version}')) { throw new FineError('not-found', 'invalid invocation version'); }\n`;
        b += `    const path = ctx.path.substring(${version.length + 2});\n`; // 2: /v1
        for (const [namespace, namespaceintype] of namespaces) {
            b += `    if (path.startsWith('/${namespace}/')) { return await dispatch${namespaceintype}(ctx, impl.${namespace}); }\n`
        }
        b += `    throw new FineError('not-found', 'invalid invocation');\n`;
        b += `}\n`;

        b += '\n'
        b += 'let server: net.Server;\n';
        b += 'const connections: net.Socket[] = [];\n';
        b += 'export function setupWebInterface(socketpath: string, impl: Impl) {\n'
        b += '    server = net.createServer();\n';
        b += '    setupServer(server, connections, dispatch, impl);\n';
        b += `    if (fs.existsSync(socketpath)) {\n`;
        b += `        fs.unlinkSync(socketpath);\n`;
        b += '    }\n';
        b += `    server.listen(socketpath);\n`;
        b += '}\n';
        b += 'export function shutdownWebInterface(): Promise<void> {\n';
        b += '    return shutdownServer(server, connections);\n';
        b += '}\n';

        await fs.writeFile(`src/api/server/index.ts`, b);
    })());

    await Promise.all(tasks);

    logInfo(`fcg${additionalHeader}`, chalk`generate {yellow api/server} completed with ${tasks.length} files`);
    return { success: true };
}

async function generateClientDefinition(additionalHeader?: string): Promise<CodeGenerationResult> {
    await fs.mkdir('src/api', { recursive: true });
    logInfo(`fcg${additionalHeader}`, chalk`generate {yellow src/api/client}`);

    let definitionFile: APIDefinitionFile;
    try {
        definitionFile = await loadFile();
    } catch (ex) {
        logError(`fcg${additionalHeader}`, ex.message);
        return { success: false };
    }
    const { version, definitions } = definitionFile;

    let b = HEADER;
    if (definitions.some(d => d.apiPath.some(c => c.type == 'parameter' && ['date', 'time'].includes(c.parameterType)))) {
        b += `import type { Dayjs } from 'dayjs';\n`;
    }

    const usedMethods = methods.filter(m => definitions.some(d => d.method == m)).map(m => myfetchMethods[m]); // use all methods.filter to keep them in order
    b += `import { ${usedMethods.join(', ')} } from '../adk/api-client';\n`;

    const bodyTypes = definitions.filter(d => d.bodyType).map(d => d.bodyType);
    const returnTypes = definitions.filter(d => d.returnType != 'void').map(d => d.returnType.endsWith('[]') ? d.returnType.slice(0, -2) : d.returnType);
    const usedTypes = bodyTypes.concat(returnTypes)
        .filter((t, index, array) => array.indexOf(t) == index) // dedup
        .filter(t => !['number'].includes(t)); // not builtin types
    b += `import type { ${usedTypes.join(', ')} } from './types';\n`;

    b += '\n';
    for (const namespace of definitions.map(d => d.namespace).filter((v, i, a) => a.indexOf(v) == i)) {
        b += `export const ${namespace == 'default' ? '$default' : namespace} = {\n`;
        for (const { apiName, method, apiPath, bodyType, bodyName, returnType } of definitions.filter(d => d.namespace == namespace)) {
            b += `    ${apiName}: (`;
    
            for (const { parameterName, parameterType } of apiPath.filter(c => c.type == 'parameter') as { parameterName: string, parameterType: string }[]) { // tsc fails to infer the type
                if (!b.endsWith('(')) {
                    b += ', '; // do not add comma for first parameter
                }
                b += `${parameterName}: ${parameterTypeConfig[parameterType].tsType}`;
            }
            if (bodyType) {
                if (!b.endsWith('(')) {
                    b += ', '; // do not add comma for first parameter
                }
                b += `${bodyName}: ${bodyType}`;
            }
    
            b += `): Promise<${returnType}> => ${myfetchMethods[method]}(\`/${config.appname}/v${version}/${namespace}`;
    
            for (const component of apiPath) {
                if (component.type == 'normal') {
                    b += component.value;
                } else {
                    if (component.parameterType == 'date') {
                        b += `\${${component.parameterName}.format('YYYYMMDD')}`;
                    } else if (component.parameterType == 'time') {
                        b += `\${${component.parameterName}.format('YYYYMMDDHHmmdd')}`;
                    } else {
                        b += `\${${component.parameterName}}`;
                    }
                }
            }
            b += '`';
    
            if (bodyType) {
                b += `, ${bodyName}`;
            }
            b += `),\n`;
        }
        b += '};\n';
    }

    await fs.writeFile('src/api/client.ts', b);
    logInfo(`fcg${additionalHeader}`, chalk`generate {yellow api/client} completed`);
    return { success: true };
}

class CodeGenerator {
    public constructor(
        private readonly target: 'server' | 'client',
        private readonly additionalHeader?: string) {
        this.additionalHeader = this.additionalHeader ?? '';
    }

    public generate(): Promise<CodeGenerationResult> {
        if (this.target == 'server') {
            return generateServerDefinition(this.additionalHeader);
        } else {
            return generateClientDefinition(this.additionalHeader);
        }
    }

    public watch() {
        logInfo(`fcg${this.additionalHeader}`, chalk`watch {yellow ${definitionFile}}`);

        // prevent reentry like web-page html
        let regenerateRequested = true; // init to true for initial codegen
        fsnp.watch(definitionFile, { persistent: false }, () => {
            regenerateRequested = true;
        });

        setInterval(() => {
            if (regenerateRequested) {
                regenerateRequested = false;
                this.generate();
            }
        }, 3007);
    }
}

export function codegen(target: 'server' | 'client', additionalHeader?: string): CodeGenerator { return new CodeGenerator(target, additionalHeader); }
