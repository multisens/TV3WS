// API-Version (C.3.6.6) on every response, errors included, through the
// whole app.ts (Redis and MQTT by doubles). The version comes in
// X-TV30-API-Version; Accept-Version is not interpreted here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createFakeRedis } from './helpers/fake-redis';
import { createFakeMqtt, TOPICS } from './helpers/fake-mqtt';

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/app').default;

let server: Server;
let base = '';
before(async () => {
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function call(route: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${route}`, init);
    const text = await res.text();
    return { status: res.status, apiVersion: res.headers.get('api-version'), json: text ? JSON.parse(text) : undefined };
}
function expectError(r: Awaited<ReturnType<typeof call>>, code: number, apiVersion: string) {
    assert.equal(r.status, 404);
    assert.equal(r.json?.error, code, JSON.stringify(r.json));
    assert.equal(r.apiVersion, apiVersion, `API-Version do erro ${code}`);
}
const decided = (v: string) => ({ headers: { 'X-TV30-API-Version': v } });

test('a versao vem da borda (X-TV30-API-Version) e volta no API-Version, tambem nos erros', async () => {
    // No service in use.
    expectError(await call('/tv3/current-service', decided('2.0')), 300, '2.0');
    expectError(await call('/tv3/current-service', decided('100.0')), 300, '100.0');
    expectError(await call('/tv3/rota-que-nao-existe', decided('100.0')), 100, '100.0');
});

test('sem o cabecalho interno (fora da borda): vale a 2.0 (C.3.6.5); valor fora de X.Y tambem', async () => {
    expectError(await call('/tv3/current-service'), 300, '2.0');
    expectError(await call('/tv3/current-service', decided('x')), 300, '2.0');
});

test('o Accept-Version do cliente nao e interpretado aqui: nem 100 nem 101 do tv3ws', async () => {
    for (const v of ['3.0', '2.1', 'x', '100.0']) {
        const r = await call('/tv3/current-service', { headers: { 'Accept-Version': v } });
        expectError(r, 300, '2.0');
    }
});

test('JSON malformado no corpo (101 do errorHandler) tambem leva API-Version', async () => {
    const init = (v?: string): RequestInit => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(v ? { 'X-TV30-API-Version': v } : {}) },
        body: '{"deviceClass": ',
    });
    expectError(await call('/tv3/remote-device', init()), 101, '2.0');
    expectError(await call('/tv3/remote-device', init('100.0')), 101, '100.0');
});

test('extensao do testbed no caminho /v100.0: rota sem tratador da 100.0 da 100, com API-Version 100.0', async () => {
    expectError(await call('/v100.0/tv3/rota-que-nao-existe', decided('100.0')), 100, '100.0');
    expectError(await call('/v100.0/tv3/remote-device/device/x', decided('100.0')), 100, '100.0');
    // There are no routes by handle on the public path either.
    expectError(await call('/tv3/remote-device/device/x', decided('100.0')), 100, '100.0');
});

test('resposta de sucesso: API-Version = a versao negociada pela borda', async () => {
    await mqtt.deliver(TOPICS.current_service, 'urn:tv30:service:teste');
    const r = await call('/tv3/current-service', decided('100.0'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.apiVersion, '100.0');
    assert.equal((await call('/tv3/current-service')).apiVersion, '2.0');
});
