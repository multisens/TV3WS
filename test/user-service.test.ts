// User APIs (C.6.14) with Redis and MQTT by doubles. tv3ws only reads
// profiles (does not subscribe to aop/users, does not seed users:index,
// does not write lastAccess); a Redis error in a pipeline becomes 404
// {error:200}, not a "valid" response.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import { createFakeRedis } from './helpers/fake-redis';

const fake = createFakeRedis();
const store = fake.store;
// Profile ids as UUIDs (Table 7): the double does not check the schema, but
// the ids have the format Redis accepts.
const U1 = '0b6f3e2a-7c1d-4e5f-9a8b-2c3d4e5f6a7b';
const U9 = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PX = '3f2e1d0c-9b8a-4f7e-a6d5-c4b3a2918070';

const handlers = new Map<string, (m: string, t?: string) => void | Promise<void>>();
const published: [string, string, boolean][] = [];
const fakeMqtt = {
    addTopicHandler(t: string, f: (m: string, t?: string) => void | Promise<void>) { handlers.set(t, f); },
    removeTopicHandler() { /* nada */ },
    publish(t: string, m: string, r = true) { published.push([t, m, r]); },
    parseTopic(t: string) { return t; },
};

function stub(rel: string, exports: object): void {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
stub('redis-client', { default: fake.redis });
stub('mqtt-client', {
    default: fakeMqtt,
    TOPICS: { current_user: 'aop/currentUser', current_service: 'aop/currentService' },
});

// A valid profile file, to check that tv3ws does not seed users:index with
// it.
process.env.USER_DATA_FILE = path.join(__dirname, '..', 'user-files', 'userData.json');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const userAPI = require('../src/api/user').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/util') as typeof import('../src/util');

let server: Server;
let base = '';
before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/tv3/current-service/users', userAPI);
    app.use('/tv3/:serviceContextId/users', userAPI);
    app.use(errorHandler);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function call(method: string, route: string, body?: unknown) {
    const res = await fetch(`${base}${route}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json, text };
}
const expectError = (r: { status: number; json: any }, code: number) => {
    assert.equal(r.status, 404);
    assert.equal(r.json?.error, code, JSON.stringify(r.json));
    assert.equal(typeof r.json.description, 'string');
};

function seedProfiles(svc: string) {
    store.set('session:current-service-id', svc);
    store.set('users:index', new Set([U1]));
    store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: 'a.png' });
    store.set(`user:${U1}:consent`, new Set([svc]));
}

// --- profiles read only -----------------------------------------------------
test('nao assina aop/users; assina aop/currentUser e aop/currentService', () => {
    assert.ok(!handlers.has('aop/users'));
    assert.ok(handlers.has('aop/currentUser'));
    assert.ok(handlers.has('aop/currentService'));
});

test('nao semeia users:index no boot, mesmo vazio e com USER_DATA_FILE apontando para um arquivo', async () => {
    await new Promise(r => setTimeout(r, 50));
    assert.equal(store.has('users:index'), false);
});

test('aop/currentUser so espelha a sessao: nada de lastAccess (nem perfil fantasma)', async () => {
    await handlers.get('aop/currentUser')!(PX);
    assert.equal(store.get('session:current-user'), PX);
    assert.equal(store.has(`user:${PX}`), false);
});

test('POST current-user (C.6.14.4): grava a sessao e publica retido, sem lastAccess', async () => {
    seedProfiles('svc-a');
    const r = await call('POST', '/current-service/users/current-user', { id: U1 });
    assert.equal(r.status, 200, r.text);
    assert.equal(store.get('session:current-user'), U1);
    assert.deepEqual(published[published.length - 1], ['aop/currentUser', U1, true]);
    assert.equal((store.get(`user:${U1}`) as Record<string, string>).lastAccess, undefined);
});

test('POST current-user (Tabela C.73): 305 para id inexistente, 405 sem acesso, 300 sem servico; nada gravado', async () => {
    seedProfiles('svc-a');
    store.set('session:current-user', U1);
    const antes = published.length;
    expectError(await call('POST', '/current-service/users/current-user', { id: U9 }), 305);
    store.set(`user:${U1}:consent`, new Set(['svc-b']));
    expectError(await call('POST', '/current-service/users/current-user', { id: U1 }), 405);
    store.delete('session:current-service-id');
    expectError(await call('POST', '/current-service/users/current-user', { id: U1 }), 300);
    assert.equal(store.get('session:current-user'), U1);
    assert.equal(published.length, antes);
});

test('GET current-user (Table C.72): the visible profile, 405 without access, empty id without a current profile, 300 without a service', async () => {
    seedProfiles('svc-a');
    store.set('session:current-user', U1);
    const visible = await call('GET', '/current-service/users/current-user');
    assert.equal(visible.status, 200, visible.text);
    assert.deepEqual(visible.json, { id: U1 });
    store.set(`user:${U1}:consent`, new Set(['svc-b']));
    expectError(await call('GET', '/current-service/users/current-user'), 405);
    store.delete('session:current-user');
    const none = await call('GET', '/current-service/users/current-user');
    assert.equal(none.status, 200, none.text);
    assert.deepEqual(none.json, { id: '' });
    store.delete('session:current-service-id');
    expectError(await call('GET', '/current-service/users/current-user'), 300);
});

// --- Redis failure ----------------------------------------------------------
test('Redis normal: a listagem C.6.14.1 devolve o perfil visivel', async () => {
    seedProfiles('svc-a');
    const r = await call('POST', '/current-service/users', {});
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { users: [{ id: U1 }] });
});

test('pipeline com erro: C.6.14.1 responde 404 {error:200}', async () => {
    seedProfiles('svc-a');
    fake.setDown(true, 'batches');
    try {
        expectError(await call('POST', '/current-service/users', {}), 200);
    } finally { fake.setDown(false); }
});

test('pipeline com erro: arquivo de perfil (C.6.14.6) responde 404 {error:200}', async () => {
    seedProfiles('svc-a');
    fake.setDown(true, 'batches');
    try {
        expectError(await call('GET', '/current-service/users/files?path=a.png'), 200);
    } finally { fake.setDown(false); }
});

test('Redis fora do ar: current-user e atributos respondem 404 {error:200}', async () => {
    seedProfiles('svc-a');
    fake.setDown(true);
    try {
        expectError(await call('GET', '/current-service/users/current-user'), 200);
        expectError(await call('POST', '/current-service/users/current-user', { id: U1 }), 200);
        expectError(await call('GET', `/svc-a/users/${U1}`), 200);
    } finally { fake.setDown(false); }
});

// --- writes by the Redis functions ------------------------------------------
test('escritas da sessao saem por FCALL (tv30_session_user, tv30_session_service_id)', async () => {
    fake.fcalls.length = 0;
    await handlers.get('aop/currentUser')!(U9);
    await handlers.get('aop/currentService')!('svc-z');
    seedProfiles('svc-a');
    assert.equal((await call('POST', '/current-service/users/current-user', { id: U1 })).status, 200);
    assert.deepEqual(fake.fcalls, [['tv30_session_user', U9], ['tv30_session_service_id', 'svc-z'], ['tv30_session_user', U1]]);
});

test('C.6.14.5 pela funcao tv30_broadcaster_attributes: grava, vazio remove, resposta com o alterado', async () => {
    seedProfiles('svc-a');
    fake.fcalls.length = 0;
    let r = await call('POST', `/svc-a/users/${U1}`, { cor: 'azul', tam: 'G' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { cor: 'azul', tam: 'G' });
    r = await call('POST', `/svc-a/users/${U1}`, { cor: '' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(store.get(`user:${U1}:broadcaster-attrs:svc-a`), { tam: 'G' });
    assert.deepEqual(fake.fcalls, [['tv30_broadcaster_attributes', U1, 'svc-a', 'cor', 'azul', 'tam', 'G'], ['tv30_broadcaster_attributes', U1, 'svc-a', 'cor', '']]);
    // Protected basic attribute: 101 from tv3ws, without reaching the
    // function.
    fake.fcalls.length = 0;
    expectError(await call('POST', `/svc-a/users/${U1}`, { nickname: 'x' }), 101);
    assert.deepEqual(fake.fcalls, []);
});

test('escrita recusada pela funcao (esquema): rota responde 404 {error:200} com a mensagem e loga; handler MQTT loga', async () => {
    seedProfiles('svc-a');
    const logs: string[] = [];
    const errorOrig = console.error;
    console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
    const msg = 'TV30SCHEMA tv30_session_user: session:current-user value: has 65 characters, maximum 64';
    fake.recusar('tv30_session_user', msg);
    const publicados = published.length;
    try {
        const r = await call('POST', '/current-service/users/current-user', { id: U1 });
        expectError(r, 200);
        assert.ok(r.json.description.includes(msg), r.json.description);
        assert.ok(logs.some(l => l.includes(msg)), 'errorHandler loga a mensagem');
        assert.equal(published.length, publicados, 'nao publica o que nao gravou');
        await assert.rejects(Promise.resolve(handlers.get('aop/currentUser')!('x'.repeat(65))), { message: msg });
    } finally {
        fake.recusar('tv30_session_user');
        console.error = errorOrig;
    }
    fake.recusar('tv30_broadcaster_attributes', `TV30SCHEMA tv30_broadcaster_attributes: user:${U1}:broadcaster-attrs:svc-a profile "${U1}" outside users:index (invariant profile-dependents)`);
    console.error = () => undefined;
    try {
        expectError(await call('POST', `/svc-a/users/${U1}`, { cor: 'azul' }), 200);
    } finally {
        fake.recusar('tv30_broadcaster_attributes');
        console.error = errorOrig;
    }
});

// --- profile file (C.6.14.6) ------------------------------------------------
// The path names an image of the avatar set (avatar:{name}); Table C.75:
// Content-Type by the media type of the image.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
const imagem = (name: string, body = SVG): void => {
    store.set(`avatar:${name}`, { label: name, type: 'image/svg+xml', body });
};

test('arquivo de perfil (C.6.14.6): imagem do conjunto com Content-Type e Content-Length; fora do conjunto, 305', async () => {
    try {
        imagem('green.svg', '<svg xmlns="http://www.w3.org/2000/svg">é</svg>');
        seedProfiles('svc-a');
        store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: 'green.svg' });
        const res = await fetch(`${base}/current-service/users/files?path=green.svg`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/svg+xml');
        const body = Buffer.from(await res.arrayBuffer());
        assert.equal(body.toString('utf8'), '<svg xmlns="http://www.w3.org/2000/svg">é</svg>');
        assert.equal(res.headers.get('content-length'), String(body.length));

        // Avatar of a visible profile without an image of the set: 305.
        for (const avatar of ['nao-existe.svg', '../green.svg', 'x/../green.svg']) {
            seedProfiles('svc-a');
            store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar });
            expectError(await call('GET', `/current-service/users/files?path=${encodeURIComponent(avatar)}`), 305);
        }
    } finally {
        store.delete('avatar:green.svg');
    }
});

// --- C.6.14.6 not visible: 405; a path of nobody: 305 (Table C.75) ----------
test('arquivo de perfil (C.6.14.6) sem consentimento: 405 sem o conteudo; com consentimento, 200; de ninguem, 305', async () => {
    try {
        imagem('a.svg', '<svg xmlns="http://www.w3.org/2000/svg">DO-PERFIL</svg>');
        imagem('solto.svg');
        // Owner of the avatar not visible to the current service.
        seedProfiles('svc-a');
        store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: 'a.svg' });
        store.set(`user:${U1}:consent`, new Set(['svc-b']));
        let r = await call('GET', '/current-service/users/files?path=a.svg');
        expectError(r, 405);
        assert.ok(!r.text.includes('DO-PERFIL'), r.text);
        // Not visible to any service (empty set): 405.
        store.set(`user:${U1}:consent`, new Set());
        expectError(await call('GET', '/current-service/users/files?path=a.svg'), 405);

        // Two profiles with the same avatar: one visible is enough.
        seedProfiles('svc-a');
        store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: 'a.svg' });
        store.set('users:index', new Set([U9, U1]));
        store.set(`user:${U9}`, { id: U9, nickname: 'Nove', avatar: 'a.svg' });
        store.set(`user:${U9}:consent`, new Set(['svc-b']));
        r = await call('GET', '/current-service/users/files?path=a.svg');
        assert.equal(r.status, 200, r.text);
        assert.ok(r.text.includes('DO-PERFIL'), r.text);
        // Both not visible: 405.
        store.set(`user:${U1}:consent`, new Set(['svc-b']));
        expectError(await call('GET', '/current-service/users/files?path=a.svg'), 405);

        // An image of the set that is nobody's avatar: 305.
        seedProfiles('svc-a');
        expectError(await call('GET', '/current-service/users/files?path=solto.svg'), 305);
    } finally {
        store.delete('avatar:a.svg');
        store.delete('avatar:solto.svg');
        store.delete(`user:${U9}`);
        store.delete(`user:${U9}:consent`);
    }
});

const AVATAR_CARGA = 'green.svg';

test('C.6.14.2: o avatar sai como esta no perfil (o nome da imagem), no JSON e no valor em texto', async () => {
    seedProfiles('svc-a');
    store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: AVATAR_CARGA });
    let r = await call('GET', `/svc-a/users/${U1}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.avatar, AVATAR_CARGA);
    r = await call('GET', `/current-service/users/${U1}?avatar`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, AVATAR_CARGA);
});

// --- notice to the user on C.6.14.5 (Table C.74, "Restrictions") ------------
// A write with a change publishes, not retained, on
// aop/display/layers/popup/info; without a change or on failure, nothing.
const INFO = 'aop/display/layers/popup/info';
const infos = () => published.filter(([t]) => t === INFO);

test('C.6.14.5: gravacao com mudanca publica o aviso (nao retido) com o id do servico e o apelido', async () => {
    seedProfiles('svc-a');
    store.delete(`user:${U1}:broadcaster-attrs:svc-a`);
    published.length = 0;
    const r = await call('POST', `/current-service/users/${U1}`, { cor: 'azul' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { cor: 'azul' }, 'a resposta da API nao muda');
    assert.deepEqual(infos(), [[INFO, JSON.stringify({ value: 'A emissora svc-a atualizou os dados do perfil Um.', timeout: 5000 }), false]]);
});

test('C.6.14.5: o nome do servico corrente (session:current-service) quando a gravacao e nele; outro scid, o id dele', async () => {
    seedProfiles('svc-a');
    store.set('session:current-service', { serviceContextId: 'x', serviceName: 'Canal Teste', serviceId: '', transportStreamId: 't', originalNetworkId: 'o' });
    store.set(`user:${U1}:consent`, new Set(['svc-a', 'svc-b']));
    published.length = 0;
    try {
        assert.equal((await call('POST', `/current-service/users/${U1}`, { a: '1' })).status, 200);
        assert.equal((await call('POST', `/svc-a/users/${U1}`, { a: '2' })).status, 200);
        assert.equal((await call('POST', `/svc-b/users/${U1}`, { a: '3' })).status, 200);
        assert.deepEqual(infos().map(([, m]) => JSON.parse(m).value), [
            'A emissora Canal Teste atualizou os dados do perfil Um.',
            'A emissora Canal Teste atualizou os dados do perfil Um.',
            'A emissora svc-b atualizou os dados do perfil Um.',
        ]);
        // Empty name (the testbed does not publish aop/services): the id.
        store.set('session:current-service', { serviceContextId: 'x', serviceName: '', serviceId: '', transportStreamId: 't', originalNetworkId: 'o' });
        published.length = 0;
        assert.equal((await call('POST', `/svc-a/users/${U1}`, { a: '4' })).status, 200);
        assert.equal(JSON.parse(infos()[0][1]).value, 'A emissora svc-a atualizou os dados do perfil Um.');
    } finally { store.delete('session:current-service'); }
});

test('C.6.14.5: perfil sem apelido -> "...dados do perfil."', async () => {
    seedProfiles('svc-a');
    store.set(`user:${U1}`, { id: U1, avatar: 'a.png' });
    store.delete(`user:${U1}:broadcaster-attrs:svc-a`);
    published.length = 0;
    assert.equal((await call('POST', `/svc-a/users/${U1}`, { cor: 'azul' })).status, 200);
    assert.equal(JSON.parse(infos()[0][1]).value, 'A emissora svc-a atualizou os dados do perfil.');
});

test('C.6.14.5: nada mudou (mesmo valor, remocao do que nao existe) -> sem aviso; mudanca ou remocao do que existe -> aviso', async () => {
    seedProfiles('svc-a');
    store.delete(`user:${U1}:broadcaster-attrs:svc-a`);
    assert.equal((await call('POST', `/svc-a/users/${U1}`, { cor: 'azul', tam: 'G' })).status, 200);
    published.length = 0;
    let r = await call('POST', `/svc-a/users/${U1}`, { cor: 'azul' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { cor: 'azul' });
    r = await call('POST', `/svc-a/users/${U1}`, { nao_existe: '' });
    assert.equal(r.status, 200, r.text);
    r = await call('POST', `/svc-a/users/${U1}`, { cor: 'azul', tam: 'G', outro: '' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(infos(), [], 'sem mudanca, sem aviso');
    // One different value among equal ones notifies; removing an existing one
    // notifies.
    assert.equal((await call('POST', `/svc-a/users/${U1}`, { cor: 'azul', tam: 'M' })).status, 200);
    assert.equal((await call('POST', `/svc-a/users/${U1}`, { tam: '' })).status, 200);
    assert.equal(infos().length, 2);
});

test('C.6.14.5: gravacao que falha nao avisa (recusa da funcao, Redis fora, 101, 305, 405, 300)', async () => {
    seedProfiles('svc-a');
    published.length = 0;
    const errorOrig = console.error;
    console.error = () => undefined;
    try {
        fake.recusar('tv30_broadcaster_attributes', 'TV30SCHEMA tv30_broadcaster_attributes: test');
        expectError(await call('POST', `/svc-a/users/${U1}`, { cor: 'verde' }), 200);
        fake.recusar('tv30_broadcaster_attributes');
        fake.setDown(true);
        expectError(await call('POST', `/svc-a/users/${U1}`, { cor: 'verde' }), 200);
        fake.setDown(false);
        expectError(await call('POST', `/svc-a/users/${U1}`, { nickname: 'x' }), 101);
        expectError(await call('POST', `/svc-a/users/${U1}`, {}), 101);
        expectError(await call('POST', `/svc-a/users/${PX}`, { cor: 'verde' }), 305);
        store.set(`user:${U1}:consent`, new Set(['outro']));
        expectError(await call('POST', `/svc-a/users/${U1}`, { cor: 'verde' }), 405);
        store.set('session:current-service-id', '');
        expectError(await call('POST', `/current-service/users/${U1}`, { cor: 'verde' }), 300);
    } finally {
        fake.recusar('tv30_broadcaster_attributes');
        fake.setDown(false);
        console.error = errorOrig;
    }
    assert.deepEqual(infos(), []);
});

test('C.6.14.5: falha ao montar o aviso (Redis) depois da gravacao: a API responde o sucesso e loga', async () => {
    seedProfiles('svc-a');
    store.delete(`user:${U1}:broadcaster-attrs:svc-a`);
    published.length = 0;
    const hgetOrig = fake.redis.hget;
    const logs: string[] = [];
    const errorOrig = console.error;
    console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
    fake.redis.hget = async () => { throw new Error('redis caiu depois da gravacao'); };
    try {
        const r = await call('POST', `/svc-a/users/${U1}`, { cor: 'roxo' });
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(r.json, { cor: 'roxo' });
        assert.deepEqual(store.get(`user:${U1}:broadcaster-attrs:svc-a`), { cor: 'roxo' });
    } finally {
        fake.redis.hget = hgetOrig;
        console.error = errorOrig;
    }
    assert.deepEqual(infos(), []);
    assert.ok(logs.some(l => l.includes('aviso ao usuario nao saiu') && l.includes('redis caiu')), logs.join(' | '));
});
