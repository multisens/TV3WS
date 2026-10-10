import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Client, { ClientClass } from './client';
import { execOrThrow } from '../../util/redis-result';
dotenv.config();

export type TokenAlg = "HS256" | "HS512" | "RS256" | "RS512";

// A classe de cliente viaja NA credencial (P1): decidida uma vez na
// autorizacao e gravada no token emitido aqui. Quem LE a credencial e a
// borda (D-0510-1, reuniao 05/10 com o Joel: toda validacao de credencial
// fica no plugin tv30-auth do edgegateway; o tv3ws so emite).
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

// P5: a autorizacao de cliente vive no ARMAZENAMENTO e sobrevive a reinicio:
// - client:{id}         HASH  classe e credenciais emitidas;
// - clients:authorized  SET   clientids autorizados pelo espectador;
// - clients:blocked     SET   clientids recusados/bloqueados (a borda
//                             recusa o token deles com 107).
// D-0510-4 (reuniao 05/10 com o Joel): os AUTORIZADOS tambem ficam num
// conjunto, base da futura tela de gerenciamento (o espectador bloqueia e
// desbloqueia). Invariante: um clientid esta em no maximo um dos dois
// conjuntos — autorizar e bloquear sao transacoes (MULTI). O Map em memoria
// e so cache do objeto vivo, que carrega tambem o material efemero de
// pareamento (secret/challenge/ECDH), valido apenas durante o handshake.
import redis from '../../redis-client';

const clientKey = (id: string) => `client:${id}`;
const AUTHORIZED_KEY = 'clients:authorized';
const BLOCKED_KEY = 'clients:blocked';

const authorizedClients = new Map<string, Client>();

function clientFields(client: Client): Record<string, string> {
    const fields: Record<string, string> = {
        class: client.getClass(),
        refreshToken: client.getRefreshToken(),
    };
    if (client.hasAccessToken()) fields.accessToken = client.getAccessToken();
    return fields;
}

async function persistClient(client: Client): Promise<void> {
    await redis.hset(clientKey(client.getId()), clientFields(client));
}

// Autorizado = membro de clients:authorized. O conjunto (e nao o cache em
// memoria) decide, para que um bloqueio gravado no armazenamento valha aqui
// tambem.
export async function isAuthorized(id: string): Promise<boolean> {
    return (await redis.sismember(AUTHORIZED_KEY, id)) === 1;
}

// Situacao de um clientid para a C.6.1.2 (101 no reuso, Tabela C.3):
// 'blocked' = recusado/bloqueado pelo espectador; 'used' = ja autorizado
// neste receptor (inclusive registro client:{id} anterior ao conjunto
// clients:authorized); 'new' = nunca visto.
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

export async function AuthorizeClient(id: string, clientClass: ClientClass = 'local-autonomous'): Promise<void> {
    const client = new Client(id, clientClass);
    await execOrThrow(redis.multi()
        .hset(clientKey(id), clientFields(client))
        .srem(BLOCKED_KEY, id)
        .sadd(AUTHORIZED_KEY, id));
    authorizedClients.set(id, client);
}

// Bloqueio (recusa no pop-up; no futuro, a tela de gerenciamento): sai de
// clients:authorized e entra em clients:blocked. /tv3/token passa a recusar
// (nao autorizado) e a borda recusa o accessToken ja emitido (107).
// PENDENTE (Joel): o registro client:{id} de um cliente bloqueado depois de
// autorizado e mantido (minimo: nada se apaga); o que o desbloqueio faz com
// ele (reaproveita o refresh token ou exige nova autorizacao) e decisao da
// futura tela.
export async function BlockClient(id: string): Promise<void> {
    authorizedClients.delete(id);
    await execOrThrow(redis.multi()
        .srem(AUTHORIZED_KEY, id)
        .sadd(BLOCKED_KEY, id));
}

// Base da futura tela de gerenciamento (D-0510-4): so leitura, sem UI.
export async function listAuthorizedClients(): Promise<string[]> {
    return (await redis.smembers(AUTHORIZED_KEY)).sort();
}

export async function listBlockedClients(): Promise<string[]> {
    return (await redis.smembers(BLOCKED_KEY)).sort();
}

// Clientes autorizados antes do conjunto clients:authorized existir so tem
// client:{id}. Roda uma vez no boot (server.ts): poe no conjunto todo
// client:{id} que nao esteja bloqueado. O teste-e-insercao e atomico (Lua)
// para nao furar a invariante se um bloqueio acontecer no meio.
const ADD_UNLESS_BLOCKED = `if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then
  return redis.call('SADD', KEYS[1], ARGV[1])
end
return 0`;

export async function backfillAuthorizedClients(): Promise<number> {
    let cursor = '0';
    let added = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'client:*', 'COUNT', 200);
        cursor = next;
        for (const key of keys) {
            const id = key.slice('client:'.length);
            added += Number(await redis.eval(ADD_UNLESS_BLOCKED, 2, AUTHORIZED_KEY, BLOCKED_KEY, id));
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


// Devolve [token, expiresIn] com expiresIn em SEGUNDOS RESTANTES (duracao,
// C.6.1.3) — o valor antigo carregava o instante de expiracao. Reaproveita o
// token ja emitido enquanto ele valer (parte da emissao, nao validacao de
// requisicao).
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
