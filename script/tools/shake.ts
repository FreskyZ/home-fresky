
import * as ts from 'typescript';

// tree shaking: 
// - rewrite namespaced import, `import * as x from 'x'; use(x.a, x.b, x.c)` to `import { a, b, c } from 'x'; use(x$a, x$b, x$c)`
// - rewrite reexport, `import { y } from 'x'; export * as y from 'y';` to `import { a, b, c } from 'y'`
// - remove unused import,
// - remove unused export,
// - remove unused declarations,
// - *recursively*, (with recursion limit)
// based on typescript custom transform mechanism, to prevent duplicate parse of text
//
// not include 3rd party library in node_modules, 
// like the `import * as ts from 'typescript'` in this file, because they are really complex,
// and currently akari targets generally assumes use npm package on native targets and use cdn on browser targets
//
// this supersedess original mypack

// // all syntax for import and export declaration from MDN
// // put them into typescript AST viewer to see ast details
// import defaultExport from "module-name";
// import * as name from "module-name";
// import { export1 } from "module-name";
// import { export1 as alias1 } from "module-name";
// import { default as alias } from "module-name";
// import { export1, export2 } from "module-name";
// import { export1, export2 as alias2, /* … */ } from "module-name";
// import { "string name" as alias } from "module-name";
// import defaultExport, { export1, /* … */ } from "module-name";
// import defaultExport, * as name from "module-name";
// import "module-name";
//
// // Exporting declarations
// export let name1, name2/*, … */; // also var
// export const name1 = 1, name2 = 2/*, … */; // also var, let
// export function functionName() { /* … */ }
// export class ClassName { /* … */ }
// export function* generatorFunctionName() { /* … */ }
// export const { name1, name2: bar } = o;
// export const [ name1, name2 ] = array;
//
// // Export list
// export { name1, /* …, */ nameN };
// export { variable1 as name1, variable2 as name2, /* …, */ nameN };
// export { variable1 as "string name" };
// export { name1 as default /*, … */ };
//
// // Default exports
// export default expression;
// export default function functionName() { /* … */ }
// export default class ClassName { /* … */ }
// export default function* generatorFunctionName() { /* … */ }
// export default function () { /* … */ }
// export default class { /* … */ }
// export default function* () { /* … */ }
//
// // Aggregating modules
// export * from "module-name";
// export * as name1 from "module-name";
// export { name1, /* …, */ nameN } from "module-name";
// export { import1 as name1, import2 as name2, /* …, */ nameN } from "module-name";
// export { default, /* …, */ } from "module-name";

// ts.SyntaxKind is using marker members, e.g.
// enum SyntaxKind { ..., StatementKind1...StatementKindN, ..., FirstStatement = StatementKind1, LastStatement = StatementKindN }
// so FirstStatment value duplicates with StatementKind1, LastStatement value duplicates with StatementKindN
// and typescript enum runtime map overwrites if duplicate,
// which makes ts.SyntaxKind[node.kind] result very confusing, so build another map which ignores duplicates to solve this issue

function makeEnumMap<T extends number>(original: any): (value: T) => string {
    const map = new Map<number, string>();
    for (const name /* yes, in */ in original) {
        const value = original[name];
        if (typeof value == 'number' && !map.has(value)) {
            map.set(value, name);
        }
    }
    return value => map.get(value as number);
}
// typescript enum runtime map does not handle bitflags, this also handles duplicate
function makeBitFlagMap<T extends number>(original: any): (value: T) => string[] {
    const map = new Map<number, string>();
    for (const name in original) {
        const value = original[name];
        // only accept popcount=1 values
        // // this popcount implementation is really not considered in native
        // // languages like c++ but is really acceptable and easy to understand in javascript
        if (typeof value == 'number' && !map.has(value) && value.toString(2).split('1').length == 1) {
            map.set(value, name);
        }
    }
    
    return enumValue => {
        const results: string[] = [];
        let bit = 1;
        let value = enumValue as number;
        while (value) {
            if (value & bit) {
                results.push(map.get(bit));
            }
            value &= ~bit;
            bit <<= 1;
        }
        return results;
    };
}

const mapSyntaxKind = makeEnumMap<ts.SyntaxKind>(ts.SyntaxKind);
const mapNodeFlags = makeBitFlagMap<ts.NodeFlags>(ts.NodeFlags);

export function shake(_context: ts.TransformationContext, sources: ts.SourceFile[]) {

    for (const source of sources) {
        console.log(source.fileName);
        ts.forEachChild(source, node => {
            const start = node.pos <= 0 ? { line: 0, character: 0 } : source.getLineAndCharacterOfPosition(node.pos);
            const end = node.end <= 0 ? { line: 0, character: 0 } : source.getLineAndCharacterOfPosition(node.end);
            const commoninfo = `${start.line + 1}:${start.character}-${end.line + 1}:${end.character} ${mapSyntaxKind(node.kind)} ${mapNodeFlags(node.flags)}`;

            if (ts.isFunctionDeclaration(node)) {
                const isexport = node.modifiers && node.modifiers.some(m => m.kind == ts.SyntaxKind.ExportKeyword);
                console.log(`${commoninfo} ${isexport ? 'export ' : ''} ${node.name.text}`);
            } else if (ts.isVariableStatement(node)) {
                const isexport = node.modifiers && node.modifiers.some(m => m.kind == ts.SyntaxKind.ExportKeyword);
                const declarations = node.declarationList.declarations.map(d => 
                    d.name.kind == ts.SyntaxKind.Identifier ? d.name.text : '[binding]');
                console.log(`${commoninfo} ${isexport ? 'export ' : ''}${declarations}`);
            } else if (ts.isImportDeclaration(node)) {
                const from = (node.moduleSpecifier as ts.StringLiteral).text;
                if (!node.importClause) {
                    console.log(`${commoninfo} importclause is empty`);
                } else {
                    const names: { name: string, alias?: string }[] = [];
                    if (node.importClause.name) {
                        names.push({ name: 'default', alias: node.importClause.name.text });
                    }
                    if (node.importClause.namedBindings.kind == ts.SyntaxKind.NamespaceImport) {
                        names.push({ name: '<namespace>', alias: node.importClause.namedBindings.name.text });
                    } else /* named imports */ {
                        for (const element of node.importClause.namedBindings.elements) {
                            names.push({
                                alias: element.name.text,
                                name: element.propertyName ? element.propertyName.text : element.name.text,
                            });
                        }
                    }
                    console.log(`${commoninfo} from ${from} import ${names.map(n => `${n.name} as ${n.alias}`).join(',')}`);
                }
            } else {
                console.log(commoninfo);
            }
        });
    };
}
