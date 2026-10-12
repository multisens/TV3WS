// Pop-up do QR code e do PIN do pareamento do cliente nao local (C.4.3.2,
// C.4.3.3). Correcao de 12/10 (spec-1210-defeitos, item 1): o pop-up sai com
// o prazo da trava de seguranca (PAIRING_POPUP_TIMEOUT_MS, 120 s; antes 1 s)
// e fica na tela ate o /tv3/token que confere a solucao do desafio (C.6.1.3)
// com sucesso; nessa hora o tv3ws publica {"close":true} no MESMO topico do
// pop-up. /tv3/token que falha nao fecha. Router real de
// client-identification com o core REAL (o que sai no MQTT e o que a camada
// grafica recebe) e redis-client e mqtt-client trocados por dubles. O duble
// do broker responde "true" ao pop-up sim/nao no lugar do espectador.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { randomUUID, randomBytes, createECDH, createHash, createCipheriv, createDecipheriv } from 'crypto';
import express from 'express';
import { createFakeRedis } from './helpers/fake-redis';
import { createFakeMqtt, TOPICS } from './helpers/fake-mqtt';

// --- dubles ------------------------------------------------------------------
const fake = createFakeRedis();
const mqtt = createFakeMqtt();

const QR = 'aop/display/layers/popup/qrcode';
const PIN = 'aop/display/layers/popup/pin';
const YESNO = 'aop/display/layers/popup/yesno';
const CLOSE = '{"close":true}';

// Cliente MQTT do core: guarda o que foi publicado e, como o espectador,
// responde ao pop-up sim/nao (o core assina yesno/response e espera a
// mensagem pelo evento 'message').
const published: [string, string][] = [];
let onMessage: ((t: string, m: Buffer) => void) | undefined;
const mqttClientRaw = {
    on(ev: string, h: (t: string, m: Buffer) => void) { if (ev === 'message') onMessage = h; },
    subscribe() { /* sem broker */ },
    unsubscribe() { /* sem broker */ },
    publish(t: string, m: string) {
        published.push([t, m]);
        if (t === `${YESNO}/message`) setImmediate(() => onMessage?.(`${YESNO}/response`, Buffer.from('true')));
    },
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
stub('mqtt-client', { default: mqtt.mqttClient, TOPICS, client: mqttClientRaw });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/api/client-identification').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PAIRING_POPUP_TIMEOUT_MS } = require('../src/api/client-identification/service') as typeof import('../src/api/client-identification/service');
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

// --- cliente nao local (cripto da Tabela C.4 e da C.6.1.2.2) --------------------
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const aes = (enc: boolean, k: Buffer, d: Buffer) => {
    const c = enc ? createCipheriv('aes-128-ecb', k, null) : createDecipheriv('aes-128-ecb', k, null);
    return Buffer.concat([c.update(d), c.final()]);
};

// Publicacoes num topico a partir de um indice de `published`.
const on = (topic: string, from = 0) => published.slice(from).filter(([t]) => t === topic).map(([, m]) => m);

type Pairing = { cid: string; secret: Buffer; challenge: string; opened: string };

// /tv3/authorize de cliente nao local. Devolve o segredo que o aplicativo
// obtem do QR code (C.4.3.2) ou da chave ECDH (C.4.3.3) e a mensagem de
// abertura do pop-up que o tv3ws publicou.
async function authorize(pm: 'qrcode' | 'kex'): Promise<Pairing> {
    const cid = randomUUID();
    const from = published.length;
    const q: Record<string, string> = { clientid: cid, 'display-name': 'teste-pareamento', pm };
    const ecdh = createECDH('prime256v1');
    if (pm === 'kex') {
        ecdh.generateKeys();
        q.key = ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
    }
    const res = await fetch(`${base}/authorize?${new URLSearchParams(q)}`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const opened = on(pm === 'qrcode' ? QR : PIN, from);
    assert.equal(opened.length, 1, `uma abertura do pop-up: ${JSON.stringify(opened)}`);
    let secret: Buffer;
    if (pm === 'qrcode') {
        secret = sha(Buffer.from(JSON.parse(opened[0]).value, 'base64url')).subarray(0, 16);
    } else {
        secret = sha(ecdh.computeSecret(Buffer.from(body.key, 'base64url'))).subarray(0, 16);
    }
    return { cid, secret, challenge: body.challenge, opened: opened[0] };
}

// challenge-response da Tabela C.4 (certo, ou com o hash de outro texto)
function challengeResponse(p: Pairing, wrong = false): string {
    const plain = aes(false, p.secret, Buffer.from(p.challenge, 'base64url'));
    return aes(true, p.secret, sha(wrong ? randomBytes(16) : plain)).toString('base64url');
}

async function token(cid: string, cr: string) {
    const res = await fetch(`${base}/token?${new URLSearchParams({ clientid: cid, 'challenge-response': cr })}`);
    const type = res.headers.get('content-type') ?? '';
    const raw = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type, json: /json/.test(type) ? JSON.parse(raw.toString('utf8')) : undefined };
}
const expectError = (r: { status: number; json: any }, code: number) => {
    assert.equal(r.status, 404);
    assert.equal(r.json?.error, code, JSON.stringify(r.json));
};

// --- casos -----------------------------------------------------------------------
test('o prazo da trava de seguranca e 120 s', () => {
    assert.equal(PAIRING_POPUP_TIMEOUT_MS, 120000);
});

test('pm=qrcode: o QR code sai com o prazo de 120 s, fica nos /token que falham e fecha no sucesso', async () => {
    const p = await authorize('qrcode');
    const open = JSON.parse(p.opened);
    assert.equal(typeof open.value, 'string');
    assert.equal(open.timeout, PAIRING_POPUP_TIMEOUT_MS, `prazo antigo era 1000 ms: ${p.opened}`);
    assert.equal(open.close, undefined);

    const from = published.length;
    // solucao errada: 102 (Tabela C.4), pareamento nao concluido
    expectError(await token(p.cid, challengeResponse(p, true)), 102);
    // challenge-response ilegivel (chave errada, padding invalido): 102 desde
    // a rodada spec-1210-defeitos3 (item 3; era 404 {error:200}, da excecao)
    const errorOrig = console.error;
    console.error = () => undefined;
    try {
        expectError(await token(p.cid, randomBytes(32).toString('base64url')), 102);
    } finally {
        console.error = errorOrig;
    }
    assert.deepEqual(on(QR, from), [], '/token que falha nao fecha o pop-up');

    const ok = await token(p.cid, challengeResponse(p));
    assert.equal(ok.status, 200);
    assert.match(ok.type, /application\/octet-stream/);
    assert.deepEqual(on(QR, from), [CLOSE], 'fechamento no mesmo topico, uma vez');
    assert.deepEqual(on(PIN, from), [], 'o pop-up do PIN nao e tocado');
});

test('pm=kex: o PIN sai com o prazo de 120 s e fecha no sucesso do /token', async () => {
    const p = await authorize('kex');
    const open = JSON.parse(p.opened);
    assert.match(open.value, /^\d{4}$/);
    assert.equal(open.timeout, PAIRING_POPUP_TIMEOUT_MS);

    const from = published.length;
    expectError(await token(p.cid, challengeResponse(p, true)), 102);
    assert.deepEqual(on(PIN, from), []);

    assert.equal((await token(p.cid, challengeResponse(p))).status, 200);
    assert.deepEqual(on(PIN, from), [CLOSE]);
    assert.deepEqual(on(QR, from), []);
});

test('abertura antes do fechamento, no mesmo topico', async () => {
    const from = published.length;
    const p = await authorize('qrcode');
    assert.equal((await token(p.cid, challengeResponse(p))).status, 200);
    assert.deepEqual(on(QR, from), [p.opened, CLOSE]);
});

test('pop-up substituido pelo de outro cliente: o fim do pareamento do primeiro nao fecha o do segundo', async () => {
    const a = await authorize('qrcode');
    const b = await authorize('qrcode');   // a camada grafica troca o QR code de A pelo de B
    const from = published.length;
    assert.equal((await token(a.cid, challengeResponse(a))).status, 200);
    assert.deepEqual(on(QR, from), [], 'A terminou, mas o QR code na tela e o de B');
    assert.equal((await token(b.cid, challengeResponse(b))).status, 200);
    assert.deepEqual(on(QR, from), [CLOSE]);
});

test('PIN de um cliente e QR code de outro: cada fim de pareamento fecha so o pop-up do seu tipo', async () => {
    const q = await authorize('qrcode');
    const k = await authorize('kex');
    const from = published.length;
    assert.equal((await token(k.cid, challengeResponse(k))).status, 200);
    assert.deepEqual(on(PIN, from), [CLOSE]);
    assert.deepEqual(on(QR, from), []);
    assert.equal((await token(q.cid, challengeResponse(q))).status, 200);
    assert.deepEqual(on(QR, from), [CLOSE]);
});

test('emissao da credencial falha depois do desafio conferido: sem fechamento (pareamento nao concluido)', async () => {
    const p = await authorize('qrcode');
    const from = published.length;
    const msg = 'TV30ESQUEMA tv30_cliente_grava: recusa de teste';
    fake.recusar('tv30_cliente_grava', msg);
    const errorOrig = console.error;
    console.error = () => undefined;
    try {
        expectError(await token(p.cid, challengeResponse(p)), 200);
    } finally {
        fake.recusar('tv30_cliente_grava');
        console.error = errorOrig;
    }
    assert.deepEqual(on(QR, from), [], 'a credencial nao saiu: o pop-up fica');
    // a tentativa segue aberta (PENDENTE (Joel) em service.ts): o sucesso fecha
    assert.equal((await token(p.cid, challengeResponse(p))).status, 200);
    assert.deepEqual(on(QR, from), [CLOSE]);
});

test('cliente local (refresh-token): /tv3/token nao publica fechamento de pop-up', async () => {
    const cid = randomUUID();
    const auth = await fetch(`${base}/authorize?${new URLSearchParams({ clientid: cid, 'display-name': 'teste-local' })}`);
    const { refreshToken } = await auth.json();
    assert.equal(typeof refreshToken, 'string');
    const from = published.length;
    const res = await fetch(`${base}/token?${new URLSearchParams({ clientid: cid, 'refresh-token': refreshToken })}`);
    assert.equal(res.status, 200);
    assert.deepEqual(on(QR, from), []);
    assert.deepEqual(on(PIN, from), []);
});
