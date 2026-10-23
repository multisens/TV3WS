// Pop-up do QR code e do PIN do pareamento nao local (C.4.3.2, C.4.3.3): sai com a trava de 120 s e fecha
// ({"close":true} no mesmo topico) no /tv3/token que confere o desafio. Com um pop-up de autorizacao na tela,
// /tv3/authorize novo recebe 103 (C.4.2.3; Tabela C.3). Router e core reais; Redis e MQTT por dubles.
import { test, before, after, beforeEach } from 'node:test';
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
// resposta do "espectador" ao sim/nao: 'true', 'false' ou null (segura a
// resposta ate o caso chamar responderSimNao)
let respostaSimNao: 'true' | 'false' | null = 'true';
const responderSimNao = (v: 'true' | 'false') => onMessage?.(`${YESNO}/response`, Buffer.from(v));
const mqttClientRaw = {
    on(ev: string, h: (t: string, m: Buffer) => void) { if (ev === 'message') onMessage = h; },
    subscribe() { /* sem broker */ },
    unsubscribe() { /* sem broker */ },
    publish(t: string, m: string) {
        published.push([t, m]);
        const v = respostaSimNao;
        if (t === `${YESNO}/message` && v !== null) setImmediate(() => responderSimNao(v));
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
const { PAIRING_POPUP_TIMEOUT_MS, _camadaParaTestes } = require('../src/api/client-identification/service') as typeof import('../src/api/client-identification/service');
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
// cada caso comeca com a camada grafica livre, o relogio real e o espectador
// respondendo "sim"
beforeEach(() => {
    _camadaParaTestes.limpar();
    _camadaParaTestes.relogio();
    respostaSimNao = 'true';
});

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

// /tv3/authorize cru, sem conferir nada (para os casos de erro)
async function authorizeRaw(q: Record<string, string>) {
    const res = await fetch(`${base}/authorize?${new URLSearchParams(q)}`);
    return { status: res.status, json: await res.json() as any };
}
const novoLocal = () => ({ clientid: randomUUID(), 'display-name': 'teste-camada' });
const novoNaoLocal = () => ({ ...novoLocal(), pm: 'qrcode' });

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
    assert.equal(open.timeout, PAIRING_POPUP_TIMEOUT_MS, p.opened);
    assert.equal(open.close, undefined);

    const from = published.length;
    // solucao errada: 102 (Tabela C.4), pareamento nao concluido
    expectError(await token(p.cid, challengeResponse(p, true)), 102);
    // challenge-response ilegivel (chave errada, padding invalido): 102
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

test('103 com o QR code de A na tela: B (nao local ou local) recebe 103 na hora, sem pop-up; o sucesso de A libera a camada', async () => {
    const a = await authorize('qrcode');
    const from = published.length;
    expectError(await authorizeRaw(novoNaoLocal()), 103);
    expectError(await authorizeRaw(novoLocal()), 103);
    assert.deepEqual(on(`${YESNO}/message`, from), [], 'nenhum sim/nao novo');
    assert.deepEqual(on(QR, from), [], 'o QR code de A fica na tela');
    assert.equal((await token(a.cid, challengeResponse(a))).status, 200);
    assert.deepEqual(on(QR, from), [CLOSE]);
    // camada livre: o PIN de outro cliente sai e fecha no sucesso dele
    const k = await authorize('kex');
    assert.equal((await token(k.cid, challengeResponse(k))).status, 200);
    assert.deepEqual(on(PIN, from), [k.opened, CLOSE]);
});

test('103 com o PIN de B na tela; o reuso do clientid de A, pareado, segue dando 101 (o 101 vem antes do 103)', async () => {
    const a = await authorize('qrcode');
    assert.equal((await token(a.cid, challengeResponse(a))).status, 200);
    const b = await authorize('kex');
    const from = published.length;
    expectError(await authorizeRaw(novoNaoLocal()), 103);
    expectError(await authorizeRaw({ clientid: a.cid, 'display-name': 'teste-camada', pm: 'qrcode' }), 101);
    assert.deepEqual(on(`${YESNO}/message`, from), []);
    assert.equal((await token(b.cid, challengeResponse(b))).status, 200);
    assert.deepEqual(on(PIN, from), [CLOSE]);
    assert.equal(_camadaParaTestes.ocupacao(), undefined, 'camada livre depois do sucesso');
});

test('PIN de A na tela: novo /tv3/authorize de A descarta a tentativa pendente e recebe 103, sem sim/nao; o desafio anterior da 102', async () => {
    const a = await authorize('kex');
    const from = published.length;
    expectError(await authorizeRaw({ clientid: a.cid, 'display-name': 'teste-camada', pm: 'qrcode' }), 103);
    assert.deepEqual(on(`${YESNO}/message`, from), []);
    expectError(await token(a.cid, challengeResponse(a)), 102);
});

test('depois da trava, novo /tv3/authorize de A sem pareamento concluido abre o sim/nao e um QR code novo; o desafio anterior da 102', async () => {
    let agora = Date.now();
    _camadaParaTestes.relogio(() => agora);
    const a = await authorize('qrcode');
    agora += PAIRING_POPUP_TIMEOUT_MS;
    const from = published.length;
    const r = await authorizeRaw({ clientid: a.cid, 'display-name': 'teste-camada', pm: 'qrcode' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(on(`${YESNO}/message`, from).length, 1, 'o sim/nao de novo');
    assert.equal(on(QR, from).length, 1, 'um QR code novo');
    expectError(await token(a.cid, challengeResponse(a)), 102);
});

for (const funcao of ['tv30_cliente_autoriza', 'tv30_cliente_grava']) {
    test(`${funcao} recusada no /tv3/token depois do desafio conferido: sem fechamento (pareamento nao concluido)`, async () => {
        const p = await authorize('qrcode');
        const from = published.length;
        fake.recusar(funcao, `TV30ESQUEMA ${funcao}: recusa de teste`);
        const errorOrig = console.error;
        console.error = () => undefined;
        try {
            expectError(await token(p.cid, challengeResponse(p)), 200);
        } finally {
            fake.recusar(funcao);
            console.error = errorOrig;
        }
        assert.deepEqual(on(QR, from), [], 'a credencial nao saiu: o pop-up fica');
        // a tentativa segue aberta: o sucesso fecha
        assert.equal((await token(p.cid, challengeResponse(p))).status, 200);
        assert.deepEqual(on(QR, from), [CLOSE]);
    });
}

test('103 com o sim/nao de um pedido esperando resposta: outro cliente e o MESMO clientid recebem 103; o primeiro recebe a resposta do espectador', async () => {
    respostaSimNao = null;
    const cid = randomUUID();
    const from = published.length;
    const primeiro = authorizeRaw({ clientid: cid, 'display-name': 'teste-camada' });
    for (let i = 0; i < 100 && on(`${YESNO}/message`, from).length === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(on(`${YESNO}/message`, from).length, 1, 'o sim/nao do primeiro na tela');
    expectError(await authorizeRaw(novoLocal()), 103);
    expectError(await authorizeRaw(novoNaoLocal()), 103);
    // o mesmo clientid ao mesmo tempo tambem recebe 103
    expectError(await authorizeRaw({ clientid: cid, 'display-name': 'teste-camada' }), 103);
    assert.equal(on(`${YESNO}/message`, from).length, 1, 'um sim/nao so');
    responderSimNao('true');
    const r = await primeiro;
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(typeof r.json.refreshToken, 'string');
    // o 103 do segundo pedido com o mesmo clientid nao liberou a reserva do
    // primeiro nem estragou a autorizacao dele; a camada esta livre
    assert.equal(_camadaParaTestes.ocupacao(), undefined);
    respostaSimNao = 'true';
    assert.equal((await authorizeRaw(novoLocal())).status, 200);
});

test('a recusa no sim/nao libera a camada', async () => {
    respostaSimNao = 'false';
    expectError(await authorizeRaw(novoLocal()), 102);
    assert.equal(_camadaParaTestes.ocupacao(), undefined);
    respostaSimNao = 'true';
    assert.equal((await authorizeRaw(novoLocal())).status, 200);
});

test('erro depois da reserva (gravacao recusada pela funcao do Redis) libera a camada', async () => {
    const msg = 'TV30ESQUEMA tv30_cliente_autoriza: recusa de teste';
    fake.recusar('tv30_cliente_autoriza', msg);
    const errorOrig = console.error;
    console.error = () => undefined;
    try {
        expectError(await authorizeRaw(novoLocal()), 200);
    } finally {
        fake.recusar('tv30_cliente_autoriza');
        console.error = errorOrig;
    }
    assert.equal(_camadaParaTestes.ocupacao(), undefined);
    assert.equal((await authorizeRaw(novoLocal())).status, 200);
});

test('a trava de 120 s libera a camada; o sucesso tardio de A nao fecha o QR code de B', async () => {
    let agora = Date.now();
    _camadaParaTestes.relogio(() => agora);
    const a = await authorize('qrcode');
    expectError(await authorizeRaw(novoNaoLocal()), 103);
    agora += PAIRING_POPUP_TIMEOUT_MS;   // a camada grafica fechou o QR code de A
    const b = await authorize('qrcode');
    const from = published.length;
    // o desafio de A continua valendo depois da trava, mas o QR code na tela e o de B
    assert.equal((await token(a.cid, challengeResponse(a))).status, 200);
    assert.deepEqual(on(QR, from), [], 'o fim de A depois da trava nao fecha o pop-up de B');
    assert.equal((await token(b.cid, challengeResponse(b))).status, 200);
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
