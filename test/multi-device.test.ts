// Registro e remocao de remote-device (C.6.15.2, C.6.15.3) com redis-client,
// core e mqtt-client trocados por dubles. D-0510-6 (reuniao 05/10 com o
// Joel): o espelho no Redis deixou de ser promessa solta — com o Redis fora
// do ar a API responde 404 {error:200}, nao abre porta e nao deixa registro
// pela metade; a remocao que falha mantem o dispositivo.
// Rodada de 10/10: o descadastro fecha tambem o http.Server dos pontos de
// entrada (a porta deixa de escutar), e porta sorteada ocupada (EADDRINUSE)
// nao derruba o processo — sorteia outra ou responde 404 {error:200}.
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
const basic = require('../src/middleware/basic').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manager = require('../src/modules/remotedevice-manager/manager') as typeof import('../src/modules/remotedevice-manager/manager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LISTEN_ATTEMPTS } = require('../src/modules/remotedevice-manager/entry-point') as typeof import('../src/modules/remotedevice-manager/entry-point');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/util') as typeof import('../src/util');

// porta livre, escutando como o ponto de entrada (sem host: todas as
// interfaces), para o EADDRINUSE acontecer igual no Windows e no Linux
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
// duas portas livres e consecutivas (P, P+1), para o teste do sorteio
async function freePortPair(): Promise<number> {
    for (let i = 0; i < 20; i++) {
        const p = await freePort();
        try { await release(await occupy(p + 1)); return p; } catch { /* P+1 ocupada: outra */ }
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
// faixa do sorteio (WS_PORT_MIN..WS_PORT_MAX, lida a cada abertura)
function portRange(min: number, max = min): void {
    process.env.WS_PORT_MIN = String(min);
    process.env.WS_PORT_MAX = String(max);
}
const portOfUrl = (url: string) => Number(new URL(url).port);

let server: Server;
let base = '';
let wsPort = 0;
before(async () => {
    wsPort = await freePort();
    portRange(wsPort);
    const app = express();
    app.use(express.json());
    app.use('/tv3', basic);   // res.locals.apiVersion (rotas por handle so na 2.1)
    app.use('/tv3/remote-device', multiDeviceAPI);
    app.use(errorHandler);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3/remote-device`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${route}`, {
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
const V21 = { 'Accept-Version': '2.1' };

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
    // antes de 10/10 o terminate() fechava so o WebSocketServer e o
    // http.Server externo seguia escutando
    assert.equal(await listening(wsPort), false, 'a porta do dispositivo removido nao fica escutando');
    expectError(await call('DELETE', `/${handle}`), 101);
});

test('EADDRINUSE na porta sorteada: sorteia outra, sem derrubar o processo', async (t) => {
    const p = await freePortPair();
    const busy = await occupy(p);
    try {
        portRange(p, p + 2);   // sorteio em [P, P+2): P ou P+1
        let calls = 0;
        // 1o sorteio cai na porta ocupada (P), os seguintes em P+1
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
    // o processo seguiu de pe: o proximo registro numa porta livre funciona
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
    // listagem repetida reusa o mesmo ponto de entrada
    const again = await call('GET', '/devices/teste');
    assert.equal(again.json.devices.find((d: { handle: string }) => d.handle === handle).url, mine.url);

    assert.equal((await call('DELETE', `/${handle}`)).status, 204);
    assert.equal(await listening(devPort), false, 'porta do dispositivo');
    assert.equal(await listening(localPort), false, 'porta do ponto de entrada local');
});

test('2.1: DELETE /device/{handle} fecha a porta local e a ativacao seguinte abre outra', async () => {
    const devPort = await freePort();
    const localPort = await freePort();
    portRange(devPort);
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const handle: string = r.json.handle;

    portRange(localPort);
    const ep = await call('GET', `/device/${handle}`, undefined, V21);
    assert.equal(ep.status, 200, JSON.stringify(ep.json));
    assert.equal(portOfUrl(ep.json.url), localPort);
    assert.equal(await listening(localPort), true);

    assert.equal((await call('DELETE', `/device/${handle}`, undefined, V21)).status, 204);
    assert.equal(await listening(localPort), false, 'porta local fechada pela C.6.15.7');
    assert.equal(await listening(devPort), true, 'o dispositivo continua registrado');

    const nextPort = await freePort();
    portRange(nextPort);
    const ep2 = await call('GET', `/device/${handle}`, undefined, V21);
    assert.equal(ep2.status, 200, JSON.stringify(ep2.json));
    assert.equal(portOfUrl(ep2.json.url), nextPort, 'nova ativacao nao devolve o endereco fechado');
    assert.equal(await listening(nextPort), true);

    assert.equal((await call('DELETE', `/${handle}`)).status, 204);
    assert.equal(await listening(devPort), false);
    assert.equal(await listening(nextPort), false);
});

test('2.1: pedidos simultaneos de ativacao abrem um ponto de entrada so', async () => {
    const devPort = await freePort();
    portRange(devPort);
    const r = await call('POST', '/', BODY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const handle: string = r.json.handle;

    const p = await freePortPair();
    portRange(p, p + 2);   // sem trava, o segundo pedido abriria a outra porta
    const [a, b] = await Promise.all([
        call('GET', `/device/${handle}`, undefined, V21),
        call('GET', `/device/${handle}`, undefined, V21),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(a.json.url, b.json.url);
    const other = portOfUrl(a.json.url) === p ? p + 1 : p;
    assert.equal(await listening(other), false, 'nenhum segundo servidor escutando');

    assert.equal((await call('DELETE', `/${handle}`)).status, 204);
    assert.equal(await listening(portOfUrl(a.json.url)), false);
});

after(async () => {
    // dispositivos que sobrarem de um teste que falhou: o descadastro fecha
    // as portas e o processo pode sair
    for (const d of manager.getDevicesByClass('teste')) await manager.removeRemoteDevice(d.getHandle());
});
