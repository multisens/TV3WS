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

const blockedClients: string[] = [];
const authorizedClients = new Map<string, Client>();


export function isBlocked(id: string): boolean {
    return blockedClients.includes(id);
}

export function isAuthorized(id: string): boolean {
    return authorizedClients.has(id);
}

export function AuthorizeClient(id: string, clientClass: ClientClass = 'local-autonomous') {
    const client = new Client(id, clientClass);
    authorizedClients.set(id, client);
}

export function BlockClient(id: string) {
    blockedClients.push(id);
}

export function GetAuthorizedClient(id: string): Client {
    if (authorizedClients.has(id)) {
        return authorizedClients.get(id)!;
    }
    throw Error(`Client ${id} is not authorized.`);
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
export function getClientAccessToken(id: string): [string, number] {
    if (authorizedClients.has(id)) {
        const client = authorizedClients.get(id) as Client;
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
        return [token, ACCESS_TOKEN_TTL];
    }
    throw Error(`Client ${id} is not authorized.`);
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
