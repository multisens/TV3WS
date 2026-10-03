// Teste de fumaca HTTP das rotas C.6.8 (POST/GET/DELETE /tv3/bind-context):
// o router real sobre um Express minimo, com redis-client e core trocados
// por dubles em memoria (sem Redis, sem MQTT). Confere codigos C.3.2 e o
// formato da chave bind-context:{serviceId}.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import express from 'express';

// --- dubles ------------------------------------------------------------------
const SCID = 'c08b2c72-fd14-4095-adaf-2e5810850c57';
type Value = string | string[] | Record<string, string>;
const store = new Map<string, Value>();

const fakeRedis = {
    async get(k: string) { const v = store.get(k); return typeof v === 'string' ? v : null; },
    async lrange(k: string) { const v = store.get(k); return Array.isArray(v) ? [...v] : []; },
    async rpush(k: string, ...vals: string[]) {
        const v = (store.get(k) as string[] | undefined) ?? [];
        v.push(...vals); store.set(k, v); return v.length;
    },
    async lrem(k: string, _count: number, val: string) {
        const v = (store.get(k) as string[] | undefined) ?? [];
        const kept = v.filter(x => x !== val);
        if (kept.length) store.set(k, kept); else store.delete(k);
        return v.length - kept.length;
    },
    async scan(_cursor: string, _m: string, pattern: string) {
        const prefix = pattern.replace(/\*$/, '');
        return ['0', [...store.keys()].filter(k => k.startsWith(prefix))];
    },
    async hgetall(k: string) { const v = store.get(k); return v && !Array.isArray(v) && typeof v === 'object' ? { ...v } : {}; },
};

function stub(rel: string, exports: object): void {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
stub('redis-client', { default: fakeRedis });
stub('core', { default: { current: { serviceContextId: SCID } } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/api/broadcaster-security').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/util');

// --- servidor ------------------------------------------------------------------
let server: Server;
let base = '';
before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/tv3/bind-context', router);
    app.use(errorHandler);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3/bind-context`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function call(method: string, headers: Record<string, string> = {}, body?: string) {
    const res = await fetch(base, { method, headers, body });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') ?? '', json: text ? JSON.parse(text) : undefined };
}
const post = (obj: unknown) => call('POST', { 'Content-Type': 'application/json' }, JSON.stringify(obj));
const expectError = (r: { status: number; type: string; json: any }, code: number) => {
    assert.equal(r.status, 404);
    assert.match(r.type, /application\/json/);
    assert.equal(r.json.error, code, JSON.stringify(r.json));
    assert.equal(typeof r.json.description, 'string');
};
function tune(serviceId: string, serviceName: string, sid: string) {
    store.set('session:current-service-id', serviceId);
    store.set('session:current-service', { serviceContextId: SCID, serviceName, serviceId: sid });
}

const rsa = generateKeyPairSync('rsa', { modulusLength: 512 });
const privB64 = (rsa.privateKey.export({ format: 'der', type: 'pkcs1' }) as Buffer).toString('base64');
const pubB64 = (rsa.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({ iat: now() - 5, nbf: now() - 5, exp: now() + 600 });
const hsToken = (secret: string, extra: object = {}) => jwt.sign({ ...claims(), ...extra }, secret, { algorithm: 'HS256' });
const rsToken = () => jwt.sign(claims(), rsa.privateKey, { algorithm: 'RS256', allowInsecureKeySizes: true });

// --- casos (sequenciais: compartilham o store) --------------------------------

test('POST sem servico corrente => 300; corpo invalido => 101/105', async () => {
    expectError(await post({ alg: 'HS256', key: 'segredo-a' }), 300);
    tune('urn:tv30:service:a', 'Canal A', '7');
    expectError(await post({}), 105);
    expectError(await post({ alg: 'HS256' }), 105);
    expectError(await post({ alg: 'ES256', key: 'x' }), 101);
    expectError(await post({ alg: 'RS256', key: 'segredo' }), 101);
    expectError(await post([1]), 101);
    expectError(await call('POST', { 'Content-Type': 'application/json' }, '{"alg":'), 101); // JSON quebrado
    expectError(await call('POST'), 101); // sem corpo
    assert.equal(store.has('bind-context:urn:tv30:service:a'), false);
});

test('POST registra {alg,key,registeredAt} sem duplicata e responde serviceContextId', async () => {
    const r = await post({ alg: 'HS256', key: 'segredo-a' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { serviceContextId: SCID });
    await post({ alg: 'HS256', key: 'segredo-a' }); // de novo: nao duplica
    const list = store.get('bind-context:urn:tv30:service:a') as string[];
    assert.equal(list.length, 1);
    const e = JSON.parse(list[0]);
    assert.equal(e.alg, 'HS256');
    assert.equal(e.key, 'segredo-a');
    assert.equal(typeof e.registeredAt, 'number');

    tune('urn:tv30:service:b', 'Canal B', '9');
    assert.equal((await post({ alg: 'RS256', key: privB64 })).status, 200); // privada, como o exemplo da norma
    assert.equal((store.get('bind-context:urn:tv30:service:b') as string[]).length, 1);
});

test('GET: 104 sem cabecalho, 108 nao-JWT, 101 assinatura sem chave, 108 expirado', async () => {
    expectError(await call('GET'), 104);
    expectError(await call('GET', { 'bind-token': 'nao-e-jwt' }), 108);
    expectError(await call('GET', { 'bind-token': hsToken('segredo-errado') }), 101);
    expectError(await call('GET', { 'bind-token': hsToken('segredo-a', { exp: now() - 1 }) }), 108);
    expectError(await call('GET', { 'bind-token': hsToken('segredo-a', { nbf: now() + 600 }) }), 108);
});

test('GET: boundServices so com o servico cuja chave assina; nome/id so do corrente', async () => {
    // corrente = b
    let r = await call('GET', { 'bind-token': rsToken() });
    assert.equal(r.status, 200);
    // serviceId volta a inteiro (Tabela C.8), embora o Redis o guarde em texto
    assert.deepEqual(r.json, { boundServices: [{ serviceContextId: SCID, serviceName: 'Canal B', serviceId: 9 }] });

    r = await call('GET', { 'bind-token': hsToken('segredo-a') });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { boundServices: [{ serviceContextId: SCID }] }); // a nao e o corrente
});

test('DELETE: 105 sem key; revoga pela publica equivalente; {} mesmo se nao existe ou sem servico', async () => {
    expectError(await call('DELETE'), 105);
    let r = await call('DELETE', { key: pubB64 }); // registrada como privada PKCS#1; revogada pela SPKI
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {});
    assert.equal(store.has('bind-context:urn:tv30:service:b'), false);
    expectError(await call('GET', { 'bind-token': rsToken() }), 101);

    r = await call('DELETE', { key: 'nunca-registrada' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {});

    // revogacao age so no servico corrente: a chave de a continua valendo
    assert.equal((await call('GET', { 'bind-token': hsToken('segredo-a') })).status, 200);
    await call('DELETE', { key: 'segredo-a' }); // corrente = b: nao mexe em a
    assert.equal((store.get('bind-context:urn:tv30:service:a') as string[]).length, 1);

    // sem servico corrente nao ha lista de que remover: sucesso (C.49), nada muda
    store.delete('session:current-service-id');
    r = await call('DELETE', { key: 'segredo-a' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {});
    assert.equal((store.get('bind-context:urn:tv30:service:a') as string[]).length, 1);
});
