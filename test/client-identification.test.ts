// GET /tv3/authorize and GET /tv3/token (C.6.1.2, C.6.1.3): the real router
// on a minimal Express, Redis and core by doubles (the pop-up answered by
// the double). A clientid already used gives 101 without a new prompt
// (Table C.3; C.6.1.4.4), clients:authorized x clients:blocked, Redis down,
// a 4-digit PIN, empty = absent, a single-use challenge, the yes of a
// non-local client stored only on the /tv3/token that checks the challenge
// (C.4.2.3).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv, createECDH } from 'crypto';
import express from 'express';
import { createFakeRedis } from './helpers/fake-redis';

// --- doubles -----------------------------------------------------------------
const fake = createFakeRedis();
const fakeRedis = fake.redis;
const store = fake.store;
const members = (k: string) => [...((store.get(k) as Set<string> | undefined) ?? [])];

// Answer of the "viewer" to the authorization pop-up, and count of pop-ups.
let viewerAnswer = true;
let yesNoPopUps = 0;
// PINs tv3ws sent the TV to show (pm=kex).
const pins: string[] = [];
// Keys tv3ws sent the TV to show in the QR code (pm=qrcode).
const qrKeys: string[] = [];
// The pop-ups publish nothing (no MQTT).
const fakeCore = {
    async showYesNoPopUpAsync(_msg: string, _timeout: number) { yesNoPopUps++; return viewerAnswer; },
    showQRCodePopUp(key: string, _timeout: number) { qrKeys.push(key); },
    showPINPopUp(pin: string, _timeout: number) { pins.push(pin); },
    // Closing at the end of the pairing (checked in pairing-popup.test.ts).
    closeQRCodePopUp() { },
    closePINPopUp() { },
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _camadaParaTestes } = require('../src/api/client-identification/service') as typeof import('../src/api/client-identification/service');
// The QR code or PIN on screen makes the next /tv3/authorize get 103, and
// several cases here leave the pairing open: each case starts with the layer
// free (the 103 cases are in pairing-popup.test.ts).
beforeEach(() => _camadaParaTestes.limpar());

// --- server ------------------------------------------------------------------
let server: Server;
let base = '';
before(async () => {
    const app = express();
    // x-teste-https: req.protocol is 'https' (arrival by HTTPS, which this test
    // server does not have).
    app.use((req, _res, next) => {
        if (req.get('x-teste-https')) Object.defineProperty(req, 'protocol', { value: 'https' });
        next();
    });
    app.use('/tv3', router);
    // The real C.3.2 layer: an exception becomes 404 {error:200}.
    app.use(errorHandler);
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
// Pop-ups opened during fn (the 101 must not prompt the viewer).
async function popUpsDuring(fn: () => Promise<void>): Promise<number> {
    const before = yesNoPopUps;
    await fn();
    return yesNoPopUps - before;
}

// --- cases -------------------------------------------------------------------
test('local autonomo: primeira autorizacao da refreshToken; reuso do clientid da 101 sem pop-up', async () => {
    viewerAnswer = true;
    const cid = randomUUID();

    let first: Awaited<ReturnType<typeof authorize>> | undefined;
    assert.equal(await popUpsDuring(async () => { first = await authorize(cid); }), 1);
    assert.equal(first!.status, 200);
    assert.equal(typeof first!.json.refreshToken, 'string');

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
    // Rotation on every /token.
    assert.notEqual(tok.json.refreshToken, first.json.refreshToken);

    // The rotated refresh token is valid; the old one is not (101 on C.6.1.3).
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

// tv3ws never issues a credential of the associated class.
test('local associado (Origin em origins:associated): 106 em /authorize, sem pop-up e sem registro', async () => {
    viewerAnswer = true;
    const origin = 'http://app-associada.test';
    await fakeRedis.hset('origins:associated', { [origin]: 'svc-a' });
    const cid = randomUUID();
    const n = await popUpsDuring(async () => expectError(await authorize(cid, {}, { Origin: origin }), 106));
    assert.equal(n, 0, 'pop-up aberto para o associado');
    assert.ok(!members('clients:authorized').includes(cid));
    assert.ok(!members('clients:blocked').includes(cid));
    assert.equal(store.has(`client:${cid}`), false);
    // With pm the client is classified as non-local (the class of the
    // credential is not associated).
    assert.notEqual((await authorize(randomUUID(), { pm: 'qrcode' }, { Origin: origin })).status, 106);
});

test('registro client:{id} de classe associada: /token da 106', async () => {
    const cid = randomUUID();
    await manager.AuthorizeClient(cid, 'local-associated');
    const rt = (await manager.GetAuthorizedClient(cid)).getRefreshToken();
    expectError(await get('/token', { clientid: cid, 'refresh-token': rt }), 106);
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
    // Table C.3 (3): {challenge, key}; key = SEC 1 point without compression
    // (C.4.3.4).
    assert.equal(typeof r.json.key, 'string', JSON.stringify(r.json));
    const serverKey = Buffer.from(r.json.key, 'base64url');
    assert.equal(serverKey.length, 65);
    assert.equal(serverKey[0], 0x04);

    // C.4.3.3: secret = SHA-256(ECDH)[0:16]; challenge-response of Table C.4.
    const hash = sha(ecdh.computeSecret(serverKey));
    const secret = hash.subarray(0, 16);
    // C.4.3.3, note: the PIN shown on the TV is the hash mod 10 000, with four
    // digits.
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
    // 32 bytes, as SHA-256.
    const hashOf = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
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

// --- authorized clients ------------------------------------------------------
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

test('cliente so com client:{id}, fora de clients:authorized: reuso da 101 e o boot o inclui', async () => {
    viewerAnswer = true;
    const legacy = randomUUID();
    const legacyBlocked = randomUUID();
    await fakeRedis.hset(`client:${legacy}`, { class: 'local-autonomous', refreshToken: 'rt-antigo' });
    await fakeRedis.hset(`client:${legacyBlocked}`, { class: 'local-autonomous', refreshToken: 'rt-antigo-2' });
    await fakeRedis.sadd('clients:blocked', legacyBlocked);

    assert.equal(await popUpsDuring(async () => { expectError(await authorize(legacy), 101); }), 0);
    // Without the boot inclusion, /token does not recognize it as authorized.
    expectError(await get('/token', { clientid: legacy, 'refresh-token': 'rt-antigo' }), 102);

    const added = await manager.backfillAuthorizedClients();
    assert.ok(added >= 1);
    assert.ok(members('clients:authorized').includes(legacy));
    assert.ok(!members('clients:authorized').includes(legacyBlocked), 'bloqueado nao entra em clients:authorized');
    assert.equal(await manager.backfillAuthorizedClients(), 0, 'migracao idempotente');

    const tok = await get('/token', { clientid: legacy, 'refresh-token': 'rt-antigo' });
    assert.equal(tok.status, 200, JSON.stringify(tok.json));
});

// --- client writes by the Redis functions -----------------------------------
test('autorizar, recusar, emitir token e incluir no boot saem por FCALL das funcoes tv30_cliente_*', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    fake.fcalls.length = 0;
    const first = await authorize(cid);
    assert.equal(first.status, 200);
    const tok = await get('/token', { clientid: cid, 'refresh-token': first.json.refreshToken });
    assert.equal(tok.status, 200, JSON.stringify(tok.json));
    const nomes = fake.fcalls.map(c => c[0]);
    assert.deepEqual(nomes.filter(n => n === 'tv30_cliente_autoriza').length, 1);
    assert.ok(nomes.includes('tv30_cliente_grava'), 'rotacao/emissao gravam client:{id} pela funcao');
    const autoriza = fake.fcalls.find(c => c[0] === 'tv30_cliente_autoriza')!;
    assert.equal(autoriza[1], cid);
    assert.deepEqual(autoriza.slice(2).filter((_, i) => i % 2 === 0), ['class', 'refreshToken'], 'campos em ordem estavel, sem accessToken antes do /token');

    viewerAnswer = false;
    const no = randomUUID();
    fake.fcalls.length = 0;
    expectError(await authorize(no), 102);
    assert.deepEqual(fake.fcalls, [['tv30_cliente_bloqueia', no]]);
});

test('autorizacao recusada pela funcao (esquema): 404 {error:200}, cliente fora de clients:authorized', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    const msg = 'TV30ESQUEMA tv30_cliente_autoriza: client:x campo class: deve ser um de local-associated, local-autonomous, non-local';
    fake.recusar('tv30_cliente_autoriza', msg);
    const errorOrig = console.error;
    console.error = () => undefined;
    try {
        const r = await authorize(cid);
        expectError(r, 200);
        assert.ok(r.json.description.includes(msg), r.json.description);
    } finally {
        fake.recusar('tv30_cliente_autoriza');
        console.error = errorOrig;
    }
    assert.ok(!members('clients:authorized').includes(cid));
});

// --- Redis down --------------------------------------------------------------
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

// --- empty parameter and single-use challenge -------------------------------
// An empty or blank value counts as absent (105, Tables C.3 and C.4); after
// the success by challenge-response, a repetition gives 102 (Table C.4).
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const aes = (enc: boolean, k: Buffer, d: Buffer) => {
    const c = enc ? createCipheriv('aes-128-ecb', k, null) : createDecipheriv('aes-128-ecb', k, null);
    return Buffer.concat([c.update(d), c.final()]);
};

// GET with a hand-written query (to send an empty "refresh-token=" etc.).
async function getRaw(route: string, rawQuery: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${route}?${rawQuery}`, { headers });
    const type = res.headers.get('content-type') ?? '';
    const raw = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type, raw, json: /json/.test(type) ? JSON.parse(raw.toString('utf8')) : undefined };
}
const HTTPS = { 'x-teste-https': '1' };

type NonLocal = { cid: string; secret: Buffer; cr: string; plain: Buffer };

// /tv3/authorize of a non-local client and the solution of the challenge
// (Table C.4), without calling /tv3/token.
async function pairNonLocal(pm: 'qrcode' | 'kex', cid: string = randomUUID()): Promise<NonLocal> {
    viewerAnswer = true;
    const ecdh = createECDH('prime256v1');
    const extra: Record<string, string> = { pm };
    if (pm === 'kex') {
        ecdh.generateKeys();
        extra.key = ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
    }
    const r = await authorize(cid, extra);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const secret = pm === 'qrcode'
        ? sha(Buffer.from(qrKeys[qrKeys.length - 1], 'base64url')).subarray(0, 16)
        : sha(ecdh.computeSecret(Buffer.from(r.json.key, 'base64url'))).subarray(0, 16);
    const plain = aes(false, secret, Buffer.from(r.json.challenge, 'base64url'));
    return { cid, secret, cr: aes(true, secret, sha(plain)).toString('base64url'), plain };
}
const tokenByChallenge = (p: NonLocal, headers: Record<string, string> = {}) =>
    getRaw('/token', `clientid=${p.cid}&challenge-response=${p.cr}`, headers);
const notStored = (cid: string) => {
    assert.equal(store.has(`client:${cid}`), false, `client:${cid} gravado`);
    assert.ok(!members('clients:authorized').includes(cid), `${cid} em clients:authorized`);
};

// --- the yes of a non-local client: memory only until the challenge-response
// is checked (C.4.2.3) ---
for (const pm of ['qrcode', 'kex'] as const) {
    test(`pm=${pm}: o sim sem pareamento concluido nao grava nada; o mesmo clientid ve o pop-up de novo e so o desafio novo conclui`, async () => {
        fake.fcalls.length = 0;
        const p = await pairNonLocal(pm);
        assert.deepEqual(fake.fcalls.map(c => c[0]), [], 'nenhuma gravacao no sim do nao local');
        notStored(p.cid);
        // refresh-token requires the stored authorization.
        expectError(await getRaw('/token', `clientid=${p.cid}&refresh-token=x`, HTTPS), 102);

        // Layer free, as at the end of the lock: the pending attempt does not
        // give 101.
        _camadaParaTestes.limpar();
        let p2: NonLocal | undefined;
        assert.equal(await popUpsDuring(async () => { p2 = await pairNonLocal(pm, p.cid); }), 1);
        notStored(p.cid);
        // The previous attempt was discarded.
        expectError(await tokenByChallenge(p), 102);

        const ok = await tokenByChallenge(p2!);
        assert.equal(ok.status, 200);
        assert.equal(typeof JSON.parse(aes(false, p2!.secret, ok.raw).toString('utf8')).accessToken, 'string');
        assert.ok(members('clients:authorized').includes(p.cid));
        assert.equal((store.get(`client:${p.cid}`) as Record<string, string>).class, 'non-local');
        const autoriza = fake.fcalls.filter(c => c[0] === 'tv30_cliente_autoriza');
        assert.equal(autoriza.length, 1);
        assert.deepEqual(autoriza[0].slice(1, 4), [p.cid, 'class', 'non-local']);
    });

    test(`pm=${pm}: pareamento concluido: reuso do clientid da 101 sem pop-up, com ou sem pm`, async () => {
        const p = await pairNonLocal(pm);
        assert.equal((await tokenByChallenge(p)).status, 200);
        for (const extra of [{ pm: 'qrcode' }, { pm: 'kex', key: 'x' }, {}] as Record<string, string>[]) {
            assert.equal(await popUpsDuring(async () => expectError(await authorize(p.cid, extra), 101)), 0, JSON.stringify(extra));
        }
    });
}

test('nao local: a recusa no pop-up grava clients:blocked na hora; o reuso da 101 sem pop-up, com ou sem pm', async () => {
    viewerAnswer = false;
    const cid = randomUUID();
    const qr = qrKeys.length;
    expectError(await authorize(cid, { pm: 'qrcode' }), 102);
    assert.equal(qrKeys.length, qr, 'sem pop-up de pareamento');
    assert.ok(members('clients:blocked').includes(cid));
    assert.ok(!members('clients:authorized').includes(cid));
    viewerAnswer = true;
    for (const extra of [{ pm: 'qrcode' }, { pm: 'kex', key: 'x' }, {}] as Record<string, string>[]) {
        assert.equal(await popUpsDuring(async () => expectError(await authorize(cid, extra), 101)), 0, JSON.stringify(extra));
    }
});

test('nao local com tentativa pendente: o novo pedido recusado no pop-up bloqueia, e o desafio anterior da 102', async () => {
    const p = await pairNonLocal('qrcode');
    _camadaParaTestes.limpar();
    viewerAnswer = false;
    expectError(await authorize(p.cid, { pm: 'qrcode' }), 102);
    viewerAnswer = true;
    assert.ok(members('clients:blocked').includes(p.cid));
    expectError(await tokenByChallenge(p), 102);
    notStored(p.cid);
});

test('gravacao da autorizacao recusada no /tv3/token: 404 {error:200} sem credencial e sem registro; o material volta e o mesmo challenge-response conclui', async () => {
    const p = await pairNonLocal('kex');
    const msg = 'TV30ESQUEMA tv30_cliente_autoriza: recusa de teste';
    fake.recusar('tv30_cliente_autoriza', msg);
    const errorOrig = console.error;
    console.error = () => undefined;
    try {
        const r = await tokenByChallenge(p);
        expectError(r, 200);
        assert.equal(r.json.accessToken, undefined);
        assert.ok(r.json.description.includes(msg), r.json.description);
    } finally {
        fake.recusar('tv30_cliente_autoriza');
        console.error = errorOrig;
    }
    notStored(p.cid);
    assert.equal(manager.GetPendingClient(p.cid)?.hasPendingChallenge(), true);

    const ok = await tokenByChallenge(p);
    assert.equal(ok.status, 200);
    assert.ok(members('clients:authorized').includes(p.cid));
    expectError(await tokenByChallenge(p), 102);
});

test('refresh-token vazio ou so espacos: 105 sem credencial; o refresh token legitimo segue valendo', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    const first = await authorize(cid);
    assert.equal(first.status, 200);
    for (const v of ['', '%20%20', '%09', '+']) {
        const r = await getRaw('/token', `clientid=${cid}&refresh-token=${v}`);
        expectError(r, 105);
        assert.equal(r.json.accessToken, undefined, `refresh-token=${v}`);
    }
    const tok = await get('/token', { clientid: cid, 'refresh-token': first.json.refreshToken });
    assert.equal(tok.status, 200, JSON.stringify(tok.json));
    assert.equal(typeof tok.json.accessToken, 'string');
});

test('nao local com refresh-token ou challenge-response vazios: 105, sem pular o pareamento nem a exigencia de HTTPS', async () => {
    const p = await pairNonLocal('qrcode');
    for (const q of ['refresh-token=', 'refresh-token=%20', 'challenge-response=', 'challenge-response=%20', 'refresh-token=&challenge-response=']) {
        for (const h of [{}, HTTPS]) {
            const r = await getRaw('/token', `clientid=${p.cid}&${q}`, h);
            expectError(r, 105);
            assert.equal(r.json.accessToken, undefined, q);
        }
    }
    // The pairing stays open: the solution of the challenge concludes it.
    const ok = await tokenByChallenge(p);
    assert.equal(ok.status, 200);
    assert.match(ok.type, /application\/octet-stream/);
    assert.equal(typeof JSON.parse(aes(false, p.secret, ok.raw).toString('utf8')).accessToken, 'string');
});

test('clientid vazio ou so espacos em /tv3/token: 105', async () => {
    for (const v of ['', '%20']) {
        expectError(await getRaw('/token', `clientid=${v}&refresh-token=x`), 105);
        expectError(await getRaw('/token', `clientid=${v}&challenge-response=x`), 105);
    }
});

test('/tv3/authorize com clientid, display-name ou key vazios: 105, sem pop-up e sem autorizar', async () => {
    viewerAnswer = true;
    const cases = [
        'clientid=&display-name=x',
        'clientid=%20&display-name=x',
        `clientid=${randomUUID()}&display-name=`,
        `clientid=${randomUUID()}&display-name=%20%20`,
        `clientid=${randomUUID()}&display-name=x&pm=kex&key=`,
        `clientid=${randomUUID()}&display-name=x&pm=kex&key=%20`,
    ];
    for (const q of cases) {
        let r: Awaited<ReturnType<typeof getRaw>> | undefined;
        assert.equal(await popUpsDuring(async () => { r = await getRaw('/authorize', q); }), 0, q);
        expectError(r!, 105);
    }
    assert.ok(!members('clients:authorized').includes(''));
    assert.ok(!members('clients:authorized').includes(' '));
});

test('/tv3/authorize com pm vazio: vale como ausente, e o cliente se classifica local', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    const r = await getRaw('/authorize', `clientid=${cid}&display-name=x&pm=`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(typeof r.json.refreshToken, 'string');
    assert.equal((store.get(`client:${cid}`) as Record<string, string>).class, 'local-autonomous');
});

for (const pm of ['qrcode', 'kex'] as const) {
    test(`pm=${pm}: challenge-response repetido depois do sucesso: 102 sem credencial nova; o refresh token emitido segue valendo`, async () => {
        const p = await pairNonLocal(pm);
        const first = await tokenByChallenge(p);
        assert.equal(first.status, 200);
        const body = JSON.parse(aes(false, p.secret, first.raw).toString('utf8'));

        // The pairing material left the client.
        const client = await manager.GetAuthorizedClient(p.cid);
        assert.equal(client.hasPendingChallenge(), false);
        assert.equal(client.getSecret(), undefined);
        assert.equal(client.getChallenge(), undefined);
        if (pm === 'kex') assert.throws(() => client.getECDHPublicKey(), /no ECDH key pair/);

        // The repetition, over HTTP and over HTTPS.
        for (const h of [{}, HTTPS]) {
            const again = await tokenByChallenge(p, h);
            expectError(again, 102);
            assert.equal(again.json.accessToken, undefined);
        }
        // And the refresh token of the first response was not rotated by it.
        const renew = await getRaw('/token', `clientid=${p.cid}&refresh-token=${body.refreshToken}`, HTTPS);
        assert.equal(renew.status, 200, JSON.stringify(renew.json));
        assert.equal(typeof renew.json.accessToken, 'string');
    });
}

test('cliente local com challenge-response: 102, nao ha challenge pendente', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    assert.equal((await authorize(cid)).status, 200);
    expectError(await getRaw('/token', `clientid=${cid}&challenge-response=${randomBytes(32).toString('base64url')}`), 102);
});

test('dois /tv3/token simultaneos com o mesmo challenge-response: so um emite credencial', async () => {
    const p = await pairNonLocal('qrcode');
    // A slow write to storage: the second /tv3/token is checked while the
    // first one still issues the credential.
    const call = fakeRedis.call;
    fakeRedis.call = async (...a: unknown[]) => { await new Promise(r => setTimeout(r, 50)); return call(...a); };
    try {
        const rs = await Promise.all([tokenByChallenge(p), tokenByChallenge(p)]);
        assert.deepEqual(rs.map(r => r.status).sort(), [200, 404]);
        expectError(rs.find(r => r.status === 404)!, 102);
    } finally {
        fakeRedis.call = call;
    }
});

test('emissao falha depois do desafio conferido: o material volta, o mesmo challenge-response conclui e depois nao vale mais', async () => {
    const p = await pairNonLocal('qrcode');
    fake.recusar('tv30_cliente_grava', 'TV30ESQUEMA tv30_cliente_grava: recusa de teste');
    const errorOrig = console.error;
    console.error = () => undefined;
    try {
        expectError(await tokenByChallenge(p), 200);
    } finally {
        fake.recusar('tv30_cliente_grava');
        console.error = errorOrig;
    }
    assert.equal((await tokenByChallenge(p)).status, 200);
    expectError(await tokenByChallenge(p), 102);
});

// --- secret comparison: bytes, crypto.timingSafeEqual, different length
// fails ---
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ClientClass = require('../src/modules/auth-manager/client').default as typeof import('../src/modules/auth-manager/client').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cryptoModule = require('crypto') as typeof import('crypto');

// Counts the calls of crypto.timingSafeEqual during fn.
function timingSafeCalls(fn: () => void): number {
    const orig = cryptoModule.timingSafeEqual;
    let calls = 0;
    cryptoModule.timingSafeEqual = ((a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { calls++; return orig(a, b); }) as typeof orig;
    try { fn(); } finally { cryptoModule.timingSafeEqual = orig; }
    return calls;
}

test('Client.validateRefreshToken: igual vale, diferente ou de outro tamanho nao (sem lancar), lista nao; tempo constante', () => {
    const c = new ClientClass(randomUUID());
    const rt = c.getRefreshToken();
    // Same length.
    const other = rt.slice(0, -1) + (rt.endsWith('A') ? 'B' : 'A');
    let r: boolean[] = [];
    const calls = timingSafeCalls(() => { r = [c.validateRefreshToken(rt), c.validateRefreshToken(other)]; });
    assert.deepEqual(r, [true, false]);
    assert.equal(calls, 2, 'as duas comparacoes de mesmo tamanho passam por crypto.timingSafeEqual');
    assert.equal(c.validateRefreshToken(rt + 'x'), false);
    assert.equal(c.validateRefreshToken(''), false);
    assert.equal(c.validateRefreshToken('x'), false);
    assert.equal(c.validateRefreshToken([rt] as unknown as string), false);
    assert.equal(c.validateRefreshToken(undefined as unknown as string), false);
});

test('Client.validateChallenge: compara bytes; tamanho diferente ou sem challenge e falha; tempo constante', () => {
    const c = new ClientClass(randomUUID(), 'non-local');
    const h = sha(randomBytes(16));
    assert.equal(c.validateChallenge(Buffer.from(h)), false, 'sem challenge guardado');
    c.setChallenge(Buffer.from(h));
    let ok = false;
    assert.equal(timingSafeCalls(() => { ok = c.validateChallenge(Buffer.from(h)); }), 1);
    assert.equal(ok, true);
    const flipped = Buffer.from(h); flipped[31] ^= 1;
    assert.equal(c.validateChallenge(flipped), false);
    assert.equal(c.validateChallenge(h.subarray(0, 16)), false);
    assert.equal(c.validateChallenge(Buffer.concat([h, Buffer.from([0])])), false);
    assert.equal(c.validateChallenge(Buffer.alloc(0)), false);
});

test('challenge-response com bytes diferentes que dao o mesmo texto UTF-8: 102; a resposta certa conclui depois', async () => {
    // Looks for a challenge whose hash has a byte from 0xF8 to 0xFF (never
    // valid UTF-8: it becomes U+FFFD alone); replacing that byte by another of
    // the same range does not change the .toString() (P = 1 - (248/256)^32
    // ~ 0.64 per challenge).
    let p: NonLocal | undefined;
    let i = -1;
    for (let tries = 0; tries < 40 && i < 0; tries++) {
        // Each attempt leaves the QR code of the previous one on screen (103):
        // frees the layer for the next.
        _camadaParaTestes.limpar();
        p = await pairNonLocal('qrcode');
        i = sha(p.plain).findIndex(b => b >= 0xf8);
    }
    assert.ok(p && i >= 0, 'nenhum desafio com byte 0xF8-0xFF em 40 tentativas');
    const h = sha(p!.plain);
    const forged = Buffer.from(h);
    forged[i] = h[i] === 0xff ? 0xfe : 0xff;
    assert.notDeepEqual(forged, h);
    assert.equal(forged.toString(), h.toString(), 'precondicao: o mesmo texto UTF-8 (uma comparacao por .toString() aceitaria)');
    const forgedCr = aes(true, p!.secret, forged).toString('base64url');
    const r = await getRaw('/token', `clientid=${p!.cid}&challenge-response=${forgedCr}`);
    expectError(r, 102);
    assert.equal(r.json.accessToken, undefined);
    // The pairing stays open: the right solution concludes it.
    const ok = await tokenByChallenge(p!);
    assert.equal(ok.status, 200);
    assert.equal(typeof JSON.parse(aes(false, p!.secret, ok.raw).toString('utf8')).accessToken, 'string');
});

test('challenge-response que decifra para outro tamanho: 102, e nao 404 {error:200} de excecao', async () => {
    const p = await pairNonLocal('kex');
    const h = sha(p.plain);
    for (const wrong of [h.subarray(0, 16), Buffer.concat([h, Buffer.from('x')]), Buffer.alloc(0)]) {
        const cr = aes(true, p.secret, wrong).toString('base64url');
        expectError(await getRaw('/token', `clientid=${p.cid}&challenge-response=${cr}`), 102);
    }
    assert.equal((await tokenByChallenge(p)).status, 200);
});

test('refresh-token de outro tamanho ou repetido: 101, e o legitimo segue valendo', async () => {
    viewerAnswer = true;
    const cid = randomUUID();
    const first = await authorize(cid);
    assert.equal(first.status, 200);
    const rt = first.json.refreshToken as string;
    for (const q of ['refresh-token=x', `refresh-token=${rt}x`, `refresh-token=${rt.slice(0, -1)}`, `refresh-token=${rt}&refresh-token=${rt}`]) {
        expectError(await getRaw('/token', `clientid=${cid}&${q}`), 101);
    }
    const ok = await getRaw('/token', `clientid=${cid}&refresh-token=${rt}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

// --- a challenge-response that does not decrypt (invalid block or PKCS#7
// padding, list) ---
// 102 with the same response as a wrong hash (Table C.4), no credential, and
// the attempt stays open.
const aesRaw = (k: Buffer, d: Buffer) => {
    const c = createCipheriv('aes-128-ecb', k, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(d), c.final()]);
};

for (const pm of ['qrcode', 'kex'] as const) {
    test(`pm=${pm}: challenge-response que nao decifra ou repetido: 102 igual ao do hash errado, sem credencial; a solucao certa conclui depois`, async () => {
        const p = await pairNonLocal(pm);
        const b64 = (b: Buffer) => b.toString('base64url');
        const lastByte = (v: number) => { const b = randomBytes(32); b[31] = v; return b; };
        const malformed: [string, string][] = [
            ['15 bytes (nao e multiplo de 16)', b64(randomBytes(15))],
            ['33 bytes', b64(Buffer.concat([Buffer.from(p.cr, 'base64url'), Buffer.from([0])]))],
            ['1 byte', b64(Buffer.from([7]))],
            ['padding 0x00', b64(aesRaw(p.secret, lastByte(0x00)))],
            ['padding 0x11 (maior que o bloco)', b64(aesRaw(p.secret, lastByte(0x11)))],
            ['padding 0x02 com o penultimo byte errado', b64(aesRaw(p.secret, (() => { const b = lastByte(0x02); b[30] = 0x05; return b; })()))],
            ['so caracteres fora do base64 (decodifica vazio)', '!!!!'],
            ['repetido (lista)', `${p.cr}&challenge-response=${p.cr}`],
        ];
        // Reference: a wrong hash well encrypted.
        const wrongHash = await getRaw('/token', `clientid=${p.cid}&challenge-response=${b64(aes(true, p.secret, sha(randomBytes(16))))}`);
        expectError(wrongHash, 102);
        for (const [what, cr] of malformed) {
            for (const h of [{}, HTTPS]) {
                const r = await getRaw('/token', `clientid=${p.cid}&challenge-response=${cr}`, h);
                expectError(r, 102);
                assert.deepEqual(r.json, wrongHash.json, `${what}: mesma resposta do hash errado`);
                assert.equal(r.json.accessToken, undefined, what);
            }
        }
        // The pairing stays open: the right solution concludes it (once).
        assert.equal(manager.GetPendingClient(p.cid)?.hasPendingChallenge(), true);
        const ok = await tokenByChallenge(p);
        assert.equal(ok.status, 200);
        assert.equal(typeof JSON.parse(aes(false, p.secret, ok.raw).toString('utf8')).accessToken, 'string');
        expectError(await tokenByChallenge(p), 102);
    });
}
