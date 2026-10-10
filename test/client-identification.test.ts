// Teste de fumaca HTTP de GET /tv3/authorize e GET /tv3/token (C.6.1.2,
// C.6.1.3): o router real sobre um Express minimo, com redis-client e core
// trocados por dubles em memoria (sem Redis, sem MQTT, pop-up respondido pelo
// duble). Confere a decisao de 03/10 (Luis): clientid ja usado da 101, para
// qualquer classe, sem nova consulta ao espectador (Tabela C.3; C.6.1.4.4).
// E, da reuniao de 05/10 com o Joel: D-0510-4 (conjunto clients:authorized,
// coerente com clients:blocked e com o 101) e D-0510-6 (Redis fora do ar da
// 404 {error:200}, sem travar). Rodada de 10/10: PIN do kex com quatro
// digitos (C.4.3.3).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { randomUUID } from 'crypto';
import express from 'express';
import { createFakeRedis } from './helpers/fake-redis';

// --- dubles ------------------------------------------------------------------
const fake = createFakeRedis();
const fakeRedis = fake.redis;
const store = fake.store;
const members = (k: string) => [...((store.get(k) as Set<string> | undefined) ?? [])];

// Resposta do "espectador" ao pop-up de autorizacao e contagem de pop-ups.
let viewerAnswer = true;
let yesNoPopUps = 0;
// PINs que o tv3ws mandou a TV mostrar (pm=kex)
const pins: string[] = [];
const fakeCore = {
    async showYesNoPopUpAsync(_msg: string, _timeout: number) { yesNoPopUps++; return viewerAnswer; },
    showQRCodePopUp(_key: string, _timeout: number) { /* sem MQTT */ },
    showPINPopUp(pin: string, _timeout: number) { pins.push(pin); /* sem MQTT */ },
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
stub('core', { ...fakeCore, default: fakeCore });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/api/client-identification').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manager = require('../src/modules/auth-manager/manager') as typeof import('../src/modules/auth-manager/manager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/util') as typeof import('../src/util');

// --- servidor ------------------------------------------------------------------
let server: Server;
let base = '';
before(async () => {
    const app = express();
    app.use('/tv3', router);
    app.use(errorHandler);   // camada C.3.2 real: excecao -> 404 {error:200}
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3`;
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function get(route: string, query: Record<string, string>, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${route}?${new URLSearchParams(query)}`, { headers });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') ?? '', json: text ? JSON.parse(text) : undefined };
}
const authorize = (clientid: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    get('/authorize', { clientid, 'display-name': 'teste', ...extra }, headers);
const expectError = (r: { status: number; type: string; json: any }, code: number) => {
    assert.equal(r.status, 404);
    assert.match(r.type, /application\/json/);
    assert.equal(r.json.error, code, JSON.stringify(r.json));
    assert.equal(typeof r.json.description, 'string');
};
// Pop-ups abertos durante fn (o 101 nao pode consultar o espectador).
async function popUpsDuring(fn: () => Promise<void>): Promise<number> {
    const before = yesNoPopUps;
    await fn();
    return yesNoPopUps - before;
}

// --- casos -----------------------------------------------------------------------
test('local autonomo: primeira autorizacao da refreshToken; reuso do clientid da 101 sem pop-up', async () => {
    viewerAnswer = true;
    const cid = randomUUID();

    let first: Awaited<ReturnType<typeof authorize>> | undefined;
    assert.equal(await popUpsDuring(async () => { first = await authorize(cid); }), 1);
    assert.equal(first!.status, 200);
    assert.equal(typeof first!.json.refreshToken, 'string');

    // antes da decisao de 03/10 este segundo /authorize reemitia o refresh token
    let again: Awaited<ReturnType<typeof authorize>> | undefined;
    assert.equal(await popUpsDuring(async () => { again = await authorize(cid); }), 0);
    expectError(again!, 101);
    assert.equal(again!.json.refreshToken, undefined);
});

test('o refresh token guardado continua valendo em /tv3/token depois do 101', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    const first = await authorize(cid);
    assert.equal(first.status, 200);
    expectError(await authorize(cid), 101);

    const tok = await get('/token', { clientid: cid, 'refresh-token': first.json.refreshToken });
    assert.equal(tok.status, 200, JSON.stringify(tok.json));
    assert.equal(typeof tok.json.accessToken, 'string');
    assert.equal(tok.json.tokenType, 'Bearer');
    assert.notEqual(tok.json.refreshToken, first.json.refreshToken); // rotacao a cada /token

    // o refresh token rotacionado vale; o antigo nao (101 na C.6.1.3)
    const next = await get('/token', { clientid: cid, 'refresh-token': tok.json.refreshToken });
    assert.equal(next.status, 200, JSON.stringify(next.json));
    expectError(await get('/token', { clientid: cid, 'refresh-token': first.json.refreshToken }), 101);
});

test('quem perdeu o refresh token autoriza de novo com clientid novo (nova consulta ao espectador)', async () => {
    viewerAnswer = true;
    const lost = randomUUID();
    assert.equal((await authorize(lost)).status, 200);
    expectError(await authorize(lost), 101);

    let fresh: Awaited<ReturnType<typeof authorize>> | undefined;
    assert.equal(await popUpsDuring(async () => { fresh = await authorize(randomUUID()); }), 1);
    assert.equal(fresh!.status, 200);
    assert.equal(typeof fresh!.json.refreshToken, 'string');
});

test('nao local (pm=qrcode): reuso do clientid da 101 sem pop-up', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    const first = await authorize(cid, { pm: 'qrcode' });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(typeof first.json.challenge, 'string');

    let again: Awaited<ReturnType<typeof authorize>> | undefined;
    assert.equal(await popUpsDuring(async () => { again = await authorize(cid, { pm: 'qrcode' }); }), 0);
    expectError(again!, 101);
    // trocar a classe no reuso (sem pm) tambem da 101
    expectError(await authorize(cid), 101);
});

test('local associado (Origin em origins:associated): reuso do clientid da 101', async () => {
    viewerAnswer = true;
    const origin = 'http://app-associada.test';
    await fakeRedis.hset('origins:associated', { [origin]: 'svc-a' });
    const cid = randomUUID();
    assert.equal((await authorize(cid, {}, { Origin: origin })).status, 200);
    expectError(await authorize(cid, {}, { Origin: origin }), 101);
});

test('recusa no pop-up da 102; o clientid recusado fica bloqueado e o reuso da 101 sem pop-up', async () => {
    viewerAnswer = false;
    const cid = randomUUID();
    expectError(await authorize(cid), 102);

    viewerAnswer = true;
    let again: Awaited<ReturnType<typeof authorize>> | undefined;
    assert.equal(await popUpsDuring(async () => { again = await authorize(cid); }), 0);
    expectError(again!, 101);
});

test('nao local (pm=kex): a resposta traz "key" e o cliente deriva o mesmo segredo e resolve o challenge', async () => {
    viewerAnswer = true;
    const { createECDH, createHash, createDecipheriv, createCipheriv } = await import('crypto');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest();
    const aes = (enc: boolean, k: Buffer, d: Buffer) => {
        const c = enc ? createCipheriv('aes-128-ecb', k, null) : createDecipheriv('aes-128-ecb', k, null);
        return Buffer.concat([c.update(d), c.final()]);
    };
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const cid = randomUUID();
    const r = await authorize(cid, { pm: 'kex', key: ecdh.getPublicKey(null, 'uncompressed').toString('base64url') });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(typeof r.json.challenge, 'string');
    // Tabela C.3 (3): {challenge, key}; key = ponto SEC 1 sem compressao (C.4.3.4)
    assert.equal(typeof r.json.key, 'string', JSON.stringify(r.json));
    const serverKey = Buffer.from(r.json.key, 'base64url');
    assert.equal(serverKey.length, 65);
    assert.equal(serverKey[0], 0x04);

    // C.4.3.3: segredo = SHA-256(ECDH)[0:16]; challenge-response da Tabela C.4
    const hash = sha(ecdh.computeSecret(serverKey));
    const secret = hash.subarray(0, 16);
    // C.4.3.3, nota: o PIN mostrado na TV e hash mod 10 000, com quatro digitos
    const expectedPin = (BigInt('0x' + hash.toString('hex')) % BigInt(10000)).toString().padStart(4, '0');
    assert.equal(pins[pins.length - 1], expectedPin);
    assert.match(pins[pins.length - 1], /^\d{4}$/);
    const plain = aes(false, secret, Buffer.from(r.json.challenge, 'base64url'));
    const cr = aes(true, secret, sha(plain)).toString('base64url');
    const tok = await fetch(`${base}/token?${new URLSearchParams({ clientid: cid, 'challenge-response': cr })}`);
    assert.equal(tok.status, 200);
    assert.match(tok.headers.get('content-type') ?? '', /application\/octet-stream/);
    const body = JSON.parse(aes(false, secret, Buffer.from(await tok.arrayBuffer())).toString('utf8'));
    assert.equal(typeof body.accessToken, 'string');
    assert.equal(typeof body.refreshToken, 'string');
});

test('PIN do kex com quatro digitos (C.4.3.3): zeros a esquerda, "0042" e nao "42"', () => {
    const { pinFromHash } = require('../src/api/client-identification/service') as typeof import('../src/api/client-identification/service');
    const hashOf = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');   // 32 bytes, como o SHA-256
    const max = BigInt('0x' + 'f'.repeat(64));
    assert.equal(pinFromHash(hashOf(BigInt(42))), '0042');
    assert.equal(pinFromHash(hashOf(BigInt(10042))), '0042');
    assert.equal(pinFromHash(hashOf(BigInt(7))), '0007');
    assert.equal(pinFromHash(hashOf(BigInt(0))), '0000');
    assert.equal(pinFromHash(hashOf(BigInt(9999))), '9999');
    assert.equal(pinFromHash(hashOf(max)), (max % BigInt(10000)).toString().padStart(4, '0'));
});

test('nao local (pm=qrcode): a resposta nao traz "key"', async () => {
    viewerAnswer = true;
    const r = await authorize(randomUUID(), { pm: 'qrcode' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.key, undefined);
});

// --- D-0510-4: clientes autorizados (reuniao 05/10 com o Joel) -------------------
test('autorizado entra em clients:authorized; recusado so em clients:blocked', async () => {
    viewerAnswer = true;
    const ok = randomUUID();
    assert.equal((await authorize(ok)).status, 200);
    assert.ok(members('clients:authorized').includes(ok));
    assert.ok(!members('clients:blocked').includes(ok));

    viewerAnswer = false;
    const no = randomUUID();
    expectError(await authorize(no), 102);
    assert.ok(members('clients:blocked').includes(no));
    assert.ok(!members('clients:authorized').includes(no));

    assert.ok((await manager.listAuthorizedClients()).includes(ok));
    assert.ok((await manager.listBlockedClients()).includes(no));
    const listed = await manager.listAuthorizedClients();
    assert.deepEqual(listed, [...listed].sort());
});

test('bloquear um autorizado: sai de clients:authorized, /token recusa (102) e o reuso da 101', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    const first = await authorize(cid);
    assert.equal(first.status, 200);

    await manager.BlockClient(cid);
    assert.ok(!members('clients:authorized').includes(cid));
    assert.ok(members('clients:blocked').includes(cid));
    expectError(await get('/token', { clientid: cid, 'refresh-token': first.json.refreshToken }), 102);
    assert.equal(await popUpsDuring(async () => { expectError(await authorize(cid), 101); }), 0);
});

test('cliente anterior ao conjunto (so client:{id}): reuso da 101 e a migracao do boot o inclui', async () => {
    viewerAnswer = true;
    const legacy = randomUUID();
    const legacyBlocked = randomUUID();
    await fakeRedis.hset(`client:${legacy}`, { class: 'local-autonomous', refreshToken: 'rt-antigo' });
    await fakeRedis.hset(`client:${legacyBlocked}`, { class: 'local-autonomous', refreshToken: 'rt-antigo-2' });
    await fakeRedis.sadd('clients:blocked', legacyBlocked);

    assert.equal(await popUpsDuring(async () => { expectError(await authorize(legacy), 101); }), 0);
    // antes da migracao, /token nao o reconhece como autorizado
    expectError(await get('/token', { clientid: legacy, 'refresh-token': 'rt-antigo' }), 102);

    const added = await manager.backfillAuthorizedClients();
    assert.ok(added >= 1);
    assert.ok(members('clients:authorized').includes(legacy));
    assert.ok(!members('clients:authorized').includes(legacyBlocked), 'bloqueado nao entra em clients:authorized');
    assert.equal(await manager.backfillAuthorizedClients(), 0, 'migracao idempotente');

    const tok = await get('/token', { clientid: legacy, 'refresh-token': 'rt-antigo' });
    assert.equal(tok.status, 200, JSON.stringify(tok.json));
});

// --- D-0510-6: Redis fora do ar ----------------------------------------------------
test('Redis fora do ar: /authorize e /token respondem 404 {error:200}, sem pop-up', async () => {
    viewerAnswer = true;
    fake.setDown(true);
    try {
        let r: Awaited<ReturnType<typeof authorize>> | undefined;
        assert.equal(await popUpsDuring(async () => { r = await authorize(randomUUID(), {}, { Origin: 'http://qualquer.test' }); }), 0);
        expectError(r!, 200);
        expectError(await authorize(randomUUID()), 200);
        expectError(await get('/token', { clientid: randomUUID(), 'refresh-token': 'x' }), 200);
    } finally {
        fake.setDown(false);
    }
});
