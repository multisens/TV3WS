// Cabecalho API-Version (C.3.6.6) nas respostas do tv3ws, pelo app.ts
// inteiro (core real; redis-client e mqtt-client trocados por dubles). Rodada
// de 10/10: toda resposta, inclusive erro, leva API-Version — antes os erros
// 100 e 101 da negociacao (middleware/basic.ts) e o 101 de JSON malformado
// saiam sem ele. No 100, a versao mais recente suportada (2.1).
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
const accept = (v: string) => ({ headers: { 'Accept-Version': v } });

test('versao fora do conjunto: 100 com API-Version = a mais recente suportada (2.1)', async () => {
    for (const v of ['3.0', '1.9', '2.2', '2.10']) {
        const r = await call('/tv3/current-service', accept(v));
        expectError(r, 100, '2.1');
        assert.match(r.json.description, /unsupported version/);
    }
});

test('Accept-Version malformado: 101 com API-Version 2.0 (a da norma, como sem o cabecalho)', async () => {
    for (const v of ['x', '2', '2.0.1', 'v2.0']) {
        expectError(await call('/tv3/current-service', accept(v)), 101, '2.0');
    }
    // dois cabecalhos: o node junta com ", " e o valor fica malformado
    const h = new Headers();
    h.append('Accept-Version', '2.0');
    h.append('Accept-Version', '2.1');
    expectError(await call('/tv3/current-service', { headers: h }), 101, '2.0');
});

test('versao suportada ou ausente: a negociada, tambem nos erros das APIs', async () => {
    expectError(await call('/tv3/rota-que-nao-existe'), 100, '2.0');
    expectError(await call('/tv3/rota-que-nao-existe', accept('2.1')), 100, '2.1');
    expectError(await call('/tv3/current-service', accept('2.0')), 300, '2.0');   // sem servico em uso
});

test('JSON malformado no corpo (101 do errorHandler) tambem leva API-Version', async () => {
    const init = (v?: string): RequestInit => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(v ? { 'Accept-Version': v } : {}) },
        body: '{"deviceClass": ',
    });
    expectError(await call('/tv3/remote-device', init()), 101, '2.0');
    expectError(await call('/tv3/remote-device', init('2.1')), 101, '2.1');
    // versao invalida vem antes do corpo
    expectError(await call('/tv3/remote-device', init('3.0')), 100, '2.1');
});

test('resposta de sucesso: API-Version negociada', async () => {
    await mqtt.deliver(TOPICS.current_service, 'urn:tv30:service:teste');
    const r = await call('/tv3/current-service', accept('2.1'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.apiVersion, '2.1');
    assert.equal((await call('/tv3/current-service')).apiVersion, '2.0');
});
