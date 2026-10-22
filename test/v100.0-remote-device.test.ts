// Remote device communication APIs, version 100.0 (proposal v2 of C.6.15),
// through the whole app.ts and the entry server, with redis-client and
// mqtt-client replaced by test doubles.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { WebSocket } from 'ws';
import { createFakeRedis } from './helpers/fake-redis';
import { createFakeMqtt, TOPICS } from './helpers/fake-mqtt';

// read when the modules load
process.env.TV3WS_WS_TLS = 'false';
process.env.SERVER_URL = 'localhost';
process.env.WS_PORT_MIN = '46800';
process.env.WS_PORT_MAX = '46899';
process.env.MAX_REGISTRATIONS = '3';
process.env.PING_INTERVAL_MS = '100';

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

/* eslint-disable @typescript-eslint/no-var-requires */
const app = require('../src/app').default;
const { startEntryServer, stopEntryServer, localEntryPointUrl } = require('../src/v100.0/modules/remote-device/entry-server');
const { registries } = require('../src/v100.0/modules/remote-device/manager');
/* eslint-enable @typescript-eslint/no-var-requires */

const PING_INTERVAL_MS = 100;
const VALID_BODY = { deviceClass: 'c', supportedTypes: ['t'] };

let server: Server;
let base = '';
before(async () => {
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await startEntryServer();
});
after(async () => {
    await stopEntryServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
    registries.clear();
});

type Reply = { status: number; apiVersion: string | null; json: any };

async function call(method: string, route: string, body?: unknown, raw?: string): Promise<Reply> {
    const init: RequestInit = { method };
    if (body !== undefined || raw !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = raw ?? JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, init);
    const text = await res.text();
    return { status: res.status, apiVersion: res.headers.get('api-version'), json: text ? JSON.parse(text) : undefined };
}

const v100 = (route: string) => `/v100.0/tv3/remote-device${route}`;

function expectError(r: Reply, code: number): void {
    assert.equal(r.status, 404);
    assert.equal(r.json?.error, code, JSON.stringify(r.json));
    assert.equal(r.apiVersion, '100.0');
}

async function register(): Promise<{ handle: string; url: string }> {
    const r = await call('POST', v100(''), VALID_BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
}

// Resolves with the open socket, or with the HTTP status of a refused upgrade
function connect(url: string, options: { autoPong?: boolean } = {}): Promise<WebSocket | number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, options);
        ws.on('open', () => resolve(ws));
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', reject);
    });
}

async function open(url: string, options: { autoPong?: boolean } = {}): Promise<WebSocket> {
    const result = await connect(url, options);
    assert.ok(result instanceof WebSocket, `upgrade refused with HTTP ${result}`);
    return result;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        assert.ok(Date.now() - start < timeoutMs, 'condition not reached in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const isConnected = (handle: string) => registries.getRegistryByHandle(handle)?.isConnected() === true;

test('rotas fora da 100.0 dão 100, com API-Version 100.0 e sem o prefixo na descrição', async () => {
    expectError(await call('GET', v100('/device/x')), 100);
    expectError(await call('DELETE', v100('/device/x')), 100);
    const r = await call('GET', '/v100.0/tv3/nao-existe');
    expectError(r, 100);
    assert.equal(r.json.description.includes('/v100.0'), false, r.json.description);
});

test('JSON malformado: 101 com API-Version 100.0', async () => {
    expectError(await call('POST', v100(''), undefined, '{bad'), 101);
});

test('validação do corpo nas duas rotas POST (Seção 2.5)', async () => {
    const cases: [unknown, number, string][] = [
        [undefined, 101, 'message body'],
        [[], 101, 'message body'],
        [{}, 105, 'deviceClass, supportedTypes'],
        [{ deviceClass: 'a' }, 105, 'supportedTypes'],
        [{ deviceClass: 1 }, 105, 'supportedTypes'],
        [{ deviceClass: null, supportedTypes: [] }, 101, 'deviceClass'],
        [{ deviceClass: 'a', supportedTypes: 'x' }, 101, 'supportedTypes'],
        [{ deviceClass: 'a', supportedTypes: ['a', 1] }, 101, 'supportedTypes'],
    ];
    for (const route of [v100(''), v100('/h1')]) {
        for (const [body, code, detail] of cases) {
            const r = await call('POST', route, body);
            expectError(r, code);
            assert.ok(r.json.description.endsWith(detail), `${route} ${JSON.stringify(body)}: ${r.json.description}`);
        }
    }
    const accepted = await call('POST', v100(''), { deviceClass: '', supportedTypes: [] });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
});

test('sem o prefixo, a rota continua na 2.0', async () => {
    const r = await call('POST', '/tv3/remote-device', {});
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 105);
    assert.equal(r.apiVersion, '2.0');
});

test('registro, atualização e cancelamento (C.6.15.2, C.6.15.3)', async () => {
    const reg = await register();
    assert.match(reg.url, /^ws:\/\/localhost:\d+\/rd\/[A-Za-z0-9_-]+$/);

    const updated = await call('POST', v100(`/${reg.handle}`), { deviceClass: 'd', supportedTypes: [] });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.json, { handle: reg.handle });
    expectError(await call('POST', v100('/nao-existe'), VALID_BODY), 305);

    const removed = await call('DELETE', v100(`/${reg.handle}`));
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json, {});
    expectError(await call('DELETE', v100(`/${reg.handle}`)), 305);
});

test('ponto de entrada: 404 para token inventado, outro caminho e registro removido', async () => {
    const reg = await register();
    assert.equal(await connect(reg.url.replace(/[^/]+$/, 'inventado')), 404);
    assert.equal(await connect(reg.url.replace('/rd/', '/xx/')), 404);
    await call('DELETE', v100(`/${reg.handle}`));
    assert.equal(await connect(reg.url), 404);
});

test('ciclo de vida: conecta, cai e reconecta; a segunda conexão substitui a primeira (Figura C.7)', async () => {
    const reg = await register();
    assert.equal(isConnected(reg.handle), false);

    const first = await open(reg.url);
    await waitFor(() => isConnected(reg.handle));
    first.close();
    await waitFor(() => !isConnected(reg.handle));

    const second = await open(reg.url);
    await waitFor(() => isConnected(reg.handle));
    const secondClosed = new Promise((resolve) => second.on('close', resolve));
    const third = await open(reg.url);
    await secondClosed;
    assert.equal(isConnected(reg.handle), true);

    const thirdClosed = new Promise((resolve) => third.on('close', resolve));
    await call('DELETE', v100(`/${reg.handle}`));
    await thirdClosed;
});

test('limite: descarta o registro desconectado há mais tempo; 200 com todos conectados (C.6.15.2)', async () => {
    const oldest = await register();
    const connected = await register();
    const ws = await open(connected.url);
    await waitFor(() => isConnected(connected.handle));
    const newest = await register();

    await register();
    assert.equal(registries.getRegistryByHandle(oldest.handle), undefined);
    assert.equal(await connect(oldest.url), 404);
    assert.notEqual(registries.getRegistryByHandle(newest.handle), undefined);

    registries.clear();
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
        const reg = await register();
        sockets.push(await open(reg.url));
        await waitFor(() => isConnected(reg.handle));
    }
    expectError(await call('POST', v100(''), VALID_BODY), 200);
    assert.equal(registries.size(), 3);
    ws.close();
});

test('keep-alive: a conexão que não responde ao ping é encerrada; a que responde continua (C.6.15.1)', async () => {
    const responsive = await register();
    const silent = await register();
    const ok = await open(responsive.url);
    await open(silent.url, { autoPong: false });
    await waitFor(() => isConnected(responsive.handle) && isConnected(silent.handle));

    await waitFor(() => !isConnected(silent.handle), PING_INTERVAL_MS * 5);
    assert.equal(isConnected(responsive.handle), true);
    assert.equal(ok.readyState, WebSocket.OPEN);
});

test('listagem: 107 sem a classe de cliente local repassada pela borda (C.6.15.5)', async () => {
    expectError(await call('GET', v100('/devices/c')), 107);
    const noId = await fetch(`${base}${v100('/devices/c')}`, { headers: { 'X-TV30-Client-Class': 'standAlone' } });
    assert.equal((await noId.json()).error, 107);
    const other = await fetch(`${base}${v100('/devices/c')}`, { headers: { 'X-TV30-Client-Class': 'nonLocal', 'X-TV30-Client-Id': 'x' } });
    assert.equal((await other.json()).error, 107);
});

test('sequence por classe: sobe a cada available e unavailable, não na troca de conexão (Tabela C.87)', async () => {
    const sequence = (deviceClass: string) => registries.getSequence(deviceClass);
    const start = sequence('c');
    assert.equal(sequence('classe-sem-eventos'), 0);

    const reg = await register();
    assert.equal(sequence('c'), start);

    const first = await open(reg.url);
    await waitFor(() => isConnected(reg.handle));
    assert.equal(sequence('c'), start + 1);

    const firstClosed = new Promise((resolve) => first.on('close', resolve));
    const second = await open(reg.url);
    await firstClosed;
    assert.equal(sequence('c'), start + 1);

    const moved = await call('POST', v100(`/${reg.handle}`), { deviceClass: 'd', supportedTypes: [] });
    assert.equal(moved.status, 200);
    assert.equal(sequence('c'), start + 2);
    const startD = sequence('d');

    second.close();
    await waitFor(() => !isConnected(reg.handle));
    assert.equal(sequence('d'), startD + 1);

    const third = await open(reg.url);
    await waitFor(() => isConnected(reg.handle));
    const thirdClosed = new Promise((resolve) => third.on('close', resolve));
    await call('DELETE', v100(`/${reg.handle}`));
    await thirdClosed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sequence('d'), startD + 3);
});

test('servidores de entrada: cada um aceita só o seu tipo de token; local é ws:// em outra porta', async () => {
    const reg = await register();
    const registry = registries.getRegistryByHandle(reg.handle);
    const localUrl = localEntryPointUrl(registries.addLocalEntryPoint(registry, 'cli', 'standAlone'));
    assert.match(localUrl, /^ws:\/\/localhost:\d+\/rd\/[A-Za-z0-9_-]+$/);
    const devicePort = new URL(reg.url).port;
    const localPort = new URL(localUrl).port;
    assert.notEqual(devicePort, localPort);

    const deviceTokenOnLocal = reg.url.replace(`:${devicePort}/`, `:${localPort}/`);
    assert.equal(await connect(deviceTokenOnLocal), 404);
    const localTokenOnDevice = localUrl.replace(`:${localPort}/`, `:${devicePort}/`);
    assert.equal(await connect(localTokenOnDevice), 404);
    assert.equal(await connect(localUrl), 404);
});
