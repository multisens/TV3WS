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


// The session is read from Redis on every call.

const KEY_CURRENT_USER    = 'session:current-user';
const KEY_CURRENT_SERVICE = 'session:current-service-id';

async function readCurrentUser(): Promise<string> {
    return (await redis.get(KEY_CURRENT_USER)) ?? '';
}

async function readCurrentService(): Promise<string> {
    return (await redis.get(KEY_CURRENT_SERVICE)) ?? '';
}

// The current service, or '' if users:index is not empty and no profile is
// visible to it (user:{id}:consent).
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


// The session mirrors the topics; a value outside the schema is refused, and
// the MQTT handler logs it.
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

// C.6.14.4 (Table C.73): 300 without a DTV service in use, 305 for a
// nonexistent id, 405 for a profile not visible to the current service.
async function setCurrentUser(uuid: string): Promise<void> {
    const currentService = await readCurrentService();
    if (!currentService) throw new ApiError(300);
    await assertUserVisible(uuid, currentService);
    await funcoes.sessaoUsuario(uuid);
    mqttClient.publish(TOPICS.current_user, uuid, true);
}

async function getUserList(body: Expression): Promise<UsersIdList> {
    // C.6.14.1: only the profiles visible to the service; without a DTV
    // service in use, 300.
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

    // Optional body (C.6.14.1): absent or {} returns every eligible profile.
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
        // Malformed expression in the body (C.6.14.1): error 101.
        throw new ApiError(101, 'invalid query expression in message body');
    }

    return { users: matched.map(id => ({ id })) };
}

// Resolves the service context of a call: the current-service alias uses
// the active service (error 300 if there is none); an explicit scid stands
// for itself.
async function resolveScid(scidParam?: string): Promise<string> {
    if (scidParam && scidParam !== 'current-service') return scidParam;
    const current = await resolveActiveService();
    if (!current) throw new ApiError(300);
    return current;
}

// Common checks of C.6.14.2 and C.6.14.5: the user exists (305) and the
// profile is visible to the given service (405).
async function assertUserVisible(uuid: string, scid: string): Promise<void> {
    const exists = await redis.sismember('users:index', uuid);
    if (!exists) throw new ApiError(305, `user ${uuid} does not exist`);

    const hasConsent = await redis.sismember(`user:${uuid}:consent`, scid);
    if (!hasConsent) throw new ApiError(405);
}

export type AttributeResult =
    | { kind: 'text'; value: string }
    | { kind: 'json'; attrs: Record<string, string> };

// C.6.14.2: an attribute in the query (the key is the name; also
// ?attribute=<name>) gives its value as plain text; without one, JSON with
// the basic attributes and the broadcaster ones of the given context.
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

// C.6.14.6: whether the file is the avatar of a profile visible to the
// service ('granted'); only of profiles not visible: 'no-consent' (405,
// Table C.75); of no profile: 'no-owner' (305). The service checked is the
// current one (session:current-service-id), not the <service-context-id> of
// the URL.
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


// Basic attributes a broadcaster may not redefine.
const PROTECTED_BASICS = ['id', 'nickname', 'parentalControl', 'maxContentRating'];

// Quota of the private area per profile and service context (10.3.3: up to
// 20 MB).
const PRIVATE_AREA_QUOTA_BYTES = 20 * 1024 * 1024;

// C.6.14.5: writes or creates broadcaster attributes; the value '' removes
// the attribute. Returns the changed set (the JSON of the API response).
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

    // Measures the resulting hash before writing, to answer with the quota
    // message; the Redis function checks the same limit again, atomically.
    const current = await redis.hgetall(key);
    const merged: Record<string, string> = { ...current, ...toSet };
    toDel.forEach(k => delete merged[k]);
    const size = Object.entries(merged).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
    if (size > PRIVATE_AREA_QUOTA_BYTES) {
        throw new ApiError(200, `private data quota (20 MB) exceeded for this profile and service context`);
    }

    // HDEL of the empty values and HSET of the others in a single function,
    // which checks the schema.
    await funcoes.atributosEmissora(uuid, scid, changed);

    // Notifies the viewer only after writing and if a value changed; a failed
    // write does not notify.
    if (attributesChanged(current, toSet, toDel)) {
        await notifyUserOfWrite(uuid, scid);
    }
    return changed;
}


// Table C.74, "Restrictions": "it is necessary to notify the user that the
// application wants to change/add the attribute". An informative notice
// after writing, without confirmation; not retained, so that an old notice
// does not come back when the TV page reconnects.
export const INFO_POPUP_TOPIC = 'aop/display/layers/popup/info';
export const INFO_POPUP_TIMEOUT_MS = 5000;

// The previous state is the HGETALL of the quota check, which is not atomic
// with the write: a concurrent write in between may change the result.
function attributesChanged(before: Record<string, string>, toSet: Record<string, string>, toDel: string[]): boolean {
    return Object.entries(toSet).some(([k, v]) => before[k] !== v) || toDel.some(k => k in before);
}

// <service> is the serviceName of the current service if the write is on it
// and the name exists; otherwise, the id of the service. A failure of the
// notice is only logged.
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

// Resolved inside USER_THUMBS whatever the value of the avatar field.
// undefined = refused, nonexistent or not a file (305, Table C.75).
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

// Table C.75: Content-Type by the MIME type derived from the extension.
// These are the avatar ones; any other is application/octet-stream, as in
// C.6.4.7 (Table C.17).
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
