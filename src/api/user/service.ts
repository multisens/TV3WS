import * as dotenv from 'dotenv';
import fs from 'fs';
import mqttClient, { TOPICS } from '../../mqtt-client';
import path from 'path';
import redis from '../../redis-client';
import { ApiError, execOrThrow } from '../../util';
import { Expression, UserAttributes, UsersIdList } from './types';
dotenv.config();


// --- session state (Redis is the single source of truth) ---
// currentUser e currentService NAO sao mantidos em memoria. Toda leitura
// vai pro Redis em runtime, garantindo consistencia mesmo se a state for
// alterada externamente (outro tv3ws, escrita direta, MQTT perdido etc).

const KEY_CURRENT_USER    = 'session:current-user';
const KEY_CURRENT_SERVICE = 'session:current-service-id';

async function readCurrentUser(): Promise<string> {
    return (await redis.get(KEY_CURRENT_USER)) ?? '';
}

async function readCurrentService(): Promise<string> {
    return (await redis.get(KEY_CURRENT_SERVICE)) ?? '';
}

// Retorna o service ativo APENAS se for "conhecido" — i.e. pelo menos um user
// tem consent pra ele. Um service obsoleto/retido (ex: aop/currentService preso
// no broker apos um restart, cujo SID ninguem consentiu) eh tratado como "sem
// service ativo". Sem esse guard o filtro de consent esconde TODOS os perfis e
// o profile-chooser fica vazio, travando o workflow do AoP.
async function resolveActiveService(): Promise<string> {
    const currentService = await readCurrentService();
    if (!currentService) return '';

    const userIds = await redis.smembers('users:index');
    if (userIds.length === 0) return currentService;

    const pipeline = redis.pipeline();
    userIds.forEach(id => pipeline.sismember(`user:${id}:consent`, currentService));
    const results = await execOrThrow(pipeline);

    const known = results.some(r => r === 1);
    return known ? currentService : '';
}


// --- MQTT handlers ---

// D-0510-5 (reuniao 05/10 com o Joel; P5, um dono por familia de chave): os
// perfis (users:index, user:{id}, user:{id}:consent) sao da PLATAFORMA — o
// gestor de perfis do AoP cria, despeja (P3) e grava o lastAccess quando o
// usuario corrente muda (aop/src/core.js). A carga inicial do redis so
// provisiona o banco vazio. Este servico so LE perfis: sairam daqui o
// syncUsersFromFile (aop/users e semeadura no boot com USER_DATA_FILE) e a
// escrita do lastAccess. Resta a sessao (session:*), espelho dos topicos.
async function updateCurrentUser(m: string): Promise<void> {
    await redis.set(KEY_CURRENT_USER, m);
}

async function updateCurrentService(m: string): Promise<void> {
    await redis.set(KEY_CURRENT_SERVICE, m);
}

mqttClient.addTopicHandler(TOPICS.current_user, updateCurrentUser);
mqttClient.addTopicHandler(TOPICS.current_service, updateCurrentService);


// --- Expression evaluator ---

function compareValues(userVal: string, op: string, filterVal: string): boolean {
    const a = isNaN(Number(userVal)) ? userVal : Number(userVal);
    const b = isNaN(Number(filterVal)) ? filterVal : Number(filterVal);
    switch (op) {
        case 'eq':  return a === b;
        case 'neq': return a !== b;
        case 'lt':  return a < b;
        case 'lte': return a <= b;
        case 'gt':  return a > b;
        case 'gte': return a >= b;
        default:    return false;
    }
}

function matchExpression(fields: Record<string, string>, expr: Expression): boolean {
    if ('attribute' in expr) {
        return compareValues(fields[expr.attribute] ?? '', expr.comparator, expr.value);
    } else if ('and' in expr) {
        return expr.and.every(e => matchExpression(fields, e));
    } else {
        return (expr as any).or.some((e: Expression) => matchExpression(fields, e));
    }
}


// --- API methods ---

async function getCurrentUser(): Promise<string> {
    return await readCurrentUser();
}

// C.6.14.4: o lastAccess do perfil (despejo P3) e gravado pela plataforma ao
// receber aop/currentUser (D-0510-5), nao aqui.
async function setCurrentUser(uuid: string): Promise<void> {
    await redis.set(KEY_CURRENT_USER, uuid);
    mqttClient.publish(TOPICS.current_user, uuid, true);
}

async function getUserList(body: Expression): Promise<UsersIdList> {
    // C.6.14.1: a restricao de divulgacao vale SEMPRE — sem servico DTV em
    // uso a chamada falha com erro 300 (a antiga excecao "sem servico lista
    // tudo" atendia o profile-chooser, que hoje le o armazenamento direto
    // como funcao da plataforma).
    const currentService = await resolveActiveService();
    if (!currentService) throw new ApiError(300);

    const userIds = await redis.smembers('users:index');

    const consentPipeline = redis.pipeline();
    userIds.forEach(id => consentPipeline.smembers(`user:${id}:consent`));
    const consentResults = await execOrThrow(consentPipeline) as string[][];

    const eligibleIds = userIds.filter((_, i) => {
        const consent = consentResults[i] ?? [];
        return consent.includes(currentService);
    });

    // corpo opcional (C.6.14.1): ausente ou {} devolve todos os elegiveis
    if (!body || Object.keys(body).length === 0 || eligibleIds.length === 0) {
        return { users: eligibleIds.map(id => ({ id })) };
    }

    const fieldsPipeline = redis.pipeline();
    eligibleIds.forEach(id => fieldsPipeline.hgetall(`user:${id}`));
    const fieldsResults = await execOrThrow(fieldsPipeline) as Record<string, string>[];

    let matched: string[];
    try {
        matched = eligibleIds.filter((_, i) => {
            const fields = fieldsResults[i] ?? {};
            return matchExpression(fields, body);
        });
    } catch {
        // expressao malformada no corpo (C.6.14.1 -> erro 101)
        throw new ApiError(101, 'invalid query expression in message body');
    }

    return { users: matched.map(id => ({ id })) };
}

// Resolve o contexto de servico de uma chamada: o alias current-service usa
// o servico ativo (erro 300 se nao houver); um scid explicito vale por si.
async function resolveScid(scidParam?: string): Promise<string> {
    if (scidParam && scidParam !== 'current-service') return scidParam;
    const current = await resolveActiveService();
    if (!current) throw new ApiError(300);
    return current;
}

// Garantias comuns de C.6.14.2/C.6.14.5: o usuario existe (305) e concedeu
// acesso ao broadcaster do servico informado (405).
async function assertUserVisible(uuid: string, scid: string): Promise<void> {
    const exists = await redis.sismember('users:index', uuid);
    if (!exists) throw new ApiError(305, `user ${uuid} does not exist`);

    const hasConsent = await redis.sismember(`user:${uuid}:consent`, scid);
    if (!hasConsent) throw new ApiError(405);
}

export type AttributeResult =
    | { kind: 'text'; value: string }
    | { kind: 'json'; attrs: Record<string, string> };

// C.6.14.2: com atributo na query a resposta e o VALOR em texto puro; sem
// atributo, o JSON com todos os atributos (basicos + de emissora) no
// contexto de servico informado. A chave de query E o nome do atributo
// (aceita-se tambem o legado ?attribute=<nome>).
async function getUserAttributes(uuid: string, scidParam: string | undefined, query: Record<string, unknown>): Promise<AttributeResult> {
    const scid = await resolveScid(scidParam);
    await assertUserVisible(uuid, scid);

    const keys = Object.keys(query ?? {});
    const atname = keys.includes('attribute')
        ? String(query.attribute)
        : (keys.length > 0 ? keys[0] : undefined);

    if (atname) {
        const basic = await redis.hget(`user:${uuid}`, atname);
        const fromBroadcaster = basic === null
            ? await redis.hget(`user:${uuid}:broadcaster-attrs:${scid}`, atname)
            : null;
        const value = basic ?? fromBroadcaster;
        if (value === null) {
            throw new ApiError(305, `attribute ${atname} does not exist`);
        }
        return { kind: 'text', value };
    }

    const basics = await redis.hgetall(`user:${uuid}`);
    const broadcaster = await redis.hgetall(`user:${uuid}:broadcaster-attrs:${scid}`);
    return { kind: 'json', attrs: { ...basics, ...broadcaster } };
}

async function checkConsent(avatarPath: string): Promise<boolean> {
    const currentService = await readCurrentService();
    const userIds = await redis.smembers('users:index');

    const pipeline = redis.pipeline();
    userIds.forEach(id => {
        pipeline.hget(`user:${id}`, 'avatar');
        pipeline.sismember(`user:${id}:consent`, currentService);
    });
    const results = await execOrThrow(pipeline);

    for (let i = 0; i < userIds.length; i++) {
        const avatar = results[i * 2] as string | null;
        const hasConsent = results[i * 2 + 1];
        if (avatar === avatarPath && hasConsent) {
            return true;
        }
    }
    return false;
}


// (createUser saiu: criacao de perfil e funcao do gestor de perfis da
// PLATAFORMA — aop/src/modules/profile-manager — que escreve direto no
// armazenamento com o teto de P3. Isso tambem elimina o segundo escritor
// do userData.json — defeito 8 da vacina.)


// --- Broadcaster attributes (C.6.14.5) ---

// Basicos que a norma proibe redefinir no contexto de um broadcaster.
const PROTECTED_BASICS = ['id', 'nickname', 'parentalControl', 'maxContentRating'];

// P3: quota da area privativa por perfil x contexto de servico (10.3.3 da
// norma: ate 20 MB de dados privados por combinacao).
const PRIVATE_AREA_QUOTA_BYTES = 20 * 1024 * 1024;

// C.6.14.5: escreve/cria atributos de emissora; valor '' remove o atributo.
// Devolve o conjunto alterado (a resposta da API e esse JSON).
async function writeBroadcasterAttrs(uuid: string, scidParam: string | undefined, attrs: Record<string, unknown>): Promise<Record<string, string>> {
    const scid = await resolveScid(scidParam);
    await assertUserVisible(uuid, scid);

    const entries = Object.entries(attrs ?? {});
    if (entries.length === 0) {
        throw new ApiError(101, 'message body has no attributes');
    }
    for (const [k] of entries) {
        if (PROTECTED_BASICS.includes(k)) {
            throw new ApiError(101, `basic attribute ${k} shall not be redefined in a broadcaster context`);
        }
    }

    const key = `user:${uuid}:broadcaster-attrs:${scid}`;
    const changed: Record<string, string> = {};
    const toSet: Record<string, string> = {};
    const toDel: string[] = [];
    for (const [k, v] of entries) {
        const val = String(v);
        changed[k] = val;
        if (val === '') toDel.push(k); else toSet[k] = val;
    }

    // quota da area privativa (P3): mede o hash resultante antes de gravar
    const current = await redis.hgetall(key);
    const merged: Record<string, string> = { ...current, ...toSet };
    toDel.forEach(k => delete merged[k]);
    const size = Object.entries(merged).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
    if (size > PRIVATE_AREA_QUOTA_BYTES) {
        throw new ApiError(200, `private data quota (20 MB) exceeded for this profile and service context`);
    }

    if (toDel.length > 0) await redis.hdel(key, ...toDel);
    if (Object.keys(toSet).length > 0) await redis.hset(key, toSet);
    return changed;
}


// --- File serving ---

type FileData = { size: number; mime: string; name: string; file: string };

function getFile(fpath: string): FileData {
    const file_path = path.join(process.env.USER_THUMBS as string, fpath);
    const file_name = path.parse(file_path).base;
    const stat = fs.statSync(file_path);
    const file = fs.readFileSync(file_path, 'binary');
    return {
        size: stat.size,
        mime: getMime(path.extname(file_name)),
        name: file_name,
        file,
    };
}

function getMime(ext: string): string {
    if (ext === '.jpeg' || ext === '.jpg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    return 'application/octet-stream';
}


export default { getCurrentUser, setCurrentUser, getUserList, getUserAttributes, checkConsent, getFile, writeBroadcasterAttrs };
