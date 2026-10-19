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


// --- session state (read from Redis; the tv3ws also keeps the current service
// in memory, core.app.sid, mirrored from aop/currentService) ---
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
// P4 (Luis, 10/10): a escrita passa pelas funcoes do Redis
// (../../redis-funcoes.ts), que conferem o esquema; valor fora dele (ex.: id
// com mais de 64 caracteres, o mesmo teto do topico no broker) e recusado e o
// handler MQTT loga a falha.
async function updateCurrentUser(m: string): Promise<void> {
    await funcoes.sessaoUsuario(m);
}

async function updateCurrentService(m: string): Promise<void> {
    await funcoes.sessaoServicoId(m);
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
    await funcoes.sessaoUsuario(uuid);
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

// C.6.14.6: o arquivo pedido e o avatar de algum perfil? E esse perfil
// concedeu acesso ao broadcaster do servico corrente?
// - 'granted': de um perfil com consentimento (o arquivo pode ser lido);
// - 'no-consent': so de perfis SEM consentimento. Correcao de 12/10
//   (spec-1210-defeitos3, item 2): o controller responde 405, o codigo da
//   Tabela C.73 (p. 333; p. 351 do PDF): "405: If the user has not granted
//   access to the broadcaster corresponding to the informed service
//   (<service-context-id>)". Antes, 305, o mesmo do caminho inexistente;
// - 'no-owner': nao e o avatar de nenhum perfil (305, como antes).
// O servico conferido segue o corrente (session:current-service-id), e nao
// o <service-context-id> da URL, como antes desta correcao.
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

    // quota da area privativa (P3): mede o hash resultante antes de gravar,
    // para responder com a mensagem da quota. A funcao do Redis confere o
    // mesmo teto de novo no resultado, ja de forma atomica (o HGETALL daqui e
    // a gravacao nao sao uma operacao so).
    const current = await redis.hgetall(key);
    const merged: Record<string, string> = { ...current, ...toSet };
    toDel.forEach(k => delete merged[k]);
    const size = Object.entries(merged).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
    if (size > PRIVATE_AREA_QUOTA_BYTES) {
        throw new ApiError(200, `private data quota (20 MB) exceeded for this profile and service context`);
    }

    // P4 (Luis, 10/10): HDEL dos vazios e HSET dos demais numa funcao so
    // (tv30_atributos_emissora), que confere o esquema: perfil em users:index,
    // nome nao vazio e fora dos basicos protegidos, teto de 20 MB.
    // E4 (Joel, 15/10): esta familia tem dois escritores. O tv3ws grava o
    // conteudo; o AoP remove a familia inteira junto com o perfil, na mesma
    // funcao do Redis (tv30_perfil_remove).
    await funcoes.atributosEmissora(uuid, scid, changed);

    // G9 (decisao do Luis em 12/10): aviso ao espectador depois da gravacao
    // bem-sucedida, so quando algum valor mudou de fato (ver notifyUserOfWrite).
    // Gravacao recusada ou com erro sobe acima e nao avisa.
    if (attributesChanged(current, toSet, toDel)) {
        await notifyUserOfWrite(uuid, scid);
    }
    return changed;
}


// --- Aviso ao usuario (C.6.14.5) ---

// G9 (decisao do Luis em 12/10). Tabela C.72 (p. 332; p. 350 do PDF),
// "Restrictions": "it is necessary to notify the user that the application
// wants to change/add the attribute". O tv3ws publica um aviso informativo na
// camada grafica do AoP (aop/public/js/popup.js, tipo 'info'): so informa,
// depois de gravar; nao pede confirmacao antes. Nao retido (um aviso velho nao
// volta quando a pagina da TV reconecta).
export const INFO_POPUP_TOPIC = 'aop/display/layers/popup/info';
export const INFO_POPUP_TIMEOUT_MS = 5000;

// Algum valor mudou? Gravar o mesmo valor ou remover atributo que nao existe
// nao muda nada e nao avisa. O estado anterior e o HGETALL feito antes da
// gravacao (para a quota), que nao e atomico com ela: uma escrita concorrente
// no meio pode fazer o aviso sair (ou nao) pela comparacao com o estado lido.
function attributesChanged(before: Record<string, string>, toSet: Record<string, string>, toDel: string[]): boolean {
    return Object.entries(toSet).some(([k, v]) => before[k] !== v) || toDel.some(k => k in before);
}

// Texto: "A emissora <servico> atualizou os dados do perfil <apelido>.".
// - servico: o serviceName do servico corrente (session:current-service,
//   Tabela C.8; o mesmo que a C.6.3.1 responde) quando a gravacao e no
//   contexto do servico corrente; sem nome (o testbed nao publica
//   aop/services, e o nome fica vazio) ou com outro <service-context-id>, o
//   id do servico da gravacao;
// - apelido: o nickname do perfil (user:{id}); sem ele, "...do perfil.".
// Falha ao montar ou publicar o aviso vai para o log: os atributos ja foram
// gravados, e a resposta da API continua a de sucesso.
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


// --- File serving ---

type FileData = { size: number; mime: string; name: string; file: string };

// Correcao de 12/10 (spec-1210-seguranca2, item 1, o mesmo defeito da
// C.6.4.7): o caminho e resolvido dentro de USER_THUMBS e nao sai dele
// (regras em ../../util/safe-path.ts). Antes, path.join(USER_THUMBS, path)
// lia qualquer arquivo que o processo alcancasse, desde que o mesmo texto
// estivesse no campo avatar de um perfil com consentimento para o servico
// (checkConsent) — e o avatar era gravado pela plataforma sem conferencia de
// formato (aop/src/modules/profile-manager/service.js, createProfile, a
// partir do corpo do POST /profile/create). Desde a decisao do Luis em 12/10
// (G8), o avatar e o nome de um arquivo deste diretorio, que a plataforma
// gera (<id do perfil>.svg); a conferencia daqui continua valendo para
// qualquer valor do campo. undefined = recusado,
// inexistente ou que nao e arquivo: o controller responde 305 (Tabela C.73,
// p. 333; p. 351 do PDF: "305: If a non-existent <path> is specified in the
// receiver"); antes, o inexistente dava 404 {error:200} (ENOENT).
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

// Tabela C.73 (p. 333; p. 351 do PDF): "the value of the Content-Type header
// shall be defined according to the MIME type of the file (derived from its
// extension, considering the MIME types supported by TV 3.0 AoP)". G8
// (decisao do Luis em 12/10): as extensoes do nome do avatar (svg, png, jpg,
// jpeg, webp; aop/src/modules/profile-manager/avatar.js); antes, o SVG que o
// AoP passou a gravar saia como application/octet-stream e o webp tambem. O
// resto segue application/octet-stream, como a C.6.4.7 manda quando o tipo
// nao e conhecido (Tabela C.17, p. 231; p. 249 do PDF).
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
