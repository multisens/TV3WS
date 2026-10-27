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
process.env.LISTEN_ATTEMPTS = '10';
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
const { startNotificationServer, stopNotificationServer } = require('../src/v100.0/modules/notifications/server');
const { startProjection } = require('../src/v100.0/modules/remote-device/projection');
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
    await startNotificationServer();
    await startProjection();
});
after(async () => {
    await stopEntryServer();
    await stopNotificationServer();
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

// Messages and close code of each socket, recorded from its creation, so
// that nothing sent right after the upgrade is missed
const received = new WeakMap<WebSocket, unknown[]>();
const closed = new WeakMap<WebSocket, Promise<number>>();

// Resolves with the open socket, or with the HTTP status of a refused upgrade
function connect(url: string, options: { autoPong?: boolean } = {}): Promise<WebSocket | number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, options);
        const messages: unknown[] = [];
        received.set(ws, messages);
        ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
        closed.set(ws, new Promise((done) => ws.on('close', (code) => done(code))));
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
        [{ deviceClass: '', supportedTypes: [] }, 101, 'deviceClass'],
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
    const accepted = await call('POST', v100(''), { deviceClass: 'a', supportedTypes: [] });
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
});

// Messages received by the socket, in order
function inbox(ws: WebSocket): unknown[] {
    return received.get(ws) ?? [];
}

function closeCode(ws: WebSocket): Promise<number> {
    return closed.get(ws) ?? Promise.resolve(0);
}

// Registers and connects a device; returns its registry and socket
async function connectedDevice(): Promise<{ handle: string; registry: any; device: WebSocket; deviceInbox: unknown[] }> {
    const reg = await register();
    const device = await open(reg.url);
    const deviceInbox = inbox(device);
    await waitFor(() => isConnected(reg.handle));
    return { handle: reg.handle, registry: registries.getRegistryByHandle(reg.handle), device, deviceInbox };
}

const localUrlOf = (registry: any, clientId: string, clientType: string) =>
    localEntryPointUrl(registries.addLocalEntryPoint(registry, clientId, clientType));

test('par: forma na conexão local; o dispositivo recebe pairFormed (Figura C.8, Tabela C.86)', async () => {
    const { registry, deviceInbox } = await connectedDevice();
    const before = registries.getSequence('c');
    await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => deviceInbox.length === 1);
    assert.deepEqual(deviceInbox, [{ event: 'pairFormed', clientType: 'standAlone' }]);
    assert.equal(registry.isPaired(), true);
    assert.equal(registries.getSequence('c'), before + 1);
});

test('par: segundo stand-alone e segundo associado são recusados com deviceBusy (4001)', async () => {
    const { registry, deviceInbox } = await connectedDevice();
    await open(localUrlOf(registry, 'sa1', 'standAlone'));
    for (const [clientId, clientType] of [['sa2', 'standAlone']]) {
        const ws = await open(localUrlOf(registry, clientId, clientType));
        const messages = inbox(ws);
        assert.equal(await closeCode(ws), 4001);
        assert.deepEqual(messages, [{ event: 'pairRefused', reason: 'deviceBusy' }]);
    }

    const other = await connectedDevice();
    await open(localUrlOf(other.registry, 'associated', 'associated'));
    const ws = await open(localUrlOf(other.registry, 'associated-2', 'associated'));
    const messages = inbox(ws);
    assert.equal(await closeCode(ws), 4001);
    assert.deepEqual(messages, [{ event: 'pairRefused', reason: 'deviceBusy' }]);
    await waitFor(() => deviceInbox.length === 1);
    assert.equal(other.deviceInbox.length, 1);
});

test('par: dispositivo desconectado recusa com deviceUnavailable (4002)', async () => {
    const reg = await register();
    const registry = registries.getRegistryByHandle(reg.handle);
    const ws = await open(localUrlOf(registry, 'sa', 'standAlone'));
    const messages = inbox(ws);
    assert.equal(await closeCode(ws), 4002);
    assert.deepEqual(messages, [{ event: 'pairRefused', reason: 'deviceUnavailable' }]);
    assert.equal(registry.isPaired(), false);
});

test('par: associado sobre stand-alone transfere o par, na ordem da Tabela C.86, sem evento', async () => {
    const { registry, deviceInbox } = await connectedDevice();
    const standAlone = await open(localUrlOf(registry, 'sa', 'standAlone'));
    const standAloneInbox = inbox(standAlone);
    await waitFor(() => deviceInbox.length === 1);
    const before = registries.getSequence('c');

    const standAloneClosed = closeCode(standAlone);
    await open(localUrlOf(registry, 'associated', 'associated'));
    assert.equal(await standAloneClosed, 4003);
    assert.deepEqual(standAloneInbox, [{ event: 'pairEnded', reason: 'preemptedByAssociated' }]);
    await waitFor(() => deviceInbox.length === 3);
    assert.deepEqual(deviceInbox.slice(1), [
        { event: 'pairEnded', clientType: 'standAlone' },
        { event: 'pairFormed', clientType: 'associated' },
    ]);
    assert.equal(registry.getPair().clientType, 'associated');
    assert.equal(registries.getSequence('c'), before);
});

test('par: nova conexão do mesmo cliente substitui a anterior, sem mensagem ao dispositivo', async () => {
    const { registry, deviceInbox } = await connectedDevice();
    const url = localUrlOf(registry, 'sa', 'standAlone');
    const first = await open(url);
    await waitFor(() => deviceInbox.length === 1);
    const firstClosed = closeCode(first);
    const second = await open(url);
    await firstClosed;
    assert.equal(registry.getPair().ws !== undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deviceInbox.length, 1);
    assert.equal(second.readyState, WebSocket.OPEN);
});

test('par: nova conexão do dispositivo em par recebe pairFormed', async () => {
    const reg = await register();
    const registry = registries.getRegistryByHandle(reg.handle);
    await open(reg.url);
    await waitFor(() => isConnected(reg.handle));
    await open(localUrlOf(registry, 'associated', 'associated'));
    await waitFor(() => registry.isPaired());

    const replacement = await open(reg.url);
    const messages = inbox(replacement);
    await waitFor(() => messages.length === 1);
    assert.deepEqual(messages, [{ event: 'pairFormed', clientType: 'associated' }]);
});

test('repasse: mensagens vão do cliente do par ao dispositivo e voltam (C.6.15.5)', async () => {
    const { registry, device, deviceInbox } = await connectedDevice();
    const client = await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => deviceInbox.length === 1);

    client.send(JSON.stringify({ type: 'video', capabilities: [{ name: 'state' }] }));
    await waitFor(() => deviceInbox.length === 2);
    assert.deepEqual(deviceInbox[1], { type: 'video', capabilities: [{ name: 'state' }] });

    device.send(JSON.stringify({ type: 'video', capabilities: [{ name: 'state', value: 'idle' }] }));
    await waitFor(() => inbox(client).length === 1);
    assert.deepEqual(inbox(client)[0], { type: 'video', capabilities: [{ name: 'state', value: 'idle' }] });
});

test('repasse: o stand-alone preterido não chega mais ao dispositivo', async () => {
    const { registry, deviceInbox } = await connectedDevice();
    const standAlone = await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => deviceInbox.length === 1);
    const preempted = closeCode(standAlone);
    await open(localUrlOf(registry, 'associated', 'associated'));
    await waitFor(() => deviceInbox.length === 3);
    if (standAlone.readyState === WebSocket.OPEN) {
        standAlone.send(JSON.stringify({ late: true }));
    }
    await preempted;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(deviceInbox.length, 3);
});

test('fim do par: o cliente fecha; o dispositivo recebe pairEnded e o evento sobe (Figura C.8)', async () => {
    const { registry, deviceInbox } = await connectedDevice();
    const client = await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => deviceInbox.length === 1);
    const before = registries.getSequence('c');

    client.close();
    await waitFor(() => deviceInbox.length === 2);
    assert.deepEqual(deviceInbox[1], { event: 'pairEnded', clientType: 'standAlone' });
    assert.equal(registry.isPaired(), false);
    assert.equal(registries.getSequence('c'), before + 1);

    const again = await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => deviceInbox.length === 3);
    assert.equal(again.readyState, WebSocket.OPEN);
});

test('fim do par: o dispositivo cai; o cliente recebe pairEnded/deviceUnavailable (4002), um só evento', async () => {
    const { registry, device, deviceInbox } = await connectedDevice();
    const client = await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => deviceInbox.length === 1);
    const before = registries.getSequence('c');

    const clientClosed = closeCode(client);
    device.close();
    assert.equal(await clientClosed, 4002);
    assert.deepEqual(inbox(client), [{ event: 'pairEnded', reason: 'deviceUnavailable' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(registry.isPaired(), false);
    assert.equal(registries.getSequence('c'), before + 1);
});

test('fim do par: o DELETE do registro avisa o cliente com deviceUnavailable (4002)', async () => {
    const { handle, registry, deviceInbox } = await connectedDevice();
    const client = await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => deviceInbox.length === 1);
    const clientClosed = closeCode(client);
    await call('DELETE', v100(`/${handle}`));
    assert.equal(await clientClosed, 4002);
    assert.deepEqual(inbox(client), [{ event: 'pairEnded', reason: 'deviceUnavailable' }]);
});

const STAND_ALONE = { 'X-TV30-Client-Class': 'standAlone', 'X-TV30-Client-Id': 'cliente-1' };
const OTHER_STAND_ALONE = { 'X-TV30-Client-Class': 'standAlone', 'X-TV30-Client-Id': 'cliente-2' };
const ASSOCIATED = { 'X-TV30-Client-Class': 'associated' };

async function list(deviceClass: string, headers: Record<string, string>): Promise<Reply> {
    const res = await fetch(`${base}${v100(`/devices/${deviceClass}`)}`, { headers });
    return { status: res.status, apiVersion: res.headers.get('api-version'), json: await res.json() };
}

async function registerIn(deviceClass: string): Promise<{ handle: string; url: string }> {
    const r = await call('POST', v100(''), { deviceClass, supportedTypes: ['application/x-ncl360'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
}

test('listagem: classe sem dispositivo disponível responde só o sequence (Tabela C.80)', async () => {
    const r = await list('classe-vazia', STAND_ALONE);
    assert.equal(r.status, 200);
    assert.equal(r.apiVersion, '100.0');
    assert.deepEqual(r.json, { sequence: 0 });
});

test('listagem: só os conectados, com deviceId distinto do handle, supportedTypes e paired', async () => {
    const idle = await registerIn('lista-a');
    const active = await registerIn('lista-a');
    await open(active.url);
    await waitFor(() => isConnected(active.handle));

    const r = await list('lista-a', STAND_ALONE);
    assert.equal(r.status, 200);
    assert.equal(r.json.sequence, registries.getSequence('lista-a'));
    assert.equal(r.json.devices.length, 1);
    const [item] = r.json.devices;
    assert.deepEqual(Object.keys(item).sort(), ['deviceId', 'paired', 'supportedTypes', 'url']);
    assert.equal(item.deviceId, registries.getRegistryByHandle(active.handle).deviceId);
    assert.notEqual(item.deviceId, active.handle);
    assert.notEqual(item.deviceId, idle.handle);
    assert.deepEqual(item.supportedTypes, ['application/x-ncl360']);
    assert.equal(item.paired, false);
});

test('listagem: url local estável por cliente, distinta entre clientes, ws:// na porta local', async () => {
    const reg = await registerIn('lista-b');
    await open(reg.url);
    await waitFor(() => isConnected(reg.handle));

    const first = (await list('lista-b', STAND_ALONE)).json.devices[0].url;
    const again = (await list('lista-b', STAND_ALONE)).json.devices[0].url;
    const other = (await list('lista-b', OTHER_STAND_ALONE)).json.devices[0].url;
    const associated = (await list('lista-b', ASSOCIATED)).json.devices[0].url;

    assert.equal(first, again);
    assert.notEqual(first, other);
    assert.notEqual(first, associated);
    assert.notEqual(other, associated);
    assert.match(first, /^ws:\/\/localhost:\d+\/rd\/[A-Za-z0-9_-]+$/);
    assert.notEqual(new URL(first).port, new URL(reg.url).port);
});

test('listagem: paired fica true com o par formado pela url listada', async () => {
    const reg = await registerIn('lista-c');
    await open(reg.url);
    await waitFor(() => isConnected(reg.handle));

    const url = (await list('lista-c', ASSOCIATED)).json.devices[0].url;
    await open(url);
    const registry = registries.getRegistryByHandle(reg.handle);
    await waitFor(() => registry.isPaired());

    const r = await list('lista-c', STAND_ALONE);
    assert.equal(r.json.devices[0].paired, true);
    assert.equal(r.json.sequence, registries.getSequence('lista-c'));
});

// Registers a listener of the remote-device event class and opens its
// WebSocket; returns the events it receives
async function listen(query = ''): Promise<unknown[]> {
    const res = await fetch(`${base}/v100.0/tv3/notifications/remote-device${query}`, { headers: STAND_ALONE });
    const reg = await res.json();
    assert.equal(res.status, 200, JSON.stringify(reg));
    const ws = await open(reg.url);
    return inbox(ws);
}

test('eventos remote-device: available, pairFormed, pairEnded e unavailable, em ordem (C.6.15.6)', async () => {
    const events = await listen();
    const reg = await registerIn('eventos-a');
    const device = await open(reg.url);
    await waitFor(() => isConnected(reg.handle));
    const listed = (await list('eventos-a', STAND_ALONE)).json;
    const deviceId = listed.devices[0].deviceId;

    const client = await open(listed.devices[0].url);
    await waitFor(() => events.length === 2);
    client.close();
    await waitFor(() => events.length === 3);
    device.close();
    await waitFor(() => events.length === 4);

    const first = listed.sequence;
    assert.deepEqual(events, [
        { eventType: 'available', classId: 'eventos-a', deviceId, sequence: first },
        { eventType: 'pairFormed', classId: 'eventos-a', deviceId, sequence: first + 1 },
        { eventType: 'pairEnded', classId: 'eventos-a', deviceId, sequence: first + 2 },
        { eventType: 'unavailable', classId: 'eventos-a', deviceId, sequence: first + 3 },
    ]);
    assert.equal(registries.getSequence('eventos-a'), first + 3);
});

test('eventos remote-device: filtro classId; recusa e transferência não geram evento', async () => {
    const filtered = await listen('?classId=eventos-b');
    const elsewhere = await listen('?classId=outra');
    const reg = await registerIn('eventos-b');
    await open(reg.url);
    await waitFor(() => filtered.length === 1);
    const registry = registries.getRegistryByHandle(reg.handle);

    await open(localUrlOf(registry, 'sa1', 'standAlone'));
    await waitFor(() => filtered.length === 2);
    const refused = await open(localUrlOf(registry, 'sa2', 'standAlone'));
    await closeCode(refused);
    const preempted = await open(localUrlOf(registry, 'sa1', 'standAlone'));
    await open(localUrlOf(registry, 'associated', 'associated'));
    await closeCode(preempted);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(filtered.map((e: any) => e.eventType), ['available', 'pairFormed']);
    assert.equal(elsewhere.length, 0);
});

// Projection of the registry in Redis (v100.0:remote-device:{handle})
const projected = (handle: string) => fake.store.get(`v100.0:remote-device:${handle}`) as Record<string, string> | undefined;

test('projeção no Redis: registro, conexão, par, queda e cancelamento, sem o token do ponto de entrada', async () => {
    const { handle, registry, device } = await connectedDevice();
    await waitFor(() => projected(handle)?.state === 'connected');
    assert.deepEqual(projected(handle), {
        deviceId: registry.deviceId,
        deviceClass: 'c',
        supportedTypes: '["t"]',
        state: 'connected',
        paired: 'false',
        disconnectedAt: String(registry.getDisconnectedAt()),
    });

    await open(localUrlOf(registry, 'sa', 'standAlone'));
    await waitFor(() => projected(handle)?.paired === 'true');

    device.close();
    await waitFor(() => projected(handle)?.state === 'registered');
    assert.equal(projected(handle)?.paired, 'false');
    assert.equal(projected(handle)?.disconnectedAt, String(registry.getDisconnectedAt()));

    const updated = await call('POST', v100(`/${handle}`), { deviceClass: 'd', supportedTypes: [] });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    await waitFor(() => projected(handle)?.deviceClass === 'd');
    assert.equal(projected(handle)?.supportedTypes, '[]');

    assert.equal((await call('DELETE', v100(`/${handle}`))).status, 200);
    await waitFor(() => projected(handle) === undefined);
});

test('projeção no Redis: recusa da função não muda a resposta da API; a gravação seguinte regrava tudo', async () => {
    fake.recusar('tv30_v100_remote_device_write', 'TV30ESQUEMA tv30_v100_remote_device_write: recusa de teste');
    try {
        const reg = await register();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(projected(reg.handle), undefined);
        fake.recusar('tv30_v100_remote_device_write');

        await open(reg.url);
        await waitFor(() => projected(reg.handle)?.state === 'connected');
        assert.equal(projected(reg.handle)?.deviceClass, 'c');
    } finally {
        fake.recusar('tv30_v100_remote_device_write');
    }
});

test('projeção no Redis: a partida limpa o que sobrou de outra execução', async () => {
    fake.store.set('v100.0:remote-device:3c8a7d2f-5e4b-4a9c-8d1e-2f3a4b5c6d7e', { deviceClass: 'antigo' });
    await startProjection();
    assert.equal(fake.store.has('v100.0:remote-device:3c8a7d2f-5e4b-4a9c-8d1e-2f3a4b5c6d7e'), false);
});
