// Event notification APIs of version 100.0 (C.6.2.2, C.6.2.3), generic
// part: through the whole app.ts and the notification server, with an event
// class defined by the test.
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
process.env.SERVER_URL = 'localhost';
process.env.WS_PORT_MIN = '46900';
process.env.WS_PORT_MAX = '46999';
process.env.LISTEN_ATTEMPTS = '10';
process.env.MAX_REGISTRATIONS = '32';
process.env.PING_INTERVAL_MS = '15000';

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
const { startNotificationServer, stopNotificationServer } = require('../src/v100.0/modules/notifications/server');
const { listeners } = require('../src/v100.0/modules/notifications/listeners');
/* eslint-enable @typescript-eslint/no-var-requires */

const TEST_CLASS = 'test-class';
const LOCAL = { 'X-TV30-Client-Class': 'standAlone', 'X-TV30-Client-Id': 'cliente-1' };

let server: Server;
let base = '';
before(async () => {
    listeners.defineEventClass(TEST_CLASS);
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await startNotificationServer();
});
after(async () => {
    await stopNotificationServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
    listeners.clear();
});

type Reply = { status: number; apiVersion: string | null; json: any };

async function call(method: string, route: string, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(`${base}/v100.0/tv3/notifications${route}`, { method, headers });
    return { status: res.status, apiVersion: res.headers.get('api-version'), json: await res.json() };
}

async function registerListener(query = ''): Promise<{ handle: string; url: string }> {
    const r = await call('GET', `/${TEST_CLASS}${query}`, LOCAL);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
}

// Resolves with the open socket and the messages it receives, or with the
// HTTP status of a refused upgrade
function connect(url: string): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<void> } | number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const messages: unknown[] = [];
        ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
        const closed = new Promise<void>((done) => ws.on('close', () => done()));
        ws.on('open', () => resolve({ ws, messages, closed }));
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', reject);
    });
}

async function open(url: string): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<void> }> {
    const result = await connect(url);
    assert.ok(typeof result !== 'number', `upgrade refused with HTTP ${result}`);
    return result;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        assert.ok(Date.now() - start < timeoutMs, 'condition not reached in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('registro de ouvinte: classe inválida dá 101; cliente não local dá 107 (C.6.2.2)', async () => {
    const invalid = await call('GET', '/nao-existe', LOCAL);
    assert.equal(invalid.status, 404);
    assert.equal(invalid.json.error, 101);
    assert.equal(invalid.apiVersion, '100.0');

    const nonLocal = await call('GET', `/${TEST_CLASS}`);
    assert.equal(nonLocal.json.error, 107);
});

test('registro de ouvinte: handle e url ws:// do servidor de notificações', async () => {
    const reg = await registerListener();
    assert.match(reg.handle, /^[0-9a-f-]{36}$/);
    assert.match(reg.url, /^ws:\/\/localhost:\d+\/ev\/[A-Za-z0-9_-]+$/);
    await open(reg.url);
    assert.equal(await connect(reg.url.replace(/[^/]+$/, 'inventado')), 404);
    assert.equal(await connect(reg.url.replace('/ev/', '/rd/')), 404);
});

test('publicação: só os ouvintes da classe aceitos pelos parâmetros recebem', async () => {
    const all = await open((await registerListener()).url);
    const filtered = await open((await registerListener('?classId=b')).url);
    listeners.defineEventClass('outra-classe');
    const otherReg = await call('GET', '/outra-classe', LOCAL);
    const other = await open(otherReg.json.url);

    const event = { eventType: 'available', classId: 'a', sequence: 1 };
    listeners.publish(TEST_CLASS, event, (params: Record<string, string>) => !params.classId || params.classId === 'a');
    await waitFor(() => all.messages.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(all.messages, [event]);
    assert.equal(filtered.messages.length, 0);
    assert.equal(other.messages.length, 0);
});

test('cancelamento: {} e fecha o WebSocket; repetido dá 305 (C.6.2.3)', async () => {
    const reg = await registerListener();
    const listener = await open(reg.url);
    const removed = await call('DELETE', `/${reg.handle}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json, {});
    await listener.closed;
    assert.equal((await call('DELETE', `/${reg.handle}`)).json.error, 305);
    assert.equal(await connect(reg.url), 404);
});

test('conexão: nova conexão do ouvinte substitui a anterior; o registro continua após o fechamento', async () => {
    const reg = await registerListener();
    const first = await open(reg.url);
    const second = await open(reg.url);
    await first.closed;
    second.ws.close();
    await second.closed;

    const third = await open(reg.url);
    listeners.publish(TEST_CLASS, { n: 1 }, () => true);
    await waitFor(() => third.messages.length === 1);
});
