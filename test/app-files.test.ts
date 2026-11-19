// GET /tv3/current-service/apps/<appId>/files (ABNT NBR 25608, C.6.4.7,
// Table C.17) through the whole app.ts, with Redis and MQTT by doubles and the
// object proxy by an HTTP server that serves the received files of each
// context origin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import http, { Server } from 'http';
import { createFakeRedis } from './helpers/fake-redis';
import { createFakeMqtt, TOPICS } from './helpers/fake-mqtt';
import './helpers/v100-env';

type Served = { contentType: string; body: Buffer };

const fake = createFakeRedis();
const mqtt = createFakeMqtt();

function stub(rel: string, exports: object): void {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
stub('redis-client', { default: fake.redis });
stub('mqtt-client', { default: mqtt.mqttClient, TOPICS, client: mqtt.client });

const SERVICE_ID = 1002;
const APPS_DOMAIN = 'apps.localhost';
const CONTEXT_A = 'urn:sbtvd:app:1002:a';
const CONTEXT_B = 'urn:sbtvd:app:1002:b';
const APP_A = 'urn:sbtvd:app:1002:principal';
const APP_B = 'urn:sbtvd:app:1002:outra';
const BOUNDARY = 'pkg-1';
const PACKAGE_BODY = Buffer.from(
    `--${BOUNDARY}\r\nContent-Type: text/html\r\nContent-Location: index.html\r\n\r\n<p>ola</p>\r\n`
    + `--${BOUNDARY}\r\nContent-Type: text/javascript\r\nContent-Location: js/app.js\r\n\r\nrun();\r\n`
    + `--${BOUNDARY}--\r\n`);
const VIDEO = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

// tsi 10 for context A (by the flow), tsi 11 with a file of A (by the file)
// and one of B.
const STSID = { RS: [{ LS: [
    { tsi: 10, SrcFlow: { EFDT: { 'FDT-Instance': { appContextIdList: [CONTEXT_A], File: [
        { 'Content-Location': 'app.pkg', 'Content-Type': 'multipart/related',
            'Content-Length': PACKAGE_BODY.length, 'Transfer-Length': PACKAGE_BODY.length },
        { 'Content-Location': 'media/clip.mp4', 'Content-Type': 'video/mp4',
            'Content-Length': VIDEO.length, 'Transfer-Length': VIDEO.length },
        { 'Content-Location': 'media/late.txt', 'Content-Type': 'text/plain',
            'Content-Length': 4, 'Transfer-Length': 4 },
    ] } } } },
    { tsi: 11, SrcFlow: { EFDT: { 'FDT-Instance': { File: [
        { 'Content-Location': 'aviso.txt', 'Content-Type': 'text/plain',
            'Content-Length': 5, 'Transfer-Length': 5, appContextIdList: [CONTEXT_A] },
        { 'Content-Location': 'marca.txt', 'Content-Type': 'text/plain',
            'Content-Length': 3, 'Transfer-Length': 3, appContextIdList: [CONTEXT_B] },
    ] } } } },
] }] };
const BALD = { EntryPackage: [
    { appId: APP_A, appContextId: CONTEXT_A },
    { appId: APP_B, appContextId: CONTEXT_B },
] };

// Received files by context label and path; media/late.txt is not received.
const received = new Map<string, Map<string, Served>>([
    [contextLabel(CONTEXT_A), new Map([
        ['app.pkg', { contentType: `multipart/related; type="text/html"; boundary=${BOUNDARY}`, body: PACKAGE_BODY }],
        ['index.html', { contentType: 'text/html', body: Buffer.from('<p>ola</p>') }],
        ['js/app.js', { contentType: 'text/javascript', body: Buffer.from('run();') }],
        ['media/clip.mp4', { contentType: 'video/mp4', body: VIDEO }],
        ['aviso.txt', { contentType: 'text/plain', body: Buffer.from('aviso') }],
    ])],
    [contextLabel(CONTEXT_B), new Map()],
]);

let app: { listen: (port: number, host: string, callback: () => void) => Server };
let server: Server;
let proxy: Server;
let base = '';

before(async () => {
    proxy = http.createServer((req, res) => {
        const label = (req.headers.host ?? '').replace(`.${APPS_DOMAIN}`, '');
        const file = received.get(label)?.get(decodeURIComponent((req.url ?? '/').slice(1)));
        if (file === undefined) {
            res.writeHead(404).end('not in the carousel nor in the cache');
            return;
        }
        res.writeHead(200, { 'Content-Type': file.contentType }).end(file.body);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    process.env.OBJECT_PROXY_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`;
    process.env.APPS_DOMAIN = APPS_DOMAIN;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require('../src/app').default;
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3/current-service/apps`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

function contextLabel(appContextId: string): string {
    return 'ctx-' + crypto.createHash('sha256').update(appContextId, 'utf8').digest('hex').slice(0, 16);
}

async function tune(): Promise<void> {
    await mqtt.deliver(TOPICS.tuned, JSON.stringify({ serviceId: SERVICE_ID, rfChannelId: 10, tunedAt: '2026-11-19T12:00:00Z' }));
    await mqtt.deliver(`tlm/sls/${SERVICE_ID}/bald`, JSON.stringify(BALD));
    await mqtt.deliver(`tlm/sls/${SERVICE_ID}/stsid`, JSON.stringify(STSID));
}

async function files(appId: string, rawQuery?: string, headers: Record<string, string> = {}) {
    const query = rawQuery === undefined ? '' : `?${rawQuery}`;
    const res = await fetch(`${base}/${encodeURIComponent(appId)}/files${query}`, { headers });
    const type = res.headers.get('content-type') ?? '';
    const raw = Buffer.from(await res.arrayBuffer());
    const text = raw.toString('utf8');
    return { status: res.status, type, raw, text, headers: res.headers, json: /json/.test(type) ? JSON.parse(text) : undefined };
}

function expectError(r: Awaited<ReturnType<typeof files>>, code: number, what: string): void {
    assert.equal(r.json?.error, code, `${what}: ${r.status} ${r.text.slice(0, 120)}`);
}

test('without a tuned service: 300', async () => {
    expectError(await files(APP_A), 300, 'not tuned');
});

test('base listing: the files of the context in the S-TSID, with the parts of the received package', async () => {
    await tune();
    for (const query of [undefined, 'path=', 'path=/']) {
        const r = await files(APP_A, query);
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(r.json, {
            files: [
                { name: 'app.pkg', size: PACKAGE_BODY.length },
                { name: 'aviso.txt', size: 5 },
                { name: 'index.html', size: 10 },
            ],
            dirs: [{ name: 'js' }, { name: 'media' }],
        }, String(query));
    }
});

test('directory listing: received or not, with the size of the S-TSID; trailing slash optional', async () => {
    await tune();
    for (const query of ['path=media', 'path=/media/']) {
        const r = await files(APP_A, query);
        assert.deepEqual(r.json, {
            files: [{ name: 'clip.mp4', size: VIDEO.length }, { name: 'late.txt', size: 4 }],
            dirs: [],
        }, query);
    }
});

test('file: the content through the object proxy, with the MIME of the extension; leading slash optional', async () => {
    await tune();
    for (const query of ['path=js/app.js', 'path=/js/app.js']) {
        const r = await files(APP_A, query);
        assert.equal(r.status, 200, r.text);
        assert.equal(r.text, 'run();');
        assert.match(r.type, /^text\/javascript/);
    }
    const unknown = await files(APP_A, 'path=app.pkg');
    assert.equal(unknown.type, 'application/octet-stream');
    assert.deepEqual(unknown.raw, PACKAGE_BODY);
});

test('Range on a video: 206 with the slice', async () => {
    await tune();
    const r = await files(APP_A, 'path=media/clip.mp4', { Range: 'bytes=2-5' });
    assert.equal(r.status, 206);
    assert.deepEqual(r.raw, VIDEO.subarray(2, 6));
    assert.equal(r.headers.get('content-range'), `bytes 2-5/${VIDEO.length}`);
});

test('listed file not received: 305', async () => {
    await tune();
    expectError(await files(APP_A, 'path=media/late.txt'), 305, 'not received');
});

test('path outside the filesystem of the application: 305', async () => {
    await tune();
    for (const query of ['path=marca.txt', 'path=../marca.txt', 'path=nada', 'path=js/app.js/', 'path=a&path=b']) {
        expectError(await files(APP_A, query), 305, query);
    }
});

test('appId: any of the BALD of the tuned service, with its own context; outside it, 305', async () => {
    await tune();
    const other = await files(APP_B);
    assert.deepEqual(other.json, { files: [{ name: 'marca.txt', size: 3 }], dirs: [] });
    expectError(await files(APP_B, 'path=marca.txt'), 305, 'marca.txt not received');
    expectError(await files('urn:sbtvd:app:1002:nenhuma'), 305, 'appId outside the BALD');
});

test('package not received: listed without its parts', async () => {
    await tune();
    const files_ = received.get(contextLabel(CONTEXT_A))!;
    const saved = files_.get('app.pkg')!;
    files_.delete('app.pkg');
    try {
        const r = await files(APP_A);
        assert.deepEqual(r.json.files.map((file: { name: string }) => file.name), ['app.pkg', 'aviso.txt']);
        assert.deepEqual(r.json.dirs, [{ name: 'media' }]);
    } finally {
        files_.set('app.pkg', saved);
    }
});
