// Registration and removal of a remote device (C.6.15.2, C.6.15.3) with
// Redis, core and MQTT by doubles. With Redis down, 404 {error:200} with no
// port open and no half registration; deregistration closes the ports; a
// drawn port in use draws another. Scheme of the entry points: wss:// for
// the remote device, with the receiver certificate; ws:// for the local one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import net, { AddressInfo } from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { Server } from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import { createFakeRedis } from './helpers/fake-redis';

// Registration on ws:// here, whatever the certificate of the machine (the
// TLS test turns it on).
process.env.TV3WS_WS_TLS = 'false';

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
        addTopicHandler() { /* nothing */ },
        removeTopicHandler() { /* nothing */ },
        parseTopic(t: string) { return t; },
    },
    TOPICS: { devices: 'aop/devices', app_doc: 'aop/:serviceId/:appId/doc' },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: remoteDeviceAPI, routerV100: remoteDeviceV100API } = require('../src/api/remote-device');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const basic = require('../src/middleware/basic').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manager = require('../src/modules/remotedevice-manager/manager') as typeof import('../src/modules/remotedevice-manager/manager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LISTEN_ATTEMPTS } = require('../src/modules/remotedevice-manager/entry-point') as typeof import('../src/modules/remotedevice-manager/entry-point');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { apiNotFound, errorHandler } = require('../src/util') as typeof import('../src/util');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tls = require('../src/tls') as typeof import('../src/tls');

// A free port, listening as the entry point (no host: every interface), so
// that EADDRINUSE happens the same way on Windows and Linux.
async function occupy(port = 0): Promise<net.Server> {
    const s = net.createServer();
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, () => resolve()); });
    return s;
}
const portOf = (s: net.Server) => (s.address() as AddressInfo).port;
const release = (s: net.Server) => new Promise<void>(r => s.close(() => r()));
async function freePort(): Promise<number> {
    const s = await occupy();
    const p = portOf(s);
    await release(s);
    return p;
}
// Two free consecutive ports (P, P+1), for the draw test.
async function freePortPair(): Promise<number> {
    for (let i = 0; i < 20; i++) {
        const p = await freePort();
        // P+1 in use: try another.
        try { await release(await occupy(p + 1)); return p; } catch { }
    }
    throw new Error('sem par de portas livres');
}
function listening(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const c = net.connect(port, '127.0.0.1');
        c.once('connect', () => { c.destroy(); resolve(true); });
        c.once('error', () => resolve(false));
    });
}
// Range of the draw (WS_PORT_MIN..WS_PORT_MAX, read on every opening).
function portRange(min: number, max = min): void {
    process.env.WS_PORT_MIN = String(min);
    process.env.WS_PORT_MAX = String(max);
}
const portOfUrl = (url: string) => Number(new URL(url).port);

let server: Server;
let root = '';
let wsPort = 0;
before(async () => {
    wsPort = await freePort();
    portRange(wsPort);
    // The mounting of app.ts: 100.0 arrives from the edge with the /v100.0
    // prefix.
    const app = express();
    app.use(express.json());
    app.use('/tv3', basic);
    app.use('/v100.0/tv3', basic);
    app.use('/tv3/remote-device', remoteDeviceAPI);
    app.use('/v100.0/tv3/remote-device', remoteDeviceV100API);
    app.use('/tv3', apiNotFound);
    app.use('/v100.0/tv3', apiNotFound);
    app.use(errorHandler);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

const BASE = '/tv3/remote-device';
const BASE_V100 = '/v100.0/tv3/remote-device';
async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}, base = BASE) {
    const res = await fetch(`${root}${base}${route}`, {
        method,
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
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
// As the edge passes 100.0 on: path /v100.0 and the negotiated version in
// the header.
const V100 = { 'X-TV30-API-Version': '100.0' };
const call100 = (method: string, route: string) => call(method, route, undefined, V100, BASE_V100);

test('Redis fora do ar no registro: 404 {error:200}, sem porta aberta, sem registro nem publicacao', async () => {
    portRange(wsPort);
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

test('registro com Redis normal; remocao que falha mantem o dispositivo; depois remove e a porta deixa de escutar', async () => {
    portRange(wsPort);
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
    assert.equal(await listening(wsPort), true, 'remocao que falhou nao fecha a porta');

    const d = await call('DELETE', `/${handle}`);
    assert.equal(d.status, 204);
    assert.equal(manager.getDeviceByHandle(handle), undefined);
    assert.equal(store.has(`remote-device:${handle}`), false);
    assert.deepEqual(published[published.length - 1], ['aop/devices/teste', '']);
    assert.equal(await listening(wsPort), false, 'a porta do dispositivo removido nao fica escutando');
    expectError(await call('DELETE', `/${handle}`), 101);
});

test('EADDRINUSE na porta sorteada: sorteia outra, sem derrubar o processo', async (t) => {
    const p = await freePortPair();
    const busy = await occupy(p);
    try {
        // Draw in [P, P+2): P or P+1.
        portRange(p, p + 2);
        let calls = 0;
        // The first draw falls on the port in use (P), the next ones on P+1.
        t.mock.method(Math, 'random', () => (calls++ === 0 ? 0 : 0.99));
        const r = await call('POST', '/', BODY);
        t.mock.restoreAll();
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.url, `ws://localhost:${p + 1}`);
        assert.ok(calls >= 2, `esperado novo sorteio depois do EADDRINUSE (sorteios: ${calls})`);
        assert.equal((store.get(`remote-device:${r.json.handle}`) as Record<string, string>).url, `ws://localhost:${p + 1}`);
        assert.equal(await listening(p + 1), true);

        assert.equal((await call('DELETE', `/${r.json.handle}`)).status, 204);
        assert.equal(await listening(p + 1), false);
    } finally {
        await release(busy);
    }
});

test(`todas as ${LISTEN_ATTEMPTS} tentativas em porta ocupada: 404 {error:200}, nada registrado, processo vivo`, async () => {
    const busy = await occupy();
    const p = portOf(busy);
    try {
        portRange(p);
        const before = published.length;
        const devicesBefore = manager.getDevicesByClass('teste').length;
        expectError(await call('POST', '/', BODY), 200);
        assert.equal(manager.getDevicesByClass('teste').length, devicesBefore);
        assert.equal(published.length, before);
    } finally {
        await release(busy);
    }
    // The process stayed up: the next registration on a free port works.
    portRange(wsPort);
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await call('DELETE', `/${r.json.handle}`)).status, 204);
    assert.equal(await listening(wsPort), false);
});

test('ponto de entrada local: a listagem 2.0 abre; o descadastro fecha as duas portas', async () => {
    const devPort = await freePort();
    const localPort = await freePort();
    portRange(devPort);
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const handle: string = r.json.handle;

    portRange(localPort);
    const list = await call('GET', '/devices/teste');
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const mine = list.json.devices.find((d: { handle: string }) => d.handle === handle);
    assert.equal(mine.url, `ws://localhost:${localPort}`);
    assert.equal(await listening(localPort), true);
    // A repeated listing reuses the same entry point.
    const again = await call('GET', '/devices/teste');
    assert.equal(again.json.devices.find((d: { handle: string }) => d.handle === handle).url, mine.url);

    assert.equal((await call('DELETE', `/${handle}`)).status, 204);
    assert.equal(await listening(devPort), false, 'porta do dispositivo');
    assert.equal(await listening(localPort), false, 'porta do ponto de entrada local');
});

test('100.0: DELETE /device/{handle} fecha a porta local e a ativacao seguinte abre outra', async () => {
    const devPort = await freePort();
    const localPort = await freePort();
    portRange(devPort);
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const handle: string = r.json.handle;

    portRange(localPort);
    const ep = await call100('GET', `/device/${handle}`);
    assert.equal(ep.status, 200, JSON.stringify(ep.json));
    assert.equal(portOfUrl(ep.json.url), localPort);
    assert.equal(await listening(localPort), true);

    assert.equal((await call100('DELETE', `/device/${handle}`)).status, 204);
    assert.equal(await listening(localPort), false, 'porta local fechada pelo DELETE /device/{handle}');
    assert.equal(await listening(devPort), true, 'o dispositivo continua registrado');

    const nextPort = await freePort();
    portRange(nextPort);
    const ep2 = await call100('GET', `/device/${handle}`);
    assert.equal(ep2.status, 200, JSON.stringify(ep2.json));
    assert.equal(portOfUrl(ep2.json.url), nextPort, 'nova ativacao nao devolve o endereco fechado');
    assert.equal(await listening(nextPort), true);

    assert.equal((await call('DELETE', `/${handle}`)).status, 204);
    assert.equal(await listening(devPort), false);
    assert.equal(await listening(nextPort), false);
});

test('100.0: pedidos simultaneos de ativacao abrem um ponto de entrada so', async () => {
    const devPort = await freePort();
    portRange(devPort);
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const handle: string = r.json.handle;

    const p = await freePortPair();
    // Without the lock, the second request would open the other port.
    portRange(p, p + 2);
    const [a, b] = await Promise.all([
        call100('GET', `/device/${handle}`),
        call100('GET', `/device/${handle}`),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(a.json.url, b.json.url);
    const other = portOfUrl(a.json.url) === p ? p + 1 : p;
    assert.equal(await listening(other), false, 'nenhum segundo servidor escutando');

    assert.equal((await call('DELETE', `/${handle}`)).status, 204);
    assert.equal(await listening(portOfUrl(a.json.url)), false);
});

test('a rota escolhe o codigo, nao o X-TV30-API-Version: /v100.0 lista so handles, /tv3 lista com url', async () => {
    const devPort = await freePort();
    const localPort = await freePort();
    portRange(devPort);
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const handle: string = r.json.handle;
    portRange(localPort);

    // /v100.0 without the header: the code of 100.0, without opening an entry
    // point.
    const handles = await call('GET', '/devices/teste', undefined, {}, BASE_V100);
    assert.equal(handles.status, 200, JSON.stringify(handles.json));
    assert.deepEqual(handles.json.devices.find((d: { handle: string }) => d.handle === handle), { handle, supportedTypes: ['light'] });
    assert.equal(await listening(localPort), false);

    // Public path with the header of 100.0: the code of 2.0 (C.6.15.5, with
    // url).
    const withUrl = await call('GET', '/devices/teste', undefined, V100);
    assert.equal(withUrl.status, 200, JSON.stringify(withUrl.json));
    assert.equal(withUrl.json.devices.find((d: { handle: string }) => d.handle === handle).url, `ws://localhost:${localPort}`);

    // The routes by handle exist only under /v100.0.
    for (const m of ['GET', 'DELETE']) expectError(await call(m, `/device/${handle}`, undefined, V100), 100);
    expectError(await call100('GET', '/device/nao-existe'), 101);

    assert.equal((await call('DELETE', `/${handle}`)).status, 204);
    assert.equal(await listening(localPort), false);
});

// Self-signed certificate like the one of tls-init
// (infra/edgegateway/tls-init.sh); without openssl, undefined.
function selfSignedCert(): string | undefined {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv30-ws-tls-'));
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'),
            '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
        return dir;
    } catch {
        fs.rmSync(dir, { recursive: true, force: true });
        return undefined;
    }
}
function connects(url: string, ca?: Buffer): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, ca ? { ca } : {});
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}
const closed = (ws: WebSocket) => new Promise<void>(resolve => {
    if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.once('close', () => resolve());
});

test('com o certificado do receptor: registro em wss:// (C.6.15.2); ponto de entrada local em ws:// (C.6.15.5 e 100.0)', async (t) => {
    const dir = selfSignedCert();
    if (!dir) { t.skip('openssl indisponivel para gerar o certificado de teste'); return; }
    const saved = { dir: process.env.TV30_TLS_DIR, flag: process.env.TV3WS_WS_TLS };
    process.env.TV30_TLS_DIR = dir;
    delete process.env.TV3WS_WS_TLS;
    tls._resetTlsCache();
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    try {
        const devPort = await freePort();
        portRange(devPort);
        const r = await call('POST', '/', BODY);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const handle: string = r.json.handle;
        assert.equal(r.json.url, `wss://localhost:${devPort}`);

        const localPort = await freePort();
        portRange(localPort);
        const list = await call('GET', '/devices/teste');
        assert.equal(list.json.devices.find((d: { handle: string }) => d.handle === handle).url, `ws://localhost:${localPort}`);
        (await connects(`ws://localhost:${localPort}`)).close();

        assert.equal((await call100('DELETE', `/device/${handle}`)).status, 204);
        const nextPort = await freePort();
        portRange(nextPort);
        const ep = await call100('GET', `/device/${handle}`);
        assert.equal(ep.json.url, `ws://localhost:${nextPort}`);
        (await connects(ep.json.url)).close();

        // The device that trusts the serverCert connects to the wss:// of the
        // registration.
        const device = await connects(r.json.url, cert);
        assert.equal((await call('DELETE', `/${handle}`)).status, 204);
        await closed(device);

        // TV3WS_WS_TLS=false applies only to the entry point of the remote
        // device.
        process.env.TV3WS_WS_TLS = 'false';
        portRange(devPort);
        const plain = await call('POST', '/', BODY);
        assert.equal(plain.json.url, `ws://localhost:${devPort}`);
        assert.equal((await call('DELETE', `/${plain.json.handle}`)).status, 204);
    } finally {
        if (saved.dir === undefined) delete process.env.TV30_TLS_DIR; else process.env.TV30_TLS_DIR = saved.dir;
        process.env.TV3WS_WS_TLS = saved.flag ?? 'false';
        tls._resetTlsCache();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

after(async () => {
    // Devices left by a failed test: deregistration closes the ports and the
    // process can exit.
    for (const d of manager.getDevicesByClass('teste')) await manager.removeRemoteDevice(d.getHandle());
});
