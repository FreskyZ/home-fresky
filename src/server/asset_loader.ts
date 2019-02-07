import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import express from 'express';
import moment from 'moment';

// temp, should be in logger
const formatLogTime = (time: number) => moment(time).format('Y-M-D HH:mm:ss.sss Z');

const rootDirectory = process.cwd();
const assetDirectory = path.join(rootDirectory, 'asset');

// you can find '.index.html.swp', '4913', 'index.html~', etc. strange names in file system watcher
// so limit valid files to white list extensions
// 1. .js.map makes you use String.prototype.endsWith not path.extname
// 2. .ico is for /favicon.ico, .txt is for /robots.txt
const allowedExtensions = ['.html', '.js', '.js.map', '.css', '.ico', '.txt'];
const contentTypes: { [ext: string]: string } = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.js.map': 'application/javascript',
    '.css': 'text/css',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain',
};
const isAsset: (name: string) => boolean = name =>
    name[0] != '.' && allowedExtensions.some(ext => name.endsWith(ext));

class Handler {
    public readonly logDescription: string;   // loaded /static/acct.js from static/acct.js, mtime ...
    public readonly assetPath: string;
    public readonly httpContentType: string;

    public enabled: boolean;
    public updateTime: number;
    public content: Buffer;

    public readonly call: (request: express.Request, response: express.Response) => void;

    // 2nd, 3rd parameter only for logging
    public constructor(assetPath: string, loaderDirectory: string, routeName: string) {

        const assetName = path.basename(assetPath);
        this.logDescription =
            `${path.join(loaderDirectory, routeName)} from asset${path.join(loaderDirectory, assetName)}`;

        this.assetPath = assetPath;
        const extension = allowedExtensions.find(e => assetPath.endsWith(e))!; // already filtered
        this.httpContentType = contentTypes[extension];

        this.enabled = true;

        let stat = fs.statSync(assetPath);
        if (stat.size == 0) stat = fs.statSync(assetPath); // see tryUpdate's same statement

        this.updateTime = stat.mtimeMs;
        this.content = fs.readFileSync(assetPath);
        console.log(`load ${this.logDescription}, init size ${stat.size}, mtime ${formatLogTime(this.updateTime)}`);

        this.call = (_request, response) => {
            if (this.enabled) {
                response
                    .header('Content-Type', this.httpContentType)
                    .header('Last-Modified', new Date(this.updateTime).toString())
                    .send(this.content);
            } else {
                response.redirect('/404');
            }
        }
    }

    public disable(): void {
        this.enabled = false;
        console.log(`disable ${this.logDescription}`);
    }

    public tryUpdate(): void {
        let stat = fs.statSync(this.assetPath);

        // this is a complex issue, after creating new file (e.g. echo balabala > balabal)
        // direct fs.exists() in fs.watch()'s callback will return true, but fs.stat() still returns 0
        // then this will load nothing
        // add an console.log into watcher kind of proof that (console io is very very slow compare to other operations)
        // so make another call of fs.stat() to try to cover this issue
        //
        // in short words:
        // - "what? you say your size is 0? (I can't believe it) What's your size again? "
        // - "it's 0" / "it's 42"
        // - "oh I know your size hondoni is 0" / "ok your size is 42"
        if (stat.size == 0) stat = fs.statSync(this.assetPath);

        // ignore change size to 0, webpack seems to clear content at first then write contents
        if (stat.size == 0) return;

        // always use larger mtime
        if (this.enabled && this.updateTime >= stat.mtimeMs) return;

        const operation = this.enabled ? 'reload' : 'reenable';
        this.enabled = true;
        this.updateTime = stat.mtimeMs;
        this.content = fs.readFileSync(this.assetPath);

        console.log(`${operation} ${this.logDescription}, new size ${stat.size}, mtime ${formatLogTime(this.updateTime)}`);
    }
}

// Dynamic Asset Manager
// no, this is not securitization asset collection
//
// const static_watcher = new AssetCollection('/static').setup(app).startWatch();
// const root_watcher = new AssetCollection('/', name => name == 'index.html' ? '' : name).setup(app).startWatch();
//
// create handler for each asset
// because all asset count will not exceed 100, it will not be a performance issue that storing and calling the functions
// handler will be pooled and unused handlers (unloaded assets) will not be removed but only disabled (redirect 404)
// later loading will reuse previous pooled handler
export default class DynamicAssetLoader {
    public readonly subDirectory: string; // '/' or '/app', etc.
    private readonly absoluteDirectory: string; // absolute version

    private readonly routeMapper: (name: string) => string;
    private readonly router: express.Router;
    private readonly handlers: { [route: string]: Handler };

    private watcher: fs.FSWatcher | null;
    constructor(
        subDirectory: string,
        routeMapper?: (name: string) => string // NOTE that result will be used as key
    ) {
        this.subDirectory = subDirectory;
        this.absoluteDirectory = path.join(assetDirectory, this.subDirectory);

        this.router = express.Router();
        this.handlers = {};
        this.routeMapper = routeMapper || ((x: string): string => x);

        this.watcher = null;

        fs.readdirSync(this.absoluteDirectory).filter(isAsset).map(assetName => {
            const routeName = this.routeMapper(assetName);
            const assetPath = path.join(this.absoluteDirectory, assetName);

            const handler = new Handler(assetPath, this.subDirectory, routeName);
            this.handlers[routeName] = handler;
            this.router.get('/' + routeName, handler.call);
        });
    }

    public setup(app: express.Application): DynamicAssetLoader {
        app.use(this.subDirectory, this.router);
        return this;
    }

    public startWatch(): DynamicAssetLoader {
        this.watcher = fs.watch(this.absoluteDirectory, (eventType, fileName) => {
            if (!isAsset(fileName)) return;

            // console.log(`watcher after filter, eventType = ${eventType}, fileName = ${fileName}`);

            const routeName = this.routeMapper(fileName);
            const filePath = path.join(this.absoluteDirectory, fileName);
            if (eventType == 'rename') {
                if (fs.existsSync(filePath)) { // new file
                    if (routeName in this.handlers) {
                        this.handlers[routeName].tryUpdate();
                    } else {
                        const handler = new Handler(filePath, this.subDirectory, routeName);
                        this.handlers[routeName] = handler;
                        this.router.get('/' + routeName, handler.call);
                    }
                } else { // remove file
                    if (routeName in this.handlers) {
                        this.handlers[routeName].disable();
                    } // ignore file not exist and handlers not exist
                }
            } else if (eventType == 'change') { // update
                if (fs.existsSync(filePath) && routeName in this.handlers) { // sometimes it happens
                    this.handlers[routeName].tryUpdate();
                }
            }
        });

        return this;
    }

    public stopWatch(): void {
        if (this.watcher != null) {
            this.watcher.close();
        }
    }
};

