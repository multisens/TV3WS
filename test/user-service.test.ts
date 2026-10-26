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
test('escritas da sessao saem por FCALL (tv30_sessao_usuario, tv30_sessao_servico_id)', async () => {
    fake.fcalls.length = 0;
    await handlers.get('aop/currentUser')!(U9);
    await handlers.get('aop/currentService')!('svc-z');
    seedProfiles('svc-a');
    assert.equal((await call('POST', '/current-service/users/current-user', { id: U1 })).status, 200);
    assert.deepEqual(fake.fcalls, [['tv30_sessao_usuario', U9], ['tv30_sessao_servico_id', 'svc-z'], ['tv30_sessao_usuario', U1]]);
});

test('C.6.14.5 pela funcao tv30_atributos_emissora: grava, vazio remove, resposta com o alterado', async () => {
    seedProfiles('svc-a');
    fake.fcalls.length = 0;
    let r = await call('POST', `/svc-a/users/${U1}`, { cor: 'azul', tam: 'G' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { cor: 'azul', tam: 'G' });
    r = await call('POST', `/svc-a/users/${U1}`, { cor: '' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(store.get(`user:${U1}:broadcaster-attrs:svc-a`), { tam: 'G' });
    assert.deepEqual(fake.fcalls, [['tv30_atributos_emissora', U1, 'svc-a', 'cor', 'azul', 'tam', 'G'], ['tv30_atributos_emissora', U1, 'svc-a', 'cor', '']]);
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
    const msg = 'TV30ESQUEMA tv30_sessao_usuario: session:current-user valor: tem 65 caracteres, maximo 64';
    fake.recusar('tv30_sessao_usuario', msg);
    const publicados = published.length;
    try {
        const r = await call('POST', '/current-service/users/current-user', { id: U1 });
        expectError(r, 200);
        assert.ok(r.json.description.includes(msg), r.json.description);
        assert.ok(logs.some(l => l.includes(msg)), 'errorHandler loga a mensagem');
        assert.equal(published.length, publicados, 'nao publica o que nao gravou');
        await assert.rejects(Promise.resolve(handlers.get('aop/currentUser')!('x'.repeat(65))), { message: msg });
    } finally {
        fake.recusar('tv30_sessao_usuario');
        console.error = errorOrig;
    }
    fake.recusar('tv30_atributos_emissora', `TV30ESQUEMA tv30_atributos_emissora: user:${U1}:broadcaster-attrs:svc-a perfil "${U1}" fora de users:index (invariante perfil-dependentes)`);
    console.error = () => undefined;
    try {
        expectError(await call('POST', `/svc-a/users/${U1}`, { cor: 'azul' }), 200);
    } finally {
        fake.recusar('tv30_atributos_emissora');
        console.error = errorOrig;
    }
});

// --- profile file (C.6.14.6) ------------------------------------------------
// Outside USER_THUMBS, nonexistent or not a file: 305 (Table C.75).
test('arquivo de perfil (C.6.14.6): caminho que sai de USER_THUMBS da 305 sem o conteudo; dentro, 200', async () => {
    const fsm = await import('fs');
    const osm = await import('os');
    const root = fsm.mkdtempSync(path.join(osm.tmpdir(), 'tv3ws-thumbs-'));
    const thumbs = path.join(root, 'thumbs');
    fsm.mkdirSync(thumbs);
    fsm.writeFileSync(path.join(root, 'segredo.txt'), 'SEGREDO-FORA-DE-THUMBS');
    fsm.writeFileSync(path.join(thumbs, 'a.png'), 'PNG');
    const thumbsOrig = process.env.USER_THUMBS;
    process.env.USER_THUMBS = thumbs;
    try {
        for (const avatar of ['../segredo.txt', '/../segredo.txt', 'x/../../segredo.txt', '..\\segredo.txt','nao-existe.png', '.']) {
            seedProfiles('svc-a');
            store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar });
            const r = await call('GET', `/current-service/users/files?path=${encodeURIComponent(avatar)}`);
            expectError(r, 305);
            assert.ok(!r.text.includes('SEGREDO'), `${avatar}: ${r.text}`);
        }
        // avatar a.png
        seedProfiles('svc-a');
        const ok = await call('GET', '/current-service/users/files?path=a.png');
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.text, 'PNG');
        // Not visible: 405 (case below).
        store.set(`user:${U1}:consent`, new Set(['outro']));
        expectError(await call('GET', '/current-service/users/files?path=a.png'), 405);
    } finally {
        if (thumbsOrig === undefined) delete process.env.USER_THUMBS; else process.env.USER_THUMBS = thumbsOrig;
        fsm.rmSync(root, { recursive: true, force: true });
    }
});

// --- C.6.14.6 not visible: 405; a path of nobody: 305 (Table C.75) ----------
test('arquivo de perfil (C.6.14.6) sem consentimento: 405 sem o conteudo; com consentimento, 200; de ninguem, 305', async () => {
    const fsm = await import('fs');
    const osm = await import('os');
    const thumbs = fsm.mkdtempSync(path.join(osm.tmpdir(), 'tv3ws-thumbs405-'));
    fsm.writeFileSync(path.join(thumbs, 'a.png'), 'PNG-DO-PERFIL');
    fsm.writeFileSync(path.join(thumbs, 'solto.png'), 'PNG-SOLTO');
    const thumbsOrig = process.env.USER_THUMBS;
    process.env.USER_THUMBS = thumbs;
    try {
        // Owner of the avatar not visible to the current service.
        seedProfiles('svc-a');
        store.set(`user:${U1}:consent`, new Set(['svc-b']));
        let r = await call('GET', '/current-service/users/files?path=a.png');
        expectError(r, 405);
        assert.ok(!r.text.includes('PNG-DO-PERFIL'), r.text);
        // Not visible to any service (empty set): 405.
        store.set(`user:${U1}:consent`, new Set());
        expectError(await call('GET', '/current-service/users/files?path=a.png'), 405);
        // Visibility comes before the file: a nonexistent avatar of a profile
        // not visible also gives 405 (it does not reveal whether the file
        // exists).
        store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: 'nao-existe.png' });
        expectError(await call('GET', '/current-service/users/files?path=nao-existe.png'), 405);

        // Two profiles with the same avatar: one visible is enough.
        seedProfiles('svc-a');
        store.set('users:index', new Set([U9, U1]));
        store.set(`user:${U9}`, { id: U9, nickname: 'Nove', avatar: 'a.png' });
        store.set(`user:${U9}:consent`, new Set(['svc-b']));
        r = await call('GET', '/current-service/users/files?path=a.png');
        assert.equal(r.status, 200, r.text);
        assert.equal(r.text, 'PNG-DO-PERFIL');
        // Both not visible: 405.
        store.set(`user:${U1}:consent`, new Set(['svc-b']));
        expectError(await call('GET', '/current-service/users/files?path=a.png'), 405);

        // A file that exists but is nobody's avatar: 305.
        seedProfiles('svc-a');
        expectError(await call('GET', '/current-service/users/files?path=solto.png'), 305);
        // Avatar of a visible profile, nonexistent file: 305.
        store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: 'nao-existe.png' });
        expectError(await call('GET', '/current-service/users/files?path=nao-existe.png'), 305);
    } finally {
        if (thumbsOrig === undefined) delete process.env.USER_THUMBS; else process.env.USER_THUMBS = thumbsOrig;
        fsm.rmSync(thumbs, { recursive: true, force: true });
        store.delete(`user:${U9}`);
        store.delete(`user:${U9}:consent`);
    }
});

// --- avatar = file name of the thumbnails -----------------------------------
// Table 7: "avatar" is a "file path"; the platform writes <id>.svg to
// USER_THUMBS. Table C.75: Content-Type by the file extension.
const AVATAR_CARGA = 'c3167a18-5dc5-4a6e-9b1d-3f2a7c5e8d10.svg';

test('C.6.14.6: Content-Type pela extensao (svg, png, jpg, jpeg, webp); outra extensao, application/octet-stream', async () => {
    const fsm = await import('fs');
    const osm = await import('os');
    const thumbs = fsm.mkdtempSync(path.join(osm.tmpdir(), 'tv3ws-thumbs-mime-'));
    const thumbsOrig = process.env.USER_THUMBS;
    process.env.USER_THUMBS = thumbs;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
    try {
        const cases: [string, string, Buffer][] = [
            [AVATAR_CARGA, 'image/svg+xml', Buffer.from(svg)],
            ['p.png', 'image/png', bin],
            ['j.jpg', 'image/jpeg', bin],
            ['k.jpeg', 'image/jpeg', bin],
            ['w.webp', 'image/webp', bin],
            ['x.gif', 'application/octet-stream', bin],
            ['sem-extensao', 'application/octet-stream', bin],
        ];
        for (const [name, mime, data] of cases) {
            fsm.writeFileSync(path.join(thumbs, name), data);
            seedProfiles('svc-a');
            store.set(`user:${U1}`, { id: U1, nickname: 'Um', avatar: name });
            const res = await fetch(`${base}/current-service/users/files?path=${encodeURIComponent(name)}`);
            assert.equal(res.status, 200, name);
            assert.equal(res.headers.get('content-type'), mime, name);
            const body = Buffer.from(await res.arrayBuffer());
            assert.ok(body.equals(data), `${name}: bytes intactos`);
            assert.equal(res.headers.get('content-length'), String(data.length), name);
        }
    } finally {
        if (thumbsOrig === undefined) delete process.env.USER_THUMBS; else process.env.USER_THUMBS = thumbsOrig;
        fsm.rmSync(thumbs, { recursive: true, force: true });
    }
});

test('C.6.14.2: o avatar sai como esta no perfil (o nome do arquivo), no JSON e no valor em texto', async () => {
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
        fake.recusar('tv30_atributos_emissora', 'TV30ESQUEMA tv30_atributos_emissora: teste');
        expectError(await call('POST', `/svc-a/users/${U1}`, { cor: 'verde' }), 200);
        fake.recusar('tv30_atributos_emissora');
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
        fake.recusar('tv30_atributos_emissora');
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
