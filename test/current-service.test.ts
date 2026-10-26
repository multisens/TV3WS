// GET /tv3/current-service (C.6.3.1, Table C.8) through the whole app.ts,
// with the real core and Redis and MQTT by doubles: 300 when there is no
// service in use, "serviceId" omitted without an SLT, and aop/services
// consumed.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/core').default;

test('aop/services: a lista dos servicos anunciados pelo serviceContextId; o servico em uso segue sem "serviceId" e "serviceName"', async () => {
    await mqtt.deliver(TOPICS.current_service, '');
    await mqtt.deliver(TOPICS.services, JSON.stringify([{ serviceContextId: SVC }, { serviceContextId: 'urn:tv30:service:outro' }]));
    assert.deepEqual(core.services, [{ serviceContextId: SVC }, { serviceContextId: 'urn:tv30:service:outro' }]);
    await mqtt.deliver(TOPICS.current_service, SVC);
    const r = await get({ 'X-TV30-API-Version': '100.0' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.apiVersion, '100.0');
    assert.equal(r.json.serviceContextId, SVC);
    assert.ok(!('serviceId' in r.json) && !('serviceName' in r.json), JSON.stringify(r.json));

    // Empty message (retained deleted): no service; an item out of format is
    // left out.
    await mqtt.deliver(TOPICS.services, '');
    assert.deepEqual(core.services, []);
    await mqtt.deliver(TOPICS.services, JSON.stringify([{ serviceContextId: SVC }, { serviceId: 7 }, 'x', null]));
    assert.deepEqual(core.services, [{ serviceContextId: SVC }]);
    // Invalid JSON: logs and keeps the list.
    const [errorOrig, logOrig] = [console.error, console.log];
    console.error = console.log = () => undefined;
    try {
        await mqtt.deliver(TOPICS.services, 'nao e json');
    } finally { [console.error, console.log] = [errorOrig, logOrig]; }
    assert.deepEqual(core.services, [{ serviceContextId: SVC }]);
    await mqtt.deliver(TOPICS.current_service, '');
});

test('integerServiceId (Tabela C.8): inteiro >= 0, em numero ou texto so de digitos; o resto sem valor', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { integerServiceId } = require('../src/util/service-id');
    for (const [v, want] of [[101, 101], ['202', 202], ['007', 7], [0, 0], [-1, undefined], [1.5, undefined], ['abc', undefined], ['', undefined], [undefined, undefined], [null, undefined]] as [unknown, number | undefined][]) {
        assert.equal(integerServiceId(v), want, JSON.stringify(v));
    }
});

test('a plataforma desfaz a selecao (aop/currentService vazio): volta o 300', async () => {
    await mqtt.deliver(TOPICS.current_service, SVC);
    assert.equal((await get()).status, 200);
    await mqtt.deliver(TOPICS.current_service, '');
    const r = await get();
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 300, JSON.stringify(r.json));
});

test('session:current-service pela funcao: cinco campos, serviceId e serviceName vazios (sem SLT)', async () => {
    const tick = () => new Promise(r => setImmediate(r));
    await mqtt.deliver(TOPICS.current_service, '');
    await mqtt.deliver(TOPICS.services, JSON.stringify([{ serviceContextId: SVC }, { serviceContextId: 'urn:tv30:service:outro' }]));
    for (const sid of [SVC, 'urn:tv30:service:outro', 'urn:tv30:service:fora-da-lista']) {
        fake.fcalls.length = 0;
        await mqtt.deliver(TOPICS.current_service, sid);
        await tick();
        const chamadas = fake.fcalls.filter(c => c[0] === 'tv30_sessao_servico');
        assert.equal(chamadas.length, 1, `uma chamada para o servico ${sid}`);
        const h = fake.store.get('session:current-service') as Record<string, string>;
        assert.deepEqual(Object.keys(h).sort(), ['originalNetworkId', 'serviceContextId', 'serviceId', 'serviceName', 'transportStreamId']);
        assert.equal(h.serviceContextId, sid);
        assert.equal(h.serviceId, '', `serviceId de ${sid}`);
        assert.equal(h.serviceName, '', `serviceName de ${sid}`);
    }
    // The function refuses (data outside the schema): the handler logs and
    // stays up.
    const logs: string[] = [];
    const [logOrig, errorOrig] = [console.log, console.error];
    console.log = console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
    fake.recusar('tv30_sessao_servico', 'TV30ESQUEMA tv30_sessao_servico: session:current-service campo serviceName: teste');
    try {
        await mqtt.deliver(TOPICS.current_service, '0');
        await tick();
        await tick();
    } finally {
        fake.recusar('tv30_sessao_servico');
        [console.log, console.error] = [logOrig, errorOrig];
    }
    assert.ok(logs.some(l => l.includes('session:current-service') && l.includes('TV30ESQUEMA')), `recusa logada: ${logs.join(' | ')}`);
    assert.equal((await get()).status, 200, 'a API do servico corrente segue respondendo da memoria');
    await mqtt.deliver(TOPICS.current_service, '');
});
