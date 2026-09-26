import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Client, { ClientClass } from './client';
dotenv.config();

export type TokenAlg = "HS256" | "HS512" | "RS256" | "RS512";

type TokenHeader = {
    typ: string;
    alg: TokenAlg;
}

// A classe de cliente viaja NA credencial (P1): decidida uma vez na
// autorizacao, lida daqui em diante — nunca reinferida de endereco de rede.
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

// P5: a autorizacao de cliente vive no ARMAZENAMENTO (client:{id} e o
// conjunto clients:blocked) e sobrevive a reinicio. O Map em memoria e so
// cache do objeto vivo — que carrega tambem o material efemero de
// pareamento (secret/challenge/ECDH), valido apenas durante o handshake.
import redis from '../../redis-client';

const clientKey = (id: string) => `client:${id}`;
const BLOCKED_KEY = 'clients:blocked';

const authorizedClients = new Map<string, Client>();

async function persistClient(client: Client): Promise<void> {
    const fields: Record<string, string> = {
        class: client.getClass(),
        refreshToken: client.getRefreshToken(),
    };
    if (client.hasAccessToken()) fields.accessToken = client.getAccessToken();
    await redis.hset(clientKey(client.getId()), fields);
}

export async function isBlocked(id: string): Promise<boolean> {
    return (await redis.sismember(BLOCKED_KEY, id)) === 1;
}

export async function isAuthorized(id: string): Promise<boolean> {
    if (authorizedClients.has(id)) return true;
    return (await redis.exists(clientKey(id))) === 1;
}

export async function AuthorizeClient(id: string, clientClass: ClientClass = 'local-autonomous'): Promise<void> {
    const client = new Client(id, clientClass);
    authorizedClients.set(id, client);
    await persistClient(client);
}

export async function BlockClient(id: string): Promise<void> {
    await redis.sadd(BLOCKED_KEY, id);
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
// C.6.1.3) — o valor antigo carregava o instante de expiracao.
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


export function validateAccessToken(token: string): boolean {
    return decodeAccessToken(token) !== null;
}

// Verifica assinatura/emissor/validade e devolve o payload — e por aqui que
// os middlewares leem a classe do cliente. null = credencial invalida.
export function decodeAccessToken(raw: string): TokenPayload | null {
    try {
        const token = raw.replace(/^Bearer\s+/i, '');
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded || typeof decoded !== 'object') {
            return null;
        }

        const { header, payload } = decoded as unknown as { header: TokenHeader; payload: TokenPayload };
        if (!header || !payload) {
            return null;
        }

        jwt.verify(token, jwtSecret, { algorithms: [header.alg as any], issuer: jwtIssuer });
        return payload;
    }
    catch (error) {
        return null;
    }
}

// Classe declarada na credencial da requisicao. Sem credencial (fase de
// transicao — a exigencia na borda e trabalho do item 9/P2), assume-se
// cliente local autonomo.
export function getRequestClass(authorization?: string): ClientClass {
    if (!authorization) return 'local-autonomous';
    const payload = decodeAccessToken(authorization);
    return payload?.class ?? 'local-autonomous';
}
