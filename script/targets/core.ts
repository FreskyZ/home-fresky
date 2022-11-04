
import * as fs from 'fs/promises';
import * as chalk from 'chalk';
import { logInfo, logCritical } from '../common';
import { admin } from '../tools/admin';
import { eslint } from '../tools/eslint';
import { Asset, upload } from '../tools/ssh';
import { TypeScriptOptions, typescript } from '../tools/typescript';
import { MyPackOptions, MyPackResult, mypack } from '../tools/mypack';

const getTypescriptOptions = (watch: boolean): TypeScriptOptions => ({
    base: 'normal',
    entry: 'src/core/index.ts',
    module: 'es',
    sourceMap: 'hide',
    watch,
});

const getMyPackOptions = (files: MyPackOptions['files']): MyPackOptions => ({
    type: 'app',
    files,
    entry: '/vbuild/core/index.js',
    sourceMap: true,
    output: 'index.js',
    printModules: true,
    minify: true,
});

const getUploadAssets = (packResult: MyPackResult): Asset[] => [
    { remote: 'index.js', data: packResult.resultJs },
    { remote: 'index.js.map', data: packResult.resultMap! },
];

export async function uploadConfig(): Promise<void> {
    await upload({ remote: 'config', data: await fs.readFile('src/shared/config.json') });
}

async function buildOnce(): Promise<void> {
    logInfo('akr', chalk`{cyan core}`);
    await eslint('core', 'node', ['src/shared/**/*.ts', 'src/core/**/*.ts']);
    // TODO make server file structure

    const checkResult = typescript(getTypescriptOptions(false)).check();
    if (!checkResult.success) {
        return logCritical('akr', chalk`{cyan core} failed at check`);
    }
    // const packResult = await mypack(getMyPackOptions(checkResult.files)).run();
    // if (!packResult.success) {
    //     return logCritical('akr', chalk`{cyan core} failed at pack`);
    // }
    // const uploadResult = await upload(getUploadAssets(packResult));
    // if (!uploadResult) {
    //     return logCritical('akr', chalk`{cyan core} failed at upload`);
    // }

    logInfo('akr', chalk`{cyan core} completed successfully`);
}

function buildWatch() {
    logInfo('akr', chalk`watch {cyan core}`);
    // mkdir(recursive)

    const packer = mypack(getMyPackOptions([]));
    typescript(getTypescriptOptions(true)).watch(async ({ files }) => {
        packer.options.files = files;
        const packResult = await packer.run();
        if (packResult.success && packResult.hasChange) {
            await upload(getUploadAssets(packResult));
            admin.selfhost('start'); // will be restart if started
        }
    });
    process.on('SIGINT', () => { admin.selfhost('stop').then(() => process.exit()); });
}

export function build(watch: boolean): void {
    (watch ? buildWatch : buildOnce)();
}
