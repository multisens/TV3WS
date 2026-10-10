// GET /tv3/current-service (C.6.3.1, Tabela C.8) pelo app.ts inteiro, com o
// core REAL (servico em uso vindo de aop/currentService) e redis-client e
// mqtt-client trocados por dubles. Rodada de 10/10 (item 24): "serviceId"
// inteiro (antes saia em texto: "-1", "undefined") e erro 300 quando nao ha
// servico em uso.
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
let url = '';
before(async () => {
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3/current-service`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function get(headers: Record<string, string> = {}) {
    const res = await fetch(url, { headers });
    const text = await res.text();
    return { status: res.status, apiVersion: res.headers.get('api-version'), type: res.headers.get('content-type') ?? '', json: text ? JSON.parse(text) : undefined };
}
const SVC = 'urn:tv30:service:teste';

test('sem servico em uso (aop/currentService nunca recebido): 404 {error:300} com API-Version', async () => {
    const r = await get();
    assert.equal(r.status, 404);
    assert.match(r.type, /application\/json/);
    assert.equal(r.json.error, 300, JSON.stringify(r.json));
    assert.match(r.json.description, /^No DTV service currently in use/);
    assert.equal(r.apiVersion, '2.0');
});

test('servico em uso sem @serviceId conhecido: 200, sem "serviceId" (nem "-1"/"undefined" em texto)', async () => {
    await mqtt.deliver(TOPICS.current_service, SVC);
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.apiVersion, '2.0');
    assert.equal(typeof r.json.serviceContextId, 'string');
    assert.ok(!('serviceId' in r.json), JSON.stringify(r.json));
    assert.ok(!('serviceName' in r.json), 'nome vazio e omitido (C.3.2.2)');
});

test('"serviceId" inteiro quando aop/services traz o @serviceId', async () => {
    // core.ts indexa aop/services pelo valor numerico de aop/currentService
    await mqtt.deliver(TOPICS.current_service, '');
    await mqtt.deliver(TOPICS.services, JSON.stringify([
        { serviceId: 101, serviceName: 'Servico Zero', serviceIcon: '', initialMediaURL: '' },
        { serviceId: '202', serviceName: 'Servico Um', serviceIcon: '', initialMediaURL: '' },
    ]));
    await mqtt.deliver(TOPICS.current_service, '0');
    let r = await get({ 'Accept-Version': '2.1' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.apiVersion, '2.1');
    assert.equal(r.json.serviceId, 101);
    assert.equal(typeof r.json.serviceId, 'number');
    assert.equal(r.json.serviceName, 'Servico Zero');

    // em texto so de digitos no JSON publicado -> numero na resposta
    await mqtt.deliver(TOPICS.current_service, '1');
    r = await get();
    assert.equal(r.json.serviceId, 202);
    assert.equal(typeof r.json.serviceId, 'number');
});

test('a plataforma desfaz a selecao (aop/currentService vazio): volta o 300', async () => {
    await mqtt.deliver(TOPICS.current_service, SVC);
    assert.equal((await get()).status, 200);
    await mqtt.deliver(TOPICS.current_service, '');
    const r = await get();
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 300, JSON.stringify(r.json));
});
