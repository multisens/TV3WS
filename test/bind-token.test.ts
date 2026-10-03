// Teste de unidade da logica pura do bind-token (C.4.1.3, C.4.1.4, C.6.8):
// parse de chave RSA, checagem do corpo do registro e validacao nas quatro
// frentes. Sem Redis, sem rede. Rodar: npm test (em tv3ws/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, KeyObject } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import {
    BindKeyEntry, checkRegistration, checkTimeClaims, decodeBindToken, evaluateBindToken,
    parseBindKey, parseRsaPublicKey, parseStoredEntry, sameKey, sameRegisteredKey,
} from '../src/api/broadcaster-security/bind-token';

// --- material de teste ---------------------------------------------------
// 512 bits: o tamanho do exemplo da norma ("MIIBOgIBAAJB..."); so cabe RS256
// (RS512 nao cabe em modulo de 512 bits). RS512 usa chave de 2048.
const rsa512 = generateKeyPairSync('rsa', { modulusLength: 512 });
const rsa2048 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const pem = (k: KeyObject, type: 'spki' | 'pkcs1' | 'pkcs8') =>
    k.export({ format: 'pem', type: type as any }).toString();
const b64der = (k: KeyObject, type: 'spki' | 'pkcs1' | 'pkcs8') =>
    (k.export({ format: 'der', type: type as any }) as Buffer).toString('base64');
const spkiDer = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }) as Buffer;

const NOW = 1_800_000_000; // relogio fixo (s)

function sign(payload: object, key: jwt.Secret, alg: jwt.Algorithm): string {
    return jwt.sign(payload, key, { algorithm: alg, allowInsecureKeySizes: true });
}

// Token montado a mao, para cabecalhos que o jsonwebtoken nao emite.
function rawToken(header: object, payload: object, signature = ''): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc(header)}.${enc(payload)}.${signature}`;
}

const entry = (alg: BindKeyEntry['alg'], key: string): BindKeyEntry => ({ alg, key, registeredAt: 0 });
const times = { iat: NOW - 10, nbf: NOW - 10, exp: NOW + 3600 };

// --- parse de chave RSA ----------------------------------------------------

test('RSA: aceita PEM publico SPKI e PKCS#1', () => {
    for (const text of [pem(rsa2048.publicKey, 'spki'), pem(rsa2048.publicKey, 'pkcs1')]) {
        const k = parseRsaPublicKey(text);
        assert.equal(k.asymmetricKeyType, 'rsa');
        assert.deepEqual(spkiDer(k), spkiDer(rsa2048.publicKey));
    }
});

test('RSA: aceita base64 de DER SPKI e PKCS#1 publico (com quebras de linha)', () => {
    for (const text of [b64der(rsa2048.publicKey, 'spki'), b64der(rsa2048.publicKey, 'pkcs1')]) {
        const wrapped = text.replace(/(.{64})/g, '$1\n');
        assert.deepEqual(spkiDer(parseRsaPublicKey(wrapped)), spkiDer(rsa2048.publicKey));
    }
});

test('RSA: chave PRIVADA (formato do exemplo da norma) vira a publica derivada', () => {
    const pkcs1 = b64der(rsa512.privateKey, 'pkcs1');
    // mesma estrutura do "MIIBOgIBAAJB..." da C.47: SEQUENCE com comprimento 0x01xx
    // (o comprimento varia com a chave sorteada: MIIBOg, MIIBOw, MIIBPA, MIIBPQ...),
    // versao 0 e modulo de 65 bytes (512 bits). Fixar "MIIBO" falhava ~1 vez em 2.
    assert.match(pkcs1, /^MIIB[A-Za-z0-9+/]{2}IBAAJB/);
    for (const text of [pkcs1, b64der(rsa512.privateKey, 'pkcs8'),
                        pem(rsa512.privateKey, 'pkcs1'), pem(rsa512.privateKey, 'pkcs8')]) {
        const k = parseRsaPublicKey(text);
        assert.equal(k.type, 'public');
        assert.deepEqual(spkiDer(k), spkiDer(rsa512.publicKey));
    }
});

test('RSA: recusa chave que nao e RSA ou nao parseia', () => {
    const encrypted = rsa512.privateKey.export({
        format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'x',
    }).toString();
    for (const bad of [pem(ec.publicKey, 'spki'), b64der(ec.publicKey, 'spki'), 'segredo qualquer',
                       'AAAA', '', '-----BEGIN PUBLIC KEY-----\nlixo\n-----END PUBLIC KEY-----', encrypted]) {
        assert.throws(() => parseRsaPublicKey(bad), Error, `deveria recusar: ${bad.slice(0, 30)}`);
    }
});

// Teste cruzado com a borda: o MESMO fixtures/keyformats.json esta em
// infra/edgegateway/plugin/testdata/ e e lido por keys_test.go. Chave que o
// registro aceitasse e a borda nao lesse daria 200 no POST e 108 em toda API.
test('RSA: formatos de chave iguais aos da borda (fixture cruzado)', () => {
    const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'keyformats.json'), 'utf8')) as {
        cases: Array<{ name: string; alg: string; ok: boolean; key: string }>;
    };
    assert.ok(fx.cases.length > 0);
    for (const c of fx.cases) {
        let accepted = true;
        try {
            parseRsaPublicKey(c.key);
        } catch {
            accepted = false;
        }
        assert.equal(accepted, c.ok, `${c.name}: esperado ${c.ok ? 'aceitar' : 'recusar'}`);
    }
});

test('parseBindKey: HS usa os bytes UTF-8 do segredo; HS vazio e RS invalido falham', () => {
    const k = parseBindKey('HS256', 'segredo');
    assert.equal(k.type, 'secret');
    assert.deepEqual(k.export(), Buffer.from('segredo', 'utf8'));
    assert.throws(() => parseBindKey('HS512', ''));
    assert.throws(() => parseBindKey('RS256', 'segredo'));
});

// --- corpo do registro (C.6.8.2 / Tabela C.47) -------------------------------

test('registro: 101 para corpo fora do formato, alg nao suportado ou chave incompativel', () => {
    const cases: unknown[] = [
        undefined, null, 'texto', [1, 2], 42,
        { alg: 'ES256', key: 'x' }, { alg: 'none', key: 'x' }, { alg: 'hs256', key: 'x' }, { alg: null, key: 'x' },
        { alg: 'HS256', key: 123 }, { alg: 'HS256', key: '' },
        { alg: 'RS256', key: 'segredo' }, { alg: 'RS512', key: pem(ec.publicKey, 'spki') },
        // modulo de 512 bits nao comporta o DigestInfo do SHA-512 (C.47: 101)
        { alg: 'RS512', key: b64der(rsa512.privateKey, 'pkcs1') },
    ];
    for (const body of cases) {
        const r = checkRegistration(body);
        assert.equal(r.ok, false, JSON.stringify(body));
        if (!r.ok) assert.equal(r.code, 101, JSON.stringify(body));
    }
});

test('registro: 105 quando falta alg ou key num objeto JSON', () => {
    const r1 = checkRegistration({});
    assert.deepEqual(r1, { ok: false, code: 105, detail: 'alg, key' });
    const r2 = checkRegistration({ alg: 'HS256' });
    assert.deepEqual(r2, { ok: false, code: 105, detail: 'key' });
    const r3 = checkRegistration({ key: 'k' });
    assert.deepEqual(r3, { ok: false, code: 105, detail: 'alg' });
});

test('registro: aceita os quatro algoritmos com chave compativel', () => {
    const ok: Array<[string, string]> = [
        ['HS256', 'segredo'], ['HS512', 'segredo'],
        ['RS256', b64der(rsa512.privateKey, 'pkcs1')], ['RS512', pem(rsa2048.publicKey, 'spki')],
    ];
    for (const [alg, key] of ok) {
        assert.deepEqual(checkRegistration({ alg, key }), { ok: true, alg, key });
    }
});

test('sameKey: mesma chave RSA em codificacoes diferentes; HS por texto aparado', () => {
    assert.ok(sameKey(pem(rsa2048.publicKey, 'spki'), b64der(rsa2048.publicKey, 'spki')));
    assert.ok(sameKey(b64der(rsa512.privateKey, 'pkcs1'), b64der(rsa512.publicKey, 'spki')));
    assert.ok(!sameKey(b64der(rsa512.publicKey, 'spki'), b64der(rsa2048.publicKey, 'spki')));
    assert.ok(sameKey('segredo', ' segredo '));
    assert.ok(!sameKey('segredo', 'segredo2'));
});

test('sameRegisteredKey: no registro, segredo HS so e duplicata se for identico', () => {
    // a verificacao usa os bytes sem trim: "s" e "s " sao segredos diferentes
    assert.ok(!sameRegisteredKey('HS256', 'segredo', 'segredo '));
    assert.ok(sameRegisteredKey('HS512', 'segredo', 'segredo'));
    assert.ok(sameRegisteredKey('RS256', pem(rsa2048.publicKey, 'spki'), b64der(rsa2048.publicKey, 'spki')));
});

test('parseStoredEntry: entrada valida e malformadas', () => {
    assert.deepEqual(parseStoredEntry('{"alg":"RS256","key":"k","registeredAt":5}'), { alg: 'RS256', key: 'k', registeredAt: 5 });
    assert.equal(parseStoredEntry('{"alg":"ES256","key":"k"}'), null);
    assert.equal(parseStoredEntry('{"alg":"HS256"}'), null);
    assert.equal(parseStoredEntry('nao-json'), null);
});

// --- validacao do bind-token (C.4.1.4) --------------------------------------

test('frente 1 (formato): nao-JWT e malformed', () => {
    const good = sign(times, 'segredo', 'HS256');
    for (const bad of ['', 'abc', 'a.b', `${good}.x.y`, 'e30.e30.', `!!.${good.split('.')[1]}.x`,
                       rawToken({ typ: 'JWT' }, times), // cabecalho sem alg
                       `${Buffer.from('[1]').toString('base64url')}.e30.x`]) {
        assert.equal(decodeBindToken(bad), null, bad);
        assert.deepEqual(evaluateBindToken(bad, new Map(), NOW), { kind: 'malformed' });
    }
    assert.ok(decodeBindToken(good));
});

test('frente 2 (assinatura): valida nos quatro algoritmos', () => {
    const cases: Array<[BindKeyEntry, string]> = [
        [entry('HS256', 'segredo-256'), sign(times, 'segredo-256', 'HS256')],
        [entry('HS512', 'segredo-512'), sign(times, 'segredo-512', 'HS512')],
        [entry('RS256', b64der(rsa512.privateKey, 'pkcs1')), sign(times, rsa512.privateKey, 'RS256')],
        [entry('RS512', pem(rsa2048.publicKey, 'spki')), sign(times, rsa2048.privateKey, 'RS512')],
    ];
    for (const [e, token] of cases) {
        assert.deepEqual(evaluateBindToken(token, new Map([['urn:a', [e]]]), NOW),
            { kind: 'valid', services: ['urn:a'] }, e.alg);
    }
});

test('frente 2: chave errada, alg diferente do registrado e alg none sao bad-signature', () => {
    const keys = new Map([['urn:a', [entry('HS256', 'segredo')]]]);
    assert.deepEqual(evaluateBindToken(sign(times, 'outro', 'HS256'), keys, NOW), { kind: 'bad-signature' });
    // mesmo segredo, mas registrado para HS512
    assert.deepEqual(evaluateBindToken(sign(times, 'segredo', 'HS256'),
        new Map([['urn:a', [entry('HS512', 'segredo')]]]), NOW), { kind: 'bad-signature' });
    // RS256 nao valida com a mesma chave registrada como RS512
    assert.deepEqual(evaluateBindToken(sign(times, rsa2048.privateKey, 'RS256'),
        new Map([['urn:a', [entry('RS512', pem(rsa2048.publicKey, 'spki'))]]]), NOW), { kind: 'bad-signature' });
    // sem assinatura (C.4.1.4.8)
    assert.deepEqual(evaluateBindToken(rawToken({ alg: 'none', typ: 'JWT' }, times), keys, NOW), { kind: 'bad-signature' });
    // nenhuma chave registrada
    assert.deepEqual(evaluateBindToken(sign(times, 'segredo', 'HS256'), new Map(), NOW), { kind: 'bad-signature' });
});

test('frente 2: confusao de algoritmo (HS256 assinado com a chave publica RSA) e recusada', () => {
    const pubPem = pem(rsa2048.publicKey, 'spki');
    const header = { alg: 'HS256', typ: 'JWT' };
    const unsigned = rawToken(header, times).slice(0, -1); // "h.p"
    const forged = `${unsigned}.${createHmac('sha256', pubPem).update(unsigned).digest('base64url')}`;
    const keys = new Map([['urn:a', [entry('RS256', pubPem)]]]);
    assert.deepEqual(evaluateBindToken(forged, keys, NOW), { kind: 'bad-signature' });
});

test('isolamento: o token so vale para o servico cuja chave o assina; lista com rotacao', () => {
    const keys = new Map<string, BindKeyEntry[]>([
        ['urn:a', [entry('HS256', 'segredo-a')]],
        ['urn:b', [entry('HS256', 'antigo-b'), entry('RS256', b64der(rsa512.privateKey, 'pkcs1')), entry('HS256', 'novo-b')]],
    ]);
    assert.deepEqual(evaluateBindToken(sign(times, 'novo-b', 'HS256'), keys, NOW), { kind: 'valid', services: ['urn:b'] });
    assert.deepEqual(evaluateBindToken(sign(times, rsa512.privateKey, 'RS256'), keys, NOW), { kind: 'valid', services: ['urn:b'] });
    assert.deepEqual(evaluateBindToken(sign(times, 'segredo-a', 'HS256'), keys, NOW), { kind: 'valid', services: ['urn:a'] });
});

test('entrada com chave ilegivel no Redis e ignorada sem impedir as outras', () => {
    const keys = new Map([['urn:a', [entry('RS256', 'lixo'), entry('HS256', 'segredo')]]]);
    assert.deepEqual(evaluateBindToken(sign(times, 'segredo', 'HS256'), keys, NOW), { kind: 'valid', services: ['urn:a'] });
});

test('frentes 3 e 4 (nbf/exp e iat) com relogio fixo', () => {
    const v = (p: object) => checkTimeClaims(p as Record<string, unknown>, NOW).ok;
    assert.equal(v({}), true);                       // claims ausentes: "should" na norma
    assert.equal(v({ exp: NOW + 1 }), true);
    assert.equal(v({ exp: NOW }), false);            // invalido A PARTIR do instante (C.4.1.4.3)
    assert.equal(v({ exp: NOW - 1 }), false);
    assert.equal(v({ nbf: NOW }), true);
    assert.equal(v({ nbf: NOW + 1 }), false);        // so vale depois do instante (C.4.1.4.4)
    assert.equal(v({ iat: NOW }), true);
    assert.equal(v({ iat: NOW + 1 }), false);        // emitido no futuro (C.4.1.4.5)
    assert.equal(v({ exp: 'amanha' }), false);
    assert.equal(v({ nbf: null }), false);
});

test('ordem das frentes: assinatura antes do tempo; tempo invalido com assinatura valida e bad-time', () => {
    const keys = new Map([['urn:a', [entry('HS256', 'segredo')]]]);
    const expired = { ...times, exp: NOW - 1 };
    assert.deepEqual(evaluateBindToken(sign(expired, 'outro', 'HS256'), keys, NOW), { kind: 'bad-signature' });
    const r = evaluateBindToken(sign(expired, 'segredo', 'HS256'), keys, NOW);
    assert.equal(r.kind, 'bad-time');
    const future = evaluateBindToken(sign({ ...times, nbf: NOW + 60 }, 'segredo', 'HS256'), keys, NOW);
    assert.equal(future.kind, 'bad-time');
    const iatFuture = evaluateBindToken(sign({ ...times, iat: NOW + 60 }, 'segredo', 'HS256'), keys, NOW);
    assert.equal(iatFuture.kind, 'bad-time');
});
