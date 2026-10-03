import { createPrivateKey, createPublicKey, createSecretKey, KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';

// Logica pura do bind-token (C.4.1.3, C.4.1.4, C.6.8): sem Redis, sem
// Express — so cripto e regras, para ser testavel isoladamente
// (test/bind-token.test.ts). O acesso ao armazenamento fica em service.ts.

// Algoritmos que a norma manda suportar na validacao (C.4.1.4.8): HMAC
// (HS256/HS512, simetricos) e RSA PKCS#1 v1.5 (RS256/RS512, assimetricos).
// Qualquer outro, inclusive "none", e invalido.
export const BIND_ALGS = ['HS256', 'HS512', 'RS256', 'RS512'] as const;
export type BindAlg = typeof BIND_ALGS[number];

// Uma entrada da LIST bind-context:{serviceId} no Redis, gravada pelo
// registro C.6.8.2. "key" e a string recebida, sem transformacao (a borda
// parseia a mesma string com as mesmas regras).
export type BindKeyEntry = {
    alg: BindAlg;
    key: string;
    registeredAt: number; // ms
};

export function isBindAlg(value: unknown): value is BindAlg {
    return typeof value === 'string' && (BIND_ALGS as readonly string[]).includes(value);
}

function isHmac(alg: BindAlg): boolean {
    return alg === 'HS256' || alg === 'HS512';
}

// --- codificacao da chave -------------------------------------------------
// A norma nao diz como a chave e codificada nem tem identificador de chave
// (kid). DECISAO DE IMPLEMENTACAO (registrada na especificacao da semana de
// 28/09):
//   - HS256/HS512: "key" e o segredo, bytes UTF-8 da string, sem trim;
//   - RS256/RS512: PEM ("PUBLIC KEY", "RSA PUBLIC KEY" ou chave privada) ou
//     base64 de DER (SPKI, PKCS#1 publico, PKCS#1 privado ou PKCS#8
//     privado). Chave privada vira a publica derivada — o exemplo da norma,
//     "MIIBOgIBAAJB...", e o inicio de uma RSA PRIVADA PKCS#1 de 512 bits.

// A borda (plugin tv30-auth, infra/edgegateway/plugin/keys.go) le a MESMA
// string guardada no Redis com regras proprias; chave que o tv3ws aceitasse e
// a borda nao conseguisse ler daria 200 no registro e 108 em toda API. Por
// isso as regras abaixo copiam as da borda (os casos de teste tambem:
// test/bind-token.test.ts e keys_test.go):
//   - PEM so se o texto aparado COMECAR por "-----BEGIN" e o rotulo for um
//     dos quatro de PEM_LABELS (certificado X.509, chave EC etc. => 101);
//   - base64 so nas quatro codificacoes que o Go tenta (padrao ou URL, com
//     ou sem preenchimento), com a mesma rigidez — o Buffer.from do node
//     aceitaria texto malformado.
const PEM_HEAD = /^-----BEGIN ([A-Z0-9 ]+)-----/;
const PEM_LABELS = ['PUBLIC KEY', 'RSA PUBLIC KEY', 'RSA PRIVATE KEY', 'PRIVATE KEY'];
const B64_STD = /^[A-Za-z0-9+/]*$/;
const B64_URL = /^[A-Za-z0-9_-]*$/;

// base64.{Std,RawStd,URL,RawURL}Encoding.DecodeString do Go: com
// preenchimento, o total e multiplo de 4 e ha 1 ou 2 "=" no fim; sem
// preenchimento, o resto da divisao por 4 nao pode ser 1.
export function decodeBase64LikeEdge(s: string): Buffer | null {
    const body = s.replace(/=+$/, '');
    const pad = s.length - body.length;
    if (body.length === 0) return null;
    if (pad > 0 && (pad > 2 || (body.length + pad) % 4 !== 0)) return null;
    if (pad === 0 && body.length % 4 === 1) return null;
    for (const alphabet of [B64_STD, B64_URL]) {
        if (alphabet.test(body)) {
            return Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        }
    }
    return null;
}

function derToPublicKey(der: Buffer): KeyObject {
    const attempts: Array<() => KeyObject> = [
        () => createPublicKey({ key: der, format: 'der', type: 'spki' }),
        () => createPublicKey({ key: der, format: 'der', type: 'pkcs1' }),
        () => createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs1' })),
        () => createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })),
    ];
    for (const attempt of attempts) {
        try {
            return attempt();
        } catch {
            // tenta o proximo formato
        }
    }
    throw new Error('not an RSA key in SPKI, PKCS#1 or PKCS#8 DER');
}

// Chave RSA publica a partir do texto recebido. Lanca Error se o texto nao
// for chave RSA em nenhum dos formatos aceitos (=> erro 101 no registro).
export function parseRsaPublicKey(raw: string): KeyObject {
    const text = raw.trim();
    let key: KeyObject;
    if (text.startsWith('-----BEGIN')) {
        const label = PEM_HEAD.exec(text)?.[1];
        if (!label || !PEM_LABELS.includes(label)) {
            throw new Error(`PEM label '${label ?? '?'}' not accepted (${PEM_LABELS.join(', ')})`);
        }
        // createPublicKey aceita PEM publico e privado (deriva a publica);
        // privada cifrada (sem senha) falha aqui, como deve.
        try {
            key = createPublicKey(text);
        } catch (err) {
            throw new Error(`PEM not readable as a public or private key (${(err as Error).message})`);
        }
    } else {
        const der = decodeBase64LikeEdge(text.replace(/\s+/g, ''));
        if (!der) {
            throw new Error('neither PEM nor base64 DER');
        }
        key = derToPublicKey(der);
    }
    if (key.asymmetricKeyType !== 'rsa') {
        throw new Error(`key type ${key.asymmetricKeyType ?? 'unknown'} is not RSA`);
    }
    return key;
}

// Material de verificacao para o par (alg, key). Para HS o segredo vira
// KeyObject secreto explicitamente: se fosse passado como string, o
// jsonwebtoken tentaria antes le-lo como chave publica.
export function parseBindKey(alg: BindAlg, key: string): KeyObject {
    if (isHmac(alg)) {
        if (key.length === 0) throw new Error('empty HMAC secret');
        return createSecretKey(Buffer.from(key, 'utf8'));
    }
    return parseRsaPublicKey(key);
}

// Mesma chave? Igualdade de texto (sem espacos nas pontas — cabecalho HTTP
// chega aparado) ou, para RSA, a mesma chave publica em outra codificacao.
// Usada para casar o cabecalho "key" da revogacao (C.6.8.4), que nao carrega
// quebra de linha de PEM nem espaco nas pontas: a revogacao de "s" remove
// tambem um segredo HS registrado como "s " (efeito aceito).
export function sameKey(a: string, b: string): boolean {
    if (a.trim() === b.trim()) return true;
    try {
        const da = parseRsaPublicKey(a).export({ type: 'spki', format: 'der' });
        const db = parseRsaPublicKey(b).export({ type: 'spki', format: 'der' });
        return Buffer.compare(da, db) === 0;
    } catch {
        return false;
    }
}

// Duplicata no registro (C.6.8.2): para HS, igualdade EXATA — a verificacao
// usa os bytes da string sem trim (aqui e na borda), entao "s" e "s " sao
// segredos diferentes; para RSA, a mesma chave publica (sameKey).
export function sameRegisteredKey(alg: BindAlg, a: string, b: string): boolean {
    return isHmac(alg) ? a === b : sameKey(a, b);
}

// --- registro (C.6.8.2, Tabela C.47) ---------------------------------------

// Menor modulo RSA (bytes) que comporta a assinatura PKCS#1 v1.5: DigestInfo
// (19 bytes de cabecalho + o hash) mais 11 de preenchimento. Com menos, a
// chave registra mas nenhum token valida — a C.47 preve 101 para "key format
// incompatible with the specified algorithm". A chave de 512 bits do exemplo
// da norma (64 bytes) serve para RS256, nao para RS512.
const MIN_RSA_MODULUS_BYTES: Record<'RS256' | 'RS512', number> = { RS256: 19 + 32 + 11, RS512: 19 + 64 + 11 };

export type RegistrationCheck =
    | { ok: true; alg: BindAlg; key: string }
    | { ok: false; code: 101 | 105; detail: string };

// Corpo do POST /tv3/bind-context: 105 se for objeto JSON sem "alg" ou sem
// "key"; 101 se o corpo nao for objeto, o algoritmo nao for suportado ou a
// chave nao for compativel com o algoritmo.
export function checkRegistration(body: unknown): RegistrationCheck {
    if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, code: 101, detail: 'message body must be a JSON object with alg and key, body' };
    }
    const { alg, key } = body as Record<string, unknown>;
    const missing = [alg === undefined ? 'alg' : '', key === undefined ? 'key' : ''].filter(Boolean);
    if (missing.length > 0) {
        return { ok: false, code: 105, detail: missing.join(', ') };
    }
    if (!isBindAlg(alg)) {
        return { ok: false, code: 101, detail: `algorithm not supported (${BIND_ALGS.join(', ')}), alg` };
    }
    if (typeof key !== 'string') {
        return { ok: false, code: 101, detail: 'key must be a string, key' };
    }
    let parsed: KeyObject;
    try {
        parsed = parseBindKey(alg, key);
    } catch (err) {
        return { ok: false, code: 101, detail: `key incompatible with ${alg}: ${(err as Error).message}, key` };
    }
    if (alg === 'RS256' || alg === 'RS512') {
        const bits = parsed.asymmetricKeyDetails?.modulusLength ?? 0;
        const min = MIN_RSA_MODULUS_BYTES[alg];
        if (Math.ceil(bits / 8) < min) {
            return { ok: false, code: 101, detail: `key incompatible with ${alg}: RSA modulus of ${bits} bits is below ${min * 8}, key` };
        }
    }
    return { ok: true, alg, key };
}

// Entrada lida do Redis; null se malformada (escrita fora deste codigo).
export function parseStoredEntry(raw: string): BindKeyEntry | null {
    try {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object' && isBindAlg(v.alg) && typeof v.key === 'string') {
            return { alg: v.alg, key: v.key, registeredAt: typeof v.registeredAt === 'number' ? v.registeredAt : 0 };
        }
    } catch {
        // cai no null
    }
    return null;
}

// --- validacao (C.4.1.4: quatro frentes, nesta ordem) -----------------------

export type DecodedBindToken = {
    header: Record<string, unknown> & { alg: string };
    payload: Record<string, unknown>;
};

const BASE64URL_PART = /^[A-Za-z0-9_-]*$/;

function decodeJsonObject(part: string): Record<string, unknown> | null {
    try {
        const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

// Frente 1 — formato JWT (C.4.1.4.2): tres partes base64url, cabecalho e
// payload objetos JSON, cabecalho com "alg". JWE (cinco partes) cai aqui: o
// bind-token e assinado e nao cifrado (C.4.1.3). Assinatura vazia passa por
// esta frente e e recusada na segunda.
export function decodeBindToken(token: string): DecodedBindToken | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    if (!parts[0] || !parts[1] || !parts.every(p => BASE64URL_PART.test(p))) return null;
    const header = decodeJsonObject(parts[0]);
    const payload = decodeJsonObject(parts[1]);
    if (!header || !payload || typeof header.alg !== 'string') return null;
    return { header: header as DecodedBindToken['header'], payload };
}

// Frente 2 — assinatura (C.4.1.4.8) com UMA entrada registrada. O alg do
// token tem de ser o alg registrado para aquela chave: isso impede a
// confusao de algoritmo (token HS assinado com a chave publica RSA como
// segredo). As claims de tempo NAO sao checadas aqui (ignore*), e sim
// logo depois em checkTimeClaims, para respeitar a ordem da C.4.1.4.
export function signatureMatches(token: string, tokenAlg: string, entry: BindKeyEntry): boolean {
    if (entry.alg !== tokenAlg) return false;
    let key: KeyObject;
    try {
        key = parseBindKey(entry.alg, entry.key);
    } catch {
        return false;
    }
    try {
        jwt.verify(token, key, { algorithms: [entry.alg], ignoreExpiration: true, ignoreNotBefore: true });
        return true;
    } catch {
        return false;
    }
}

export type TimeCheck = { ok: true } | { ok: false; detail: string };

function numericDate(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

// Frentes 3 (nbf/exp, C.4.1.4.3-4) e 4 (iat, C.4.1.4.5). Claim ausente nao
// invalida (a norma diz "should" para as tres). nowSec e o relogio usado.
// PENDENTE (Joel): a norma manda comparar com o System Time Fragment da
// radiodifusao (C.4.1.3); o testbed nao tem esse relogio e usa o do host (L5).
export function checkTimeClaims(payload: Record<string, unknown>, nowSec: number): TimeCheck {
    const { nbf, exp, iat } = payload;
    if (nbf !== undefined) {
        if (!numericDate(nbf)) return { ok: false, detail: 'nbf is not a NumericDate' };
        if (nowSec < nbf) return { ok: false, detail: 'bind-token not valid yet (nbf)' };
    }
    if (exp !== undefined) {
        if (!numericDate(exp)) return { ok: false, detail: 'exp is not a NumericDate' };
        if (nowSec >= exp) return { ok: false, detail: 'bind-token expired (exp)' };
    }
    if (iat !== undefined) {
        if (!numericDate(iat)) return { ok: false, detail: 'iat is not a NumericDate' };
        if (iat > nowSec) return { ok: false, detail: 'bind-token issued in the future (iat)' };
    }
    return { ok: true };
}

export type BindTokenVerdict =
    | { kind: 'malformed' }
    | { kind: 'bad-signature' }
    | { kind: 'bad-time'; detail: string; services: string[] }
    | { kind: 'valid'; services: string[] };

// Validacao completa contra as listas de chaves por servico. "services" sao
// os servicos com alguma chave que valida a assinatura (C.4.1.3: basta
// QUALQUER chave da lista). O tempo e propriedade do token, nao da chave:
// se a assinatura confere mas o tempo nao, o token e invalido para todos.
export function evaluateBindToken(
    token: string,
    keysByService: ReadonlyMap<string, readonly BindKeyEntry[]>,
    nowSec: number,
): BindTokenVerdict {
    const decoded = decodeBindToken(token);
    if (!decoded) return { kind: 'malformed' };

    const alg = decoded.header.alg;
    const services: string[] = [];
    if (isBindAlg(alg)) {
        for (const [serviceId, entries] of keysByService) {
            if (entries.some(entry => signatureMatches(token, alg, entry))) services.push(serviceId);
        }
    }
    if (services.length === 0) return { kind: 'bad-signature' };

    const time = checkTimeClaims(decoded.payload, nowSec);
    if (!time.ok) return { kind: 'bad-time', detail: time.detail, services };
    return { kind: 'valid', services };
}
