import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as chalk from 'chalk';
import { logInfo, logCritical } from '../common';
import { eslint } from '../tools/eslint';
import { TypeScriptOptions, typescript } from '../tools/typescript';
import { MyPackOptions, mypack } from '../tools/mypack';

const typescriptOptions: TypeScriptOptions = {
    base: 'normal',
    entry: `script/index.ts`,
    sourceMap: 'no',
    watch: false,
    configSubstitution: false,
};
const getMyPackOptions = (files: MyPackOptions['files']): MyPackOptions => ({
    type: 'app',
    entry: `/vbuild/index.js`,
    files,
    minify: true,
    shebang: true,
    cleanupFiles: false,
});

async function readdirRecursively(files: string[], directory: string) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const entrypath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await readdirRecursively(files, entrypath);
        } else if (entry.isFile()) {
            files.push(entrypath);
        } else if (entry.isSymbolicLink()) {
            const link = await fs.promises.readlink(entrypath);
            const stat = await fs.promises.lstat(link);
            if (stat.isDirectory()) {
                await readdirRecursively(files, link);
            } else if (stat.isFile()) {
                files.push(link);
            }
        } // else ignore
    }
}
export async function hashself(): Promise<string> {

    const files: string[] = [];
    await readdirRecursively(files, "script");
    files.sort();

    // use md5 because no security requirements
    const allhasher = crypto.createHash('md5');
    // no promise.all because hash is not io bound
    for (const file of files) {
        // it is actually required to for-await, to guarantee order
        await new Promise<void>(resolve => {
            const hasher = crypto.createHash('md5');
            const stream = fs.createReadStream(file);
            stream.on('data', data => hasher.update(data));
            stream.on('end', () => { allhasher.update(hasher.digest()); resolve(); });
        });
    }
    return allhasher.digest('hex');
}

export async function build(): Promise<void> {
    logInfo('akr', chalk`{cyan self}`);
    await eslint('self', 'node', 'script/**/*.ts');

    const checkResult = typescript(typescriptOptions).check();
    if (!checkResult.success) {
        return logCritical('akr', chalk`{cyan self} failed at transpile`);
    }

    const packResult = await mypack(getMyPackOptions(checkResult.files)).run();
    if (!packResult.success) {
        return logCritical('akr', chalk`{cyan self} failed at pack`);
    }

    // ATTENTION this replace only replace first and that is expected to be the one in index.ts (which is true for current mypack implementation)
    // curently terser very cleverly evaluates things like 'self' + 'hash' to selfhash which makes replaceAll does not work correctly
    const resultjs = packResult.resultJs.toString('utf-8').replace('selfhash', await hashself());
    await fs.promises.writeFile('akari', resultjs);

    logInfo('akr', chalk`{cyan self} completed successfully`);
}
