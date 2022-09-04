/// <reference path="../shared/types/config.d.ts" />
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as dayjs from 'dayjs';
import * as koa from 'koa';
import type { DefaultState, DefaultContext } from 'koa';
import type { AdminServerCoreContentCommand } from '../shared/types/admin';
import { MyError } from '../shared/error';
import { logInfo } from './logger';

// see server-routing.md
// handle all kinds of file requests, include html/js/css/image and not interesting files like robots.txt, sitemap.xml, etc.
//
// public files does not cache in server memory and use simple weak cache key
// app client files are cached in server memory and browser cache key is strong
// for content list, because html file contains exactly js/css file list, regex it to get current file list when reloading requested
// for e-tag source,
//   - hash digest file may be slow for large file
//   - file stat is a file operation and may be slow
//   - so use timestamp of server init or admin script invocation time
// for content cache, they are not loaded when server init, but is loaded when reload requested
//   at first they both don't load file content,
//   but reload request change to always load file content because it need to compare old and new content to determine whether update cache key,
//     to make scenarios like "mycode.js updated while vendor.js not updated" fast
//   server init keeps not load file content to help keep server init performance

// if enabled by environment variable, return dummy value for required domains
export async function handleCertificate(ctx: koa.Context, next: koa.Next): Promise<any> {
    if (!('FINE_CERTIFICATE' in process.env)) {
        return await next();
    }

    if (ctx.path == '/') {
        ctx.status = 200;
    } else {
        ctx.body = fs.readFileSync(path.join('public', ctx.path));
        ctx.status = 200;
    }
}

// if source map is enabled, if source map name related js file exists, will try to find the source map file and compress and return
// auto close source map after 2 hours in case akari (server) does not close it
let AllowSourceMap = false;
let DisableSourceMapTimer: NodeJS.Timeout;

// NOTE:
// - only match href/src starts with "absolute" path, which means from same origin
// - no need to bother spacing or quote marks because these lines will and should be generated by build script
// - if file not exist, return empty; if empty (file not exist or no regex match), the app is not enabled (GET /app/ => 307 to /www/)
// ATTENTION:
// script files are not expected to be nested, so '/' is not matched in the '+' part // this feature is used by dev mode dev script
const htmlStyleRegex = /<link rel="stylesheet" type="text\/css" href="\/(?<filename>[\w\-.]+)">/g;
const htmlScriptRegex = /<script type="text\/javascript" src="\/(?<filename>[\w\-.]+)"><\/script>/g;
function getAppFiles(app: string): string[] {
    const htmlfile = `${app}/index.html`;
    if (!fs.existsSync(htmlfile)) { return []; }

    const filenames: string[] = [];
    const html = fs.readFileSync(htmlfile, 'utf-8');

    do {
        const match = htmlStyleRegex.exec(html);
        if (match) { filenames.push(match.groups!['filename']); } else { break; }
    } while (true);
    do {
        const match = htmlScriptRegex.exec(html);
        if (match) { filenames.push(match.groups!['filename']); } else { break; }
    } while (true);

    return filenames;
}

// Attention: this array is only used for initialize, not used after reload
type KnownFile = Readonly<{ virtual: string, real: string, reloadKey: string | false }>;
const knownFiles: ReadonlyArray<KnownFile> = (() => {
    const result: KnownFile[] =  [
        { virtual: '/www/', real: 'pages/home.html', reloadKey: 'home' },
        { virtual: '/www/index.css', real: 'pages/home.css', reloadKey: 'home' },
    ];
    for (const any of ['www'].concat(APP_NAMES)) {
        result.push({ virtual: `/${any}/404`, real: 'pages/404.html', reloadKey: false });
        result.push({ virtual: `/${any}/418`, real: 'pages/418.html', reloadKey: false });
        result.push({ virtual: `/${any}/m`, real: 'pages/user.html', reloadKey: 'user' }); // m: me, my space, my account setting, sign in/sign up
        result.push({ virtual: `/${any}/user.js`, real: 'pages/user.js', reloadKey: 'user' });
        result.push({ virtual: `/${any}/user.css`, real: 'pages/user.css', reloadKey: 'user' });
    }
    for (const app of APP_NAMES) {
        result.push(...getAppFiles(app).map(file => ({ virtual: `/${app}/${file}`, real: `${app}/${file}`, reloadKey: app })));
        if (result.some(r => r.reloadKey == app)) {
            // index.html not exist or empty html file (no local js/css references) is regarded as disabled
            result.push({ virtual: `/${app}/`, real: `${app}/index.html`, reloadKey: app });
        }
    }
    return result;
})();

const now = `"${dayjs.utc().unix().toString(16)}"`;
// name is absolute path, type is content mime type, cache key is timestamp to hex
// content is raw, encoded content is in encodedContent, key is gzip/deflate/br, priority in this order, too
type FileCache = { readonly realpath: string, cacheKey: string, content: Buffer | null, encodedContent: { [encoding: string]: Buffer } };
const fileCache: FileCache[] = knownFiles
    .map(f => f.real)
    .filter((real, index, array) => array.indexOf(real) == index) // distinct
    .map<FileCache>(real => ({
        realpath: path.join("WEBROOT", real),
        // this means "if the content is loaded from disk, the version is 'server init' version"
        // only admin reload will clear content and move forward cache key, any disk file change between them is ignored
        cacheKey: now,
        content: null,
        encodedContent: {},
    }));

// key is /${subdomain ?? 'www'}${path}
type VirtualToCache = { [key: string]: FileCache };
const virtualToCache = knownFiles
    .reduce<VirtualToCache>((acc, f) => { acc[f.virtual] = fileCache.find(c => c.realpath == path.join('WEBROOT', f.real))!; return acc; }, {});
// key is reload key
type ReloadKeyToCache = { [key: string]: FileCache[] };
const reloadKeyToCache: ReloadKeyToCache = knownFiles
    .map(f => f.reloadKey as string) // as string early to make tsc happy, but should still filter by typeof in the next line
    .filter((reloadKey, index, array) => typeof reloadKey == 'string' && array.indexOf(reloadKey) == index)
    .reduce<ReloadKeyToCache>((acc, reloadKey) => {
        acc[reloadKey] = knownFiles
            .filter(f => f.reloadKey == reloadKey)
            .map(f => path.join('WEBROOT', f.real))
            .filter((f, index, array) => array.indexOf(f) == index) // distinct because realpath may duplicate
            .map(f => fileCache.find(c => c.realpath == f)!);
        return acc;
    }, {});

const extensionToContentType: { [ext: string]: string } = { '.html': 'html', '.js': 'js', '.css': 'css', '.map': 'json' };
const encodingToEncoder: { [encoding: string]: (input: Buffer) => Buffer } = { 'gzip': zlib.gzipSync, 'deflate': zlib.deflateSync, 'br': zlib.brotliCompressSync };
export async function handleRequestContent(ctx: koa.ParameterizedContext<DefaultState, DefaultContext, Buffer>, next: koa.Next): Promise<any> {
    if (ctx.subdomains[0] == 'api') { return await next(); } // goto api
    if (ctx.method != 'GET') { throw new MyError('method-not-allowed'); } // reject not GET

    // disable app, because reloadKeyToCache is group by'd, so use Object.keys.include
    if (ctx.subdomains.length == 1 && !(ctx.subdomains[0] in reloadKeyToCache)) {
        ctx.status = 307;
        ctx.set('Location', 'https://domain.com');
        return;
    }

    const virtual = `/${ctx.subdomains.length == 0 ? 'www' : ctx.subdomains[0]}${ctx.path}`;
    if (AllowSourceMap && virtual.endsWith('.map') && virtual.slice(0, -4) in virtualToCache) {
        const realpath = virtualToCache[virtual.slice(0, -4)].realpath + '.map';
        if (fs.existsSync(realpath)) {
            const content = await fs.promises.readFile(realpath);
            ctx.status = 200;
            ctx.body = zlib.gzipSync(content); // source map is more like a binary file, so use br do not improve much, *I think
            ctx.type = 'json';
            ctx.set('Content-Encoding', 'gzip');
            ctx.set('Content-Length', ctx.body.length.toString());
            return;
        }
    }

    if (virtual in virtualToCache) {
        const file = virtualToCache[virtual];
        if (file.content === null) {
            if (!fs.existsSync(file.realpath)) { ctx.status = 404; return; }
            file.content = await fs.promises.readFile(file.realpath);
        }

        // for each etag, trim space, ignore weak
        const requestETags = ctx.request.get('If-None-Match')?.split(',')?.map(t => t.trim())?.filter(t => !t.startsWith('W/'));
        if (requestETags.includes(file.cacheKey)) {
            ctx.status = 304;
            return;
        }

        ctx.set('Cache-Control', 'must-revalidate');
        ctx.set('ETag', file.cacheKey);
        ctx.type = extensionToContentType[path.extname(file.realpath)];

        if (file.content.length < 1024) {
            ctx.body = file.content;
            ctx.set('Content-Length', file.content.length.toString());
            return;
        }

        ctx.vary('Accept-Encoding');
        for (const encoding of ['br', 'gzip', 'deflate']) { // prefer brotli because it is smaller
            if (ctx.acceptsEncodings(encoding)) {
                ctx.set('Content-Encoding', encoding);
                if (!(encoding in file.encodedContent)) {
                    file.encodedContent[encoding] = encodingToEncoder[encoding](file.content);
                }
                ctx.body = file.encodedContent[encoding];
                ctx.set('Content-Length', file.encodedContent[encoding].length.toString());
                return;
            }
        }
    } else {
        const real = path.join("WEBROOT", 'public', ctx.path);
        if (!fs.existsSync(real)) { ctx.status = 404; return; }

        ctx.type = path.extname(ctx.path);
        ctx.body = await fs.promises.readFile(real);
        ctx.set('Cache-Control', 'public');

        // use default cache control
        // image/video themselves are already compressed, while other not important text files are always small
    }
}

function handleReloadPage(pagename: string) {
    const now = `"${dayjs.utc().unix().toString(16)}"`;
    for (const file of reloadKeyToCache[pagename]) {
        if (!fs.existsSync(file.realpath)) {
            continue; // let later get request to 404
        }

        const newContent = fs.readFileSync(file.realpath);
        if (file.content == null || Buffer.compare(file.content, newContent) != 0) { // only refresh when content change, or never loaded
            file.cacheKey = now;
            file.content = null;
            file.encodedContent = {};
        }
    }
}
function handleReloadClient(appname: string) {
    if (!APP_NAMES.includes(appname)) {
        return; // ignore
    }

    // clear all and insert new, but try to use old cache key and encoded content if no content change
    if (appname in reloadKeyToCache) {
        for (const file of reloadKeyToCache[appname]) {
            // delete from fileCache and virtualToCache by reference
            fileCache.splice(fileCache.indexOf(file), 1);
            for (const virtual in /* <- ATTENTION */ virtualToCache) {
                if (virtualToCache[virtual] == file) {
                    delete virtualToCache[virtual];
                }
            }
        }
    }

    // NOTE: this may be undefined if key not in reloadKeyToCache, when app reloaded from disabled to enabled
    const oldCachedFiles = reloadKeyToCache[appname];
    delete reloadKeyToCache[appname];

    const now = `"${dayjs.utc().unix().toString(16)}"`;
    const files = getAppFiles(appname).map<FileCache>(file => {
        const realpath = path.join('WEBROOT', `${appname}/${file}`);
        const oldEntry = oldCachedFiles?.find(c => c.realpath == realpath);
        const newContent = fs.readFileSync(realpath);
        const entry = oldEntry?.content && Buffer.compare(oldEntry.content, newContent) == 0 ? oldEntry : { realpath, cacheKey: now, content: newContent, encodedContent: {} };
        fileCache.push(entry);
        virtualToCache[`/${appname}/${file}`] = entry;
        return entry;
    });

    if (files.length) {
        const realpath = path.join('WEBROOT', `${appname}/index.html`);
        const oldEntry = oldCachedFiles?.find(c => c.realpath == realpath);
        const newContent = fs.readFileSync(realpath);
        const indexEntry = oldEntry?.content && Buffer.compare(oldEntry.content, newContent) == 0 ? oldEntry : { realpath, cacheKey: now, content: newContent, encodedContent: {} };
        fileCache.push(indexEntry);
        virtualToCache[`/${appname}/`] = indexEntry;
        files.push(indexEntry);
        reloadKeyToCache[appname] = files;
    }
}
export function handleCommand(data: AdminServerCoreContentCommand): void {
    logInfo({ type: 'admin command content', data });

    if (data.type == 'reload-page') {
        handleReloadPage(data.pagename);
    } else if (data.type == 'reload-client') {
        handleReloadClient(data.app);
    } else if (data.type == 'enable-source-map') {
        AllowSourceMap = true;
        if (DisableSourceMapTimer) {
            clearTimeout(DisableSourceMapTimer);
        }
        DisableSourceMapTimer = setTimeout(() => AllowSourceMap = false, 7200_000);
    } else if (data.type == 'disable-source-map') {
        AllowSourceMap = false;
    }
}
