import * as dotenv from 'dotenv';
import fs from 'fs';
import mqttClient, { TOPICS } from '../../mqtt-client';
import path from 'path';
import redis from '../../redis-client';
import * as funcoes from '../../redis-funcoes';
import { ApiError, execOrThrow } from '../../util';
import { resolveInsideDir } from '../../util/safe-path';
import { Expression, UserAttributes, UsersIdList } from './types';
dotenv.config();


// Sessao lida do Redis a cada chamada, para valer mesmo se alterada por fora.

const KEY_CURRENT_USER    = 'session:current-user';
const KEY_CURRENT_SERVICE = 'session:current-service-id';

async function readCurrentUser(): Promise<string> {
    return (await redis.get(KEY_CURRENT_USER)) ?? '';
}

async function readCurrentService(): Promise<string> {
    return (await redis.get(KEY_CURRENT_SERVICE)) ?? '';
}

// Servico ativo so se algum perfil tiver consent para ele: um aop/currentService retido no broker, sem
// consent de ninguem, esconderia todos os perfis e travaria o profile-chooser do AoP.
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


// Os perfis (users:index, user:{id}, user:{id}:consent) sao da plataforma (gestor de perfis do AoP); aqui
// so se le. A sessao espelha os topicos; valor fora do esquema e recusado, e o handler MQTT loga.
async function updateCurrentUser(m: string): Promise<void> {
    await funcoes.sessaoUsuario(m);
}

async function updateCurrentService(m: string): Promise<void> {
    await funcoes.sessaoServicoId(m);
}

mqttClient.addTopicHandler(TOPICS.current_user, updateCurrentUser);
mqttClient.addTopicHandler(TOPICS.current_service, updateCurrentService);


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


async function getCurrentUser(): Promise<string> {
    return await readCurrentUser();
}

// C.6.14.4: o lastAccess do perfil e gravado pela plataforma ao receber aop/currentUser, nao aqui
async function setCurrentUser(uuid: string): Promise<void> {
    await funcoes.sessaoUsuario(uuid);
    mqttClient.publish(TOPICS.current_user, uuid, true);
}

async function getUserList(body: Expression): Promise<UsersIdList> {
    // C.6.14.1: a restricao de divulgacao vale sempre; sem servico DTV em uso, 300
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

// C.6.14.2: atributo na query (a chave e o nome; aceita tambem ?attribute=<nome>) -> valor em texto puro;
// sem atributo -> JSON com os basicos e os de emissora do contexto informado.
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

// C.6.14.6: o arquivo e o avatar de um perfil que deu acesso ao servico ('granted')? So de perfis sem
// acesso: 'no-consent' (405, Tabela C.73); de nenhum perfil: 'no-owner' (305). O servico conferido e o
// corrente (session:current-service-id), nao o <service-context-id> da URL.
export type AvatarAccess = 'granted' | 'no-consent' | 'no-owner';

async function checkConsent(avatarPath: string): Promise<AvatarAccess> {
    const currentService = await readCurrentService();
    const userIds = await redis.smembers('users:index');

    const pipeline = redis.pipeline();
    userIds.forEach(id => {
        pipeline.hget(`user:${id}`, 'avatar');
        pipeline.sismember(`user:${id}:consent`, currentService);
    });
    const results = await execOrThrow(pipeline);

    let owned = false;
    for (let i = 0; i < userIds.length; i++) {
        const avatar = results[i * 2] as string | null;
        const hasConsent = results[i * 2 + 1];
        if (avatar === avatarPath) {
            if (hasConsent) return 'granted';
            owned = true;
        }
    }
    return owned ? 'no-consent' : 'no-owner';
}


// Basicos que a norma proibe redefinir no contexto de um broadcaster.
const PROTECTED_BASICS = ['id', 'nickname', 'parentalControl', 'maxContentRating'];

// quota da area privativa por perfil x contexto de servico (10.3.3: ate 20 MB por combinacao)
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

    // mede o hash resultante antes de gravar, para responder com a mensagem da quota; a funcao do Redis
    // confere o mesmo teto de novo, ja de forma atomica
    const current = await redis.hgetall(key);
    const merged: Record<string, string> = { ...current, ...toSet };
    toDel.forEach(k => delete merged[k]);
    const size = Object.entries(merged).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
    if (size > PRIVATE_AREA_QUOTA_BYTES) {
        throw new ApiError(200, `private data quota (20 MB) exceeded for this profile and service context`);
    }

    // HDEL dos vazios e HSET dos demais numa funcao so, que confere o esquema. A familia tem dois
    // escritores: o tv3ws grava o conteudo; o AoP a remove junto com o perfil (tv30_perfil_remove).
    await funcoes.atributosEmissora(uuid, scid, changed);

    // avisa o espectador so depois de gravar e se algum valor mudou; gravacao com erro nao avisa
    if (attributesChanged(current, toSet, toDel)) {
        await notifyUserOfWrite(uuid, scid);
    }
    return changed;
}


// Tabela C.72, "Restrictions": "it is necessary to notify the user that the application wants to
// change/add the attribute". Aviso informativo depois de gravar, sem confirmacao; nao retido, para um
// aviso velho nao voltar quando a pagina da TV reconecta.
export const INFO_POPUP_TOPIC = 'aop/display/layers/popup/info';
export const INFO_POPUP_TIMEOUT_MS = 5000;

// O estado anterior e o HGETALL da quota, que nao e atomico com a gravacao: uma escrita concorrente no meio
// pode mudar o resultado.
function attributesChanged(before: Record<string, string>, toSet: Record<string, string>, toDel: string[]): boolean {
    return Object.entries(toSet).some(([k, v]) => before[k] !== v) || toDel.some(k => k in before);
}

// <servico> e o serviceName do servico corrente se a gravacao for nele e o nome existir; senao, o id do
// servico. Falha no aviso so vai para o log: os atributos ja foram gravados.
async function notifyUserOfWrite(uuid: string, scid: string): Promise<void> {
    try {
        const [nickname, currentService] = await Promise.all([
            redis.hget(`user:${uuid}`, 'nickname'),
            readCurrentService(),
        ]);
        const serviceName = scid === currentService ? await redis.hget('session:current-service', 'serviceName') : null;
        const broadcaster = serviceName || scid;
        const value = nickname
            ? `A emissora ${broadcaster} atualizou os dados do perfil ${nickname}.`
            : `A emissora ${broadcaster} atualizou os dados do perfil.`;
        mqttClient.publish(INFO_POPUP_TOPIC, JSON.stringify({ value, timeout: INFO_POPUP_TIMEOUT_MS }), false);
    } catch (err) {
        console.error(`[C.6.14.5] atributos de ${uuid} gravados, mas o aviso ao usuario nao saiu: ${(err as Error)?.message}`);
    }
}


type FileData = { size: number; mime: string; name: string; file: string };

// Resolvido dentro de USER_THUMBS seja qual for o valor do campo avatar. undefined = recusado, inexistente
// ou nao arquivo (305, Tabela C.73).
function getFile(fpath: string): FileData | undefined {
    const entry = resolveInsideDir(process.env.USER_THUMBS, fpath);
    if (entry === undefined || !entry.stat.isFile()) return undefined;
    const file_path = entry.path;
    const file_name = path.parse(file_path).base;
    const stat = entry.stat;
    const file = fs.readFileSync(file_path, 'binary');
    return {
        size: stat.size,
        mime: getMime(path.extname(file_name)),
        name: file_name,
        file,
    };
}

// Tabela C.73: Content-Type pelo MIME derivado da extensao. Estas sao as do avatar; o resto sai
// application/octet-stream, como na C.6.4.7 (Tabela C.17).
const MIME_BY_EXT: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
};

function getMime(ext: string): string {
    return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}


export default { getCurrentUser, setCurrentUser, getUserList, getUserAttributes, checkConsent, getFile, writeBroadcasterAttrs };
