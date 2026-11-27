// GET /tv3/current-service (ABNT NBR 25608, C.6.3.1, Table C.8) through the
// whole app.ts, with Redis and MQTT by doubles: the fields of the session the
// AoP writes; 300 without a service in use; "serviceId" and "serviceName"
// omitted for a service outside the catalog.
import { test, before, after } from 'node:test';

import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createFakeRedis } from './helpers/fake-redis';
import { createFakeMqtt, TOPICS } from './helpers/fake-mqtt';
import './helpers/v100-env';

const SVC = 'urn:tv30:service:teste';

const fake = createFakeRedis();
const mqtt = createFakeMqtt();
stub('redis-client', { default: fake.redis });
stub('mqtt-client', { default: mqtt.mqttClient, TOPICS, client: mqtt.client });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/app').default;

let server: Server;
let url = '';

before(async () => {
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3/current-service`;
});

after(() => new Promise<void>(resolve => server.close(() => resolve())));

test('sem servico em uso (sessao sem session:current-service): 404 {error:300} com API-Version', async () => {
    const r = await get();
    assert.equal(r.status, 404);
    assert.match(r.type, /application\/json/);
    assert.equal(r.json.error, 300, JSON.stringify(r.json));
    assert.match(r.json.description, /^No DTV service currently in use/);
    assert.equal(r.apiVersion, '2.0');
});

test('servico do catalogo: os tres campos da Tabela C.8, serviceId inteiro', async () => {
    selectService({ serviceName: 'Canal Teste', serviceId: '1001' });
    try {
        const r = await get();
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.apiVersion, '2.0');
        assert.deepEqual(r.json, { serviceContextId: SVC, serviceName: 'Canal Teste', serviceId: 1001 });
    } finally {
        clearSession();
    }
});

test('servico fora do catalogo: sem "serviceId" e sem "serviceName" (C.3.2.2)', async () => {
    selectService({});
    try {
        const r = await get();
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual(r.json, { serviceContextId: SVC });
    } finally {
        clearSession();
    }
});

test('o id decide: sem id, 300 mesmo com hash; hash de outro servico, so o serviceContextId', async () => {
    fake.store.set('session:current-service', { serviceContextId: 'urn:tv30:service:antigo', serviceName: 'Antigo', serviceId: '9' });
    fake.store.set('session:current-service-id', '');
    try {
        assert.equal((await get()).json.error, 300);
        fake.store.set('session:current-service-id', SVC);
        const r = await get();
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual(r.json, { serviceContextId: SVC });
    } finally {
        clearSession();
    }
});

test('version 100.0: the same fields of the session', async () => {
    selectService({ serviceName: 'Canal Teste', serviceId: '7' });
    try {
        const r = await get({ 'X-TV30-API-Version': '100.0' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.apiVersion, '100.0');
        assert.deepEqual(r.json, { serviceContextId: SVC, serviceName: 'Canal Teste', serviceId: 7 });
    } finally {
        clearSession();
    }
});

test('integerServiceId (Tabela C.8): inteiro >= 0, em numero ou texto so de digitos; o resto sem valor', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { integerServiceId } = require('../src/util/service-id');
    for (const [v, want] of [[101, 101], ['202', 202], ['007', 7], [0, 0], [-1, undefined], [1.5, undefined], ['abc', undefined], ['', undefined], [undefined, undefined], [null, undefined]] as [unknown, number | undefined][]) {
        assert.equal(integerServiceId(v), want, JSON.stringify(v));
    }
});

test('a plataforma desfaz a selecao (sessao limpa): volta o 300', async () => {
    selectService({});
    assert.equal((await get()).status, 200);
    clearSession();
    const r = await get();
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 300, JSON.stringify(r.json));
});

test('o tv3ws nao grava a sessao do servico: aop/currentService nao chega a nenhuma funcao', async () => {
    fake.fcalls.length = 0;
    await mqtt.deliver('aop/currentService', SVC);
    assert.deepEqual(fake.fcalls, []);
    assert.equal(fake.store.has('session:current-service'), false);
});

function stub(rel: string, exports: object): void {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}

async function get(headers: Record<string, string> = {}) {
    const res = await fetch(url, { headers });
    const text = await res.text();
    return { status: res.status, apiVersion: res.headers.get('api-version'), type: res.headers.get('content-type') ?? '', json: text ? JSON.parse(text) : undefined };
}

// The session as the AoP writes it (tv30_session_service).
function selectService(fields: Record<string, string>): void {
    fake.store.set('session:current-service', { serviceContextId: SVC, serviceName: '', serviceId: '', ...fields });
    fake.store.set('session:current-service-id', fields.serviceContextId ?? SVC);
}

function clearSession(): void {
    fake.store.delete('session:current-service');
    fake.store.set('session:current-service-id', '');
}
