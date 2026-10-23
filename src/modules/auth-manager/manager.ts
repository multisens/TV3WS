import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Client, { ClientClass } from './client';
import { execOrThrow } from '../../util/redis-result';
dotenv.config();

export type TokenAlg = "HS256" | "HS512" | "RS256" | "RS512";

// A classe viaja na credencial; quem a confere e a borda (o tv3ws so emite).
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

// Duracao do accessToken em segundos (a norma C.6.1.3 define expiresIn como
// duracao, nao instante).
const ACCESS_TOKEN_TTL = 24 * 60 * 60;

// Autorizacao no Redis, que sobrevive a reinicio:
// - client:{id}         HASH  classe e credenciais emitidas;
// - clients:authorized  SET   clientids autorizados pelo espectador;
// - clients:blocked     SET   clientids recusados (a borda recusa o token deles com 107).
// Um clientid fica em no maximo um dos conjuntos; as funcoes do Redis (redis-funcoes.ts) mantem isso.
// authorizedClients e cache do objeto vivo de quem esta gravado. pendingClients guarda o nao local que
// aceitou o pop-up, com o material do pareamento, ate o /tv3/token que confere o desafio (C.4.2.3); so em
// memoria, um reinicio do tv3ws o perde.
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

// Autorizado = membro de clients:authorized. O conjunto (e nao o cache em
// memoria) decide, para que um bloqueio gravado no armazenamento valha aqui
// tambem.
export async function isAuthorized(id: string): Promise<boolean> {
    return (await redis.sismember(AUTHORIZED_KEY, id)) === 1;
}

// Para o 101 no reuso de clientid (C.6.1.2, Tabela C.3). 'used' inclui quem so tem o registro client:{id};
// a tentativa pendente do nao local nao conta.
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

export async function AuthorizeClient(id: string, clientClass: ClientClass = 'local-autonomous'): Promise<Client> {
    const client = new Client(id, clientClass);
    await funcoes.clienteAutoriza(id, clientFields(client));
    authorizedClients.set(id, client);
    return client;
}

// "Sim" do nao local: nada vai ao Redis antes do pareamento concluido (C.4.2.3).
export function StartPairing(id: string): Client {
    const client = new Client(id, 'non-local');
    pendingClients.set(id, client);
    return client;
}

export function GetPendingClient(id: string): Client | undefined {
    return pendingClients.get(id);
}

// Um novo /tv3/authorize do mesmo clientid encerra a tentativa pendente.
export function DiscardPending(id: string): void {
    pendingClients.delete(id);
}

// challenge-response conferido: grava a autorizacao; se a gravacao falhar, o cliente segue pendente.
export async function AuthorizePairedClient(client: Client): Promise<void> {
    const id = client.getId();
    await funcoes.clienteAutoriza(id, clientFields(client));
    if (pendingClients.get(id) === client) pendingClients.delete(id);
    authorizedClients.set(id, client);
}

// /tv3/token passa a recusar, e a borda recusa o accessToken ja emitido (107). O registro client:{id}
// fica, para que um desbloqueio (tela da C.4.2.2, nao implementada) restaure a autorizacao.
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

// Boot: poe em clients:authorized todo client:{id} nao bloqueado. Teste e insercao atomicos
// (tv30_cliente_inclui_autorizado), para um bloqueio no meio nao furar a invariante.
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
        const client = new Client(id, (stored.class as ClientClass) || 'local-autonomous');
        client.restore(stored.refreshToken, stored.accessToken);
        authorizedClients.set(id, client);
        return client;
    }
    throw Error(`Client ${id} is not authorized.`);
}

// Rotaciona o refresh token e persiste (a rotacao acontece a cada /token).
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


// expiresIn em segundos restantes (duracao, C.6.1.3); reaproveita o token ja emitido enquanto ele valer
export async function getClientAccessToken(id: string): Promise<[string, number]> {
    const client = await GetAuthorizedClient(id);
    const now = Math.floor(Date.now() / 1000);

    if (client.hasAccessToken()) {
        const token = client.getAccessToken();
        try {
            const payload = jwt.verify(token, jwtSecret) as TokenPayload;
            return [token, Math.max(payload.exp - now, 0)];
        } catch {
            // expirado/invalido: cai para emissao de um novo
        }
    }
    const token = createAccessToken('HS256', id, client.getClass());
    client.setAccessToken(token);
    await persistClient(client);
    return [token, ACCESS_TOKEN_TTL];
}
