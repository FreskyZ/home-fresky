import * as fs from 'fs';
import * as chalk from 'chalk';
import * as dayjs from 'dayjs';

export const projectDirectory = '<PROJECTDIR>';
export const nodePackage = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

// this config is read runtime and replace for build normal things
// so build script itself directly use this instead of replace it while building self
export const compileTimeConfig = JSON.parse(fs.readFileSync('maka.config', 'utf-8'));

export function logInfo(header: string, message: string) {
    console.log(chalk`[{blueBright ${dayjs().format('HH:mm:ss.SSS')}} ${header}] ${message}`);
}
export function logError(header: string, message: string) {
    console.log(chalk`[{blueBright ${dayjs().format('HH:mm:ss.SSS')}} {red ${header}}] ${message}`);
}
export function logCritical(header: string, message: string) {
    console.log(chalk`[{blueBright ${dayjs().format('HH:mm:ss.SSS')}} {red ${header}}] ${message}`);
    return process.exit(1);
}

process.on('unhandledRejection', error => { 
    console.log('unhandled reject: ', error);
    process.exit(0);
});
