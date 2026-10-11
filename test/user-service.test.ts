// APIs de usuario (C.6.14) com redis-client e mqtt-client trocados por dubles.
// Reuniao 05/10 com o Joel:
// - D-0510-5 (P5, um dono por familia de chave): o tv3ws so LE perfis — nao
//   assina aop/users, nao semeia users:index no boot e nao grava lastAccess
//   (quem grava e a plataforma, aop/src/core.js);
// - D-0510-6: erro de Redis em pipeline nao vira resposta "valida" (lista
//   vazia, 300, 305): a API responde 404 {error:200}.
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

// a semeadura antiga lia este arquivo quando users:index estava vazio
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
    store.set('users:index', new Set(['u1']));
    store.set('user:u1', { id: 'u1', nickname: 'Um', avatar: 'a.png' });
    store.set('user:u1:consent', new Set([svc]));
}

// --- D-0510-5 ---------------------------------------------------------------------
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
    await handlers.get('aop/currentUser')!('perfil-x');
    assert.equal(store.get('session:current-user'), 'perfil-x');
    assert.equal(store.has('user:perfil-x'), false);
});

test('POST current-user (C.6.14.4): grava a sessao e publica retido, sem lastAccess', async () => {
    seedProfiles('svc-a');
    const r = await call('POST', '/current-service/users/current-user', { id: 'u1' });
    assert.equal(r.status, 200, r.text);
    assert.equal(store.get('session:current-user'), 'u1');
    assert.deepEqual(published[published.length - 1], ['aop/currentUser', 'u1', true]);
    assert.equal((store.get('user:u1') as Record<string, string>).lastAccess, undefined);
});

// --- D-0510-6 ---------------------------------------------------------------------
test('Redis normal: a listagem C.6.14.1 devolve o perfil visivel', async () => {
    seedProfiles('svc-a');
    const r = await call('POST', '/current-service/users', {});
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { users: [{ id: 'u1' }] });
});

test('pipeline com erro: C.6.14.1 responde 404 {error:200} (antes: 300 sem servico)', async () => {
    seedProfiles('svc-a');
    fake.setDown(true, 'batches');
    try {
        expectError(await call('POST', '/current-service/users', {}), 200);
    } finally { fake.setDown(false); }
});

test('pipeline com erro: arquivo de perfil (C.6.14.6) responde 404 {error:200} (antes: 305)', async () => {
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
        expectError(await call('POST', '/current-service/users/current-user', { id: 'u1' }), 200);
        expectError(await call('GET', '/svc-a/users/u1'), 200);
    } finally { fake.setDown(false); }
});

// --- P4 (Luis, 10/10): escritas pelas funcoes do Redis -----------------------------
test('escritas da sessao saem por FCALL (tv30_sessao_usuario, tv30_sessao_servico_id)', async () => {
    fake.fcalls.length = 0;
    await handlers.get('aop/currentUser')!('u9');
    await handlers.get('aop/currentService')!('svc-z');
    seedProfiles('svc-a');
    assert.equal((await call('POST', '/current-service/users/current-user', { id: 'u1' })).status, 200);
    assert.deepEqual(fake.fcalls, [['tv30_sessao_usuario', 'u9'], ['tv30_sessao_servico_id', 'svc-z'], ['tv30_sessao_usuario', 'u1']]);
});

test('C.6.14.5 pela funcao tv30_atributos_emissora: grava, vazio remove, resposta com o alterado', async () => {
    seedProfiles('svc-a');
    fake.fcalls.length = 0;
    let r = await call('POST', '/svc-a/users/u1', { cor: 'azul', tam: 'G' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { cor: 'azul', tam: 'G' });
    r = await call('POST', '/svc-a/users/u1', { cor: '' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(store.get('user:u1:broadcaster-attrs:svc-a'), { tam: 'G' });
    assert.deepEqual(fake.fcalls, [['tv30_atributos_emissora', 'u1', 'svc-a', 'cor', 'azul', 'tam', 'G'], ['tv30_atributos_emissora', 'u1', 'svc-a', 'cor', '']]);
    // basico protegido: 101 do tv3ws, sem chegar a funcao
    fake.fcalls.length = 0;
    expectError(await call('POST', '/svc-a/users/u1', { nickname: 'x' }), 101);
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
        const r = await call('POST', '/current-service/users/current-user', { id: 'u1' });
        expectError(r, 200);
        assert.ok(r.json.description.includes(msg), r.json.description);
        assert.ok(logs.some(l => l.includes(msg)), 'errorHandler loga a mensagem');
        assert.equal(published.length, publicados, 'nao publica o que nao gravou');
        await assert.rejects(Promise.resolve(handlers.get('aop/currentUser')!('x'.repeat(65))), { message: msg });
    } finally {
        fake.recusar('tv30_sessao_usuario');
        console.error = errorOrig;
    }
    fake.recusar('tv30_atributos_emissora', 'TV30ESQUEMA tv30_atributos_emissora: user:u1:broadcaster-attrs:svc-a perfil "u1" fora de users:index (invariante perfil-dependentes)');
    console.error = () => undefined;
    try {
        expectError(await call('POST', '/svc-a/users/u1', { cor: 'azul' }), 200);
    } finally {
        fake.recusar('tv30_atributos_emissora');
        console.error = errorOrig;
    }
});
