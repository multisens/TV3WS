import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Client, { ClientClass, isClientClass } from './client';
import { execOrThrow } from '../../util/redis-result';
dotenv.config();

export type TokenAlg = "HS256" | "HS512" | "RS256" | "RS512";

// Claims of the access token; the class goes in the credential.
type TokenPayload = {
    iat: number;
    nbf: number;
    exp: number;
    iss: string;
    sub: string;
    class: ClientClass;
}

const jwtSecret = process.env.JWT_SECRET || '0123456789';
const jwtIssuer = process.env.JWT_ISSUER || 'GenericIssuer';

// Duration of the accessToken in seconds (C.6.1.3: expiresIn is a duration,
// not an instant).
const ACCESS_TOKEN_TTL = 24 * 60 * 60;

// Authorization in Redis, which survives a restart:
// - client:{id}         HASH  class and issued credentials;
// - clients:authorized  SET   clientids authorized by the viewer;
// - clients:blocked     SET   clientids refused.
// A clientid is in at most one of the sets. authorizedClients caches the
// live object of the stored clients. pendingClients keeps a non-local
// client that accepted the pop-up, with the pairing material, until the
// /tv3/token that checks the challenge (C.4.2.3); memory only, lost on a
// restart of tv3ws.
import redis from '../../redis-client';
import * as funcoes from '../../redis-funcoes';

const clientKey = (id: string) => `client:${id}`;
const AUTHORIZED_KEY = 'clients:authorized';
const BLOCKED_KEY = 'clients:blocked';

const authorizedClients = new Map<string, Client>();
const pendingClients = new Map<string, Client>();

function clientFields(client: Client): Record<string, string> {
    const fields: Record<string, string> = {
        class: client.getClass(),
        refreshToken: client.getRefreshToken(),
    };
    if (client.hasAccessToken()) fields.accessToken = client.getAccessToken();
    return fields;
}

async function persistClient(client: Client): Promise<void> {
    await funcoes.clienteGrava(client.getId(), clientFields(client));
}

// Authorized = member of clients:authorized. The set, not the in-memory
// cache, decides, so that a block stored in Redis applies here too.
export async function isAuthorized(id: string): Promise<boolean> {
    return (await redis.sismember(AUTHORIZED_KEY, id)) === 1;
}

// For the 101 on clientid reuse (C.6.1.2, Table C.3). 'used' includes a
// client that has only the client:{id} record; a pending attempt of a
// non-local client does not count.
export type ClientIdStatus = 'new' | 'used' | 'blocked';

export async function clientIdStatus(id: string): Promise<ClientIdStatus> {
    const [authorized, blocked, stored] = await execOrThrow(redis.pipeline()
        .sismember(AUTHORIZED_KEY, id)
        .sismember(BLOCKED_KEY, id)
        .exists(clientKey(id)));
    if (blocked === 1) return 'blocked';
    if (authorized === 1 || stored === 1 || authorizedClients.has(id)) return 'used';
    return 'new';
}

export async function AuthorizeClient(id: string, clientClass: ClientClass = 'standAlone'): Promise<Client> {
    const client = new Client(id, clientClass);
    await funcoes.clienteAutoriza(id, clientFields(client));
    authorizedClients.set(id, client);
    return client;
}

// The "yes" of a non-local client: nothing goes to Redis before the pairing
// completes (C.4.2.3).
export function StartPairing(id: string): Client {
    const client = new Client(id, 'nonLocal');
    pendingClients.set(id, client);
    return client;
}

export function GetPendingClient(id: string): Client | undefined {
    return pendingClients.get(id);
}

// A new /tv3/authorize of the same clientid ends the pending attempt.
export function DiscardPending(id: string): void {
    pendingClients.delete(id);
}

// challenge-response checked: stores the authorization; if storing fails,
// the client stays pending.
export async function AuthorizePairedClient(client: Client): Promise<void> {
    const id = client.getId();
    await funcoes.clienteAutoriza(id, clientFields(client));
    if (pendingClients.get(id) === client) pendingClients.delete(id);
    authorizedClients.set(id, client);
}

// Removes the client from the authorized ones and from the pending ones,
// and adds it to clients:blocked; the client:{id} record stays.
export async function BlockClient(id: string): Promise<void> {
    authorizedClients.delete(id);
    pendingClients.delete(id);
    await funcoes.clienteBloqueia(id);
}

export async function listAuthorizedClients(): Promise<string[]> {
    return (await redis.smembers(AUTHORIZED_KEY)).sort();
}

export async function listBlockedClients(): Promise<string[]> {
    return (await redis.smembers(BLOCKED_KEY)).sort();
}

// Boot: adds to clients:authorized every client:{id} that is not blocked.
// Check and insertion are atomic (tv30_cliente_inclui_autorizado), so that a
// block in between does not break the invariant.
export async function backfillAuthorizedClients(): Promise<number> {
    let cursor = '0';
    let added = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'client:*', 'COUNT', 200);
        cursor = next;
        for (const key of keys) {
            const id = key.slice('client:'.length);
            added += await funcoes.clienteIncluiAutorizado(id);
        }
    } while (cursor !== '0');
    return added;
}

export async function GetAuthorizedClient(id: string): Promise<Client> {
    const cached = authorizedClients.get(id);
    if (cached) return cached;

    const stored = await redis.hgetall(clientKey(id));
    if (stored && stored.refreshToken) {
        if (!isClientClass(stored.class)) {
            throw Error(`Client ${id} has an invalid class in Redis: '${stored.class}'.`);
        }
        const client = new Client(id, stored.class);
        client.restore(stored.refreshToken, stored.accessToken);
        authorizedClients.set(id, client);
        return client;
    }
    throw Error(`Client ${id} is not authorized.`);
}

// Rotates the refresh token and stores it.
export async function rotateRefreshToken(id: string): Promise<string> {
    const client = await GetAuthorizedClient(id);
    const token = client.updateRefreshToken();
    await persistClient(client);
    return token;
}


function createAccessToken(alg: TokenAlg, clientId: string, clientClass: ClientClass, ttl: number = ACCESS_TOKEN_TTL): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: TokenPayload = {
        iat: now,
        nbf: now,
        exp: now + ttl,
        iss: jwtIssuer,
        sub: clientId,
        class: clientClass,
    }

    return jwt.sign(payload, jwtSecret, { algorithm: alg as any });
}


// expiresIn in remaining seconds (a duration, C.6.1.3); reuses the token
// already issued while it is valid.
export async function getClientAccessToken(id: string): Promise<[string, number]> {
    const client = await GetAuthorizedClient(id);
    const now = Math.floor(Date.now() / 1000);

    if (client.hasAccessToken()) {
        const token = client.getAccessToken();
        try {
            const payload = jwt.verify(token, jwtSecret) as TokenPayload;
            return [token, Math.max(payload.exp - now, 0)];
        } catch {
            // Expired or invalid: a new one is issued.
        }
    }
    const token = createAccessToken('HS256', id, client.getClass());
    client.setAccessToken(token);
    await persistClient(client);
    return [token, ACCESS_TOKEN_TTL];
}
