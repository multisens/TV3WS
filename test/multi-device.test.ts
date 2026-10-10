// Registro e remocao de remote-device (C.6.15.2, C.6.15.3) com redis-client,
// core e mqtt-client trocados por dubles. D-0510-6 (reuniao 05/10 com o
// Joel): o espelho no Redis deixou de ser promessa solta — com o Redis fora
// do ar a API responde 404 {error:200}, nao abre porta e nao deixa registro
// pela metade; a remocao que falha mantem o dispositivo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import net, { AddressInfo } from 'net';
import path from 'path';
import { Server } from 'http';
import express from 'express';
import { createFakeRedis } from './helpers/fake-redis';

const fake = createFakeRedis();
const store = fake.store;
const published: [string, string][] = [];

function stub(rel: string, exports: object): void {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
const fakeCore = { app: { sid: '', id: '', url: '', nodes: [] }, server: { url: 'localhost' } };
stub('redis-client', { default: fake.redis });
stub('core', { default: fakeCore });
stub('mqtt-client', {
    default: {
        publish(t: string, m: string) { published.push([t, m]); },
        addTopicHandler() { /* nada */ },
        removeTopicHandler() { /* nada */ },
        parseTopic(t: string) { return t; },
    },
    TOPICS: { devices: 'aop/devices', app_doc: 'aop/:serviceId/:appId/doc' },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const multiDeviceAPI = require('../src/api/multi-device').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manager = require('../src/modules/remotedevice-manager/manager') as typeof import('../src/modules/remotedevice-manager/manager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/util') as typeof import('../src/util');

// porta fixa e livre para o WebSocket do dispositivo (WS_PORT_MIN = MAX)
async function freePort(): Promise<number> {
    const s = net.createServer().listen(0, '127.0.0.1');
    await new Promise(r => s.once('listening', r));
    const p = (s.address() as AddressInfo).port;
    await new Promise(r => s.close(r));
    return p;
}
function listening(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const c = net.connect(port, '127.0.0.1');
        c.once('connect', () => { c.destroy(); resolve(true); });
        c.once('error', () => resolve(false));
    });
}
// o servidor HTTP de cada dispositivo nao e fechado pelo terminate() (ws so
// fecha servidor proprio); o teste fecha para o processo poder sair
function closeDeviceServer(handle: string): Promise<void> {
    const dev = manager.getDeviceByHandle(handle) as any;
    const srv = dev?.wss?.options?.server;
    return new Promise(r => (srv?.listening ? srv.close(() => r()) : r()));
}

let server: Server;
let base = '';
let wsPort = 0;
before(async () => {
    wsPort = await freePort();
    process.env.WS_PORT_MIN = String(wsPort);
    process.env.WS_PORT_MAX = String(wsPort);
    const app = express();
    app.use(express.json());
    app.use('/tv3/remote-device', multiDeviceAPI);
    app.use(errorHandler);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3/remote-device`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function call(method: string, route: string, body?: unknown) {
    const res = await fetch(`${base}${route}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
}
const expectError = (r: { status: number; json: any }, code: number) => {
    assert.equal(r.status, 404);
    assert.equal(r.json?.error, code, JSON.stringify(r.json));
};
const BODY = { deviceClass: 'teste', supportedTypes: ['light'] };

test('Redis fora do ar no registro: 404 {error:200}, sem porta aberta, sem registro nem publicacao', async () => {
    const before = published.length;
    fake.setDown(true);
    try {
        expectError(await call('POST', '/', BODY), 200);
    } finally { fake.setDown(false); }
    assert.equal(await listening(wsPort), false, 'porta do WebSocket nao deve ficar aberta');
    assert.equal(manager.getDevicesByClass('teste').length, 0);
    assert.equal(store.has('remote-devices:index'), false);
    assert.equal(published.length, before);
});

test('registro com Redis normal; remocao que falha mantem o dispositivo; depois remove', async () => {
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const handle: string = r.json.handle;
    assert.equal(r.json.url, `ws://localhost:${wsPort}`);
    assert.equal(await listening(wsPort), true);
    assert.ok((store.get('remote-devices:index') as Set<string>).has(handle));
    assert.equal((store.get(`remote-device:${handle}`) as Record<string, string>).deviceClass, 'teste');

    fake.setDown(true);
    try {
        expectError(await call('DELETE', `/${handle}`), 200);
    } finally { fake.setDown(false); }
    assert.ok(manager.getDeviceByHandle(handle), 'dispositivo continua registrado');
    assert.ok((store.get('remote-devices:index') as Set<string>).has(handle));

    const dev = manager.getDeviceByHandle(handle);
    const d = await call('DELETE', `/${handle}`);
    assert.equal(d.status, 204);
    assert.equal(manager.getDeviceByHandle(handle), undefined);
    assert.equal(store.has(`remote-device:${handle}`), false);
    assert.deepEqual(published[published.length - 1], ['aop/devices/teste', '']);
    // fecha o servidor HTTP que ficou do dispositivo removido
    const srv = (dev as any)?.wss?.options?.server;
    if (srv?.listening) await new Promise(res => srv.close(res));
    expectError(await call('DELETE', `/${handle}`), 101);
});

after(async () => {
    for (const d of manager.getDevicesByClass('teste')) await closeDeviceServer(d.getHandle());
});
