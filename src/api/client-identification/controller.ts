import * as dotenv from 'dotenv';
import { Request, Response } from 'express';
import logger from '../../logger';
import * as manager from '../../modules/auth-manager/manager'
import Client, { ClientClass, PairingMaterial } from '../../modules/auth-manager/client';
import redis from '../../redis-client';
import service, { pairingMethods, Reserva } from './service';
import { returnError, aes128ECBEncrypt, base64UrlDecode, base64UrlEncode, aes128ECBDecrypt } from '../../util';
import { serverCert } from '../../tls';
dotenv.config();


type TokenResponse = {
    accessToken: string
    tokenType: string
    expiresIn: number
    refreshToken: string
    serverCert?: string
};

// Classe definida na autorizacao: quem pede pareamento e nao local; Origin em origins:associated e
// associado; o resto, autonomo. Endereco nao serve: em container, equipamento e rede domestica chegam
// iguais. Limitacao conhecida, a mesma da borda: o Origin e forjavel fora do navegador.
async function classifyClient(req: Request, pm: string | undefined): Promise<ClientClass> {
    if (pm !== undefined) return 'non-local';

    const origin = req.get('Origin');
    if (origin) {
        const scid = await redis.hget('origins:associated', origin);
        if (scid !== null) return 'local-associated';
    }
    return 'local-autonomous';
}

// Vazio ou so espacos vale como ausente (105, Tabelas C.3 e C.4): a string vazia passaria pelos testes
// de undefined sem cair em ramo nenhum. Valor nao vazio segue sem trim; pm= vazio classifica local.
function queryParam(req: Request, name: string): string | undefined {
    const value = req.query[name];
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value as string | undefined;
}

async function GETAuthorize(req: Request, res: Response): Promise<void> {
    logger.debug('\nReceived call to /authorize');

    const clientId = queryParam(req, 'clientid') as string;
    const displayName = queryParam(req, 'display-name') as string;
    const pm = queryParam(req, 'pm') as string;
    const key = queryParam(req, 'key') as string;
    const clientClass = await classifyClient(req, pm);
    const local = clientClass !== 'non-local';

    // o associado nao porta credencial (C.4.1.1; Tabela C.3, 106). A borda tambem recusa o uso;
    // aqui se impede que a credencial exista.
    if (clientClass === 'local-associated') {
        returnError(res, 106, 'associated local clients do not obtain credentials (C.4.1.1); invoked from an associated local client');
        return;
    }

    if (!validateAuthorizeParameters(clientId, displayName, pm, key, local, res)) {
        return;
    }

    // a reserva da camada grafica sai no fim do pedido, salvo se ja passou ao pop-up do pareamento
    const reserva: { r?: Reserva } = {};
    try {
        await authorizeReserved(res, clientId, displayName, pm, key, clientClass, local, reserva);
    } finally {
        service.liberarReserva(reserva.r);
    }
}

// O resto do /tv3/authorize, com a camada grafica ja reservada (ou o 103).
async function authorizeReserved(res: Response, clientId: string, displayName: string,
                                 pm: string, key: string, clientClass: ClientClass, local: boolean,
                                 reserva: { r?: Reserva }): Promise<void> {
    const authorized = await checkAuthorization(clientId as string, displayName as string, clientClass, res, reserva);
    logger.debug(`GETAuthorize received authorized = ${authorized}`);
    if (!authorized) return;

    const client = await manager.GetAuthorizedClient(clientId);

    if (local) {
        logger.debug(`Request came from local client (${clientClass})`);

        res.status(200).json({
            refreshToken: client.getRefreshToken()
        });
        return;
    }
    else {
        let secret;

        if (pm == 'qrcode') {
            secret = service.generateQRCodeSecret(client);
        }
        else if (pm == 'kex') {
            secret = service.generatePINSecret(client, key);
        }

        const challenge = service.generateChallenge(client, secret!);
        if (pm == 'kex') {
            // Tabela C.3, formato (3), e C.4.3.3 passo 1: no kex vai tambem "key", a chave parcial do
            // servidor (ponto SEC 1 sem compressao em base64url, C.4.3.4)
            res.status(200).json({
                challenge,
                key: base64UrlEncode(client.getECDHPublicKey())
            });
            return;
        }
        res.status(200).json({ challenge });
    }
}

function validateAuthorizeParameters(clientId: string, displayName: string, pm: string, key: string, local: boolean, res: Response): boolean {
    if (clientId === undefined || displayName === undefined) {
        returnError(res, 105, 'Required headers clientid and/or display-name not defined.');
        return false;
    }

    if (local) {
        return true;
    }

    if (pm === undefined) {
        returnError(res, 105, 'Header pm should be defined for nom-local clients.');
        return false
    }

    if (!pairingMethods.includes(pm as string)) {
        returnError(res, 101, 'Unsupported pairing method.');
        return false
    }

    if (pm == 'kex' && key === undefined) {
        returnError(res, 105, 'Header key should be defined for kex pairing mode.');
        return false
    }

    return true;
}

// Clientid ja usado da 101 para qualquer classe, sem pop-up (Tabela C.3; C.6.1.4.4): em clients:authorized,
// em clients:blocked ou com registro client:{id}. Bloqueado tambem da 101 (nota da Tabela C.3); o 102 fica
// para a recusa no pop-up. Quem perdeu o refresh token repete com clientid novo (C.6.1.4.5).
async function checkAuthorization(clientId: string, displayName: string, clientClass: ClientClass, res: Response,
                                  reserva: { r?: Reserva }): Promise<boolean> {
    const status = await manager.clientIdStatus(clientId as string);
    if (status === 'used') {
        returnError(res, 101, 'clientid has been used before (already authorized); retry with a new clientid.');
        return false;
    }

    if (status === 'blocked') {
        returnError(res, 101, 'clientid has been used before (blocked by the viewer); retry with a new clientid.');
        return false;
    }

    // 103 com a camada grafica ocupada (C.4.2.3, Tabela C.3), so para quem chegaria ao pop-up. Entre a
    // reserva e a publicacao do sim/nao nao ha await: dois pedidos nao reservam juntos.
    reserva.r = service.reservarCamada(clientId);
    if (!reserva.r) {
        returnError(res, 103, 'another authorization or pairing pop-up is on screen; try again later.');
        return false;
    }

    const authorized = await service.askAuthorization(displayName as string);
    if (authorized) {
        await manager.AuthorizeClient(clientId, clientClass);
    }
    else {
        await manager.BlockClient(clientId);
        returnError(res, 102, 'Viewer did not authorize the client.');
    }
    return authorized;
}

async function GETToken(req: Request, res: Response): Promise<void> {
    logger.debug('\nReceived call to /token');

    const clientId = queryParam(req, 'clientid') as string;
    const challengeResponse = queryParam(req, 'challenge-response') as string;
    const refreshToken = queryParam(req, 'refresh-token') as string;

    if (clientId !== undefined && !(await manager.isAuthorized(clientId))) {
        returnError(res, 102, `Client ${clientId} is not authorized.`);
        return;
    }

    // a classe vem do registro feito na autorizacao, nao do endereco
    const registered = clientId !== undefined ? await manager.GetAuthorizedClient(clientId) : undefined;
    const local = registered !== undefined ? registered.isLocal() : true;

    // Tabela C.4, 106: nem um registro client:{id} de classe associada recebe credencial
    if (registered !== undefined && registered.getClass() === 'local-associated') {
        returnError(res, 106, 'associated local clients do not obtain credentials (C.4.1.1)');
        return;
    }

    const valid = await validateTokenParameters(clientId, refreshToken, challengeResponse, local, req.protocol, res);
    if (!valid) {
        return;
    }

    // No challenge-response, o material do pareamento (de onde vem a chave da primeira resposta) ja saiu do
    // cliente; se a emissao falhar, ele volta e a tentativa segue aberta.
    const { client, pairing } = valid;
    let encr: Buffer<ArrayBufferLike> | undefined;
    let resp: TokenResponse;
    try {
        const [token, expire] = await manager.getClientAccessToken(clientId as string);
        resp = {
            accessToken : token,
            tokenType : "Bearer",
            expiresIn : expire,
            refreshToken : await manager.rotateRefreshToken(clientId)
        };

        if (!local && refreshToken === undefined && req.protocol == 'http') {
            logger.info(`First access of nom-local client ${clientId} send response encrypted`);

            // o certificado do receptor, o mesmo da 44643
            resp.serverCert = serverCert();

            // sem o material (nao deveria acontecer: este ramo so passa
            // pelo challenge-response conferido), nada sai em claro
            const secret = pairing?.secret;
            if (secret === undefined) {
                throw Error(`Client ${clientId} has no pairing key to encrypt the first-access response.`);
            }
            const data = Buffer.from(JSON.stringify(resp), 'utf8');
            encr = aes128ECBEncrypt(data, secret);
        }
    } catch (err) {
        if (pairing) client.restorePairingMaterial(pairing);
        throw err;
    }

    if (encr !== undefined) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.status(200).send(encr);
    }
    else {
        res.status(200).json(resp);
    }

    // fim do pareamento: o challenge-response conferiu e a credencial saiu; fecha o pop-up (C.4.3.2, C.4.3.3)
    if (!refreshToken && challengeResponse) {
        service.endPairing(clientId);
    }
}

// Requisicao do /tv3/token conferida: o cliente e, quando ela veio por
// challenge-response, o material do pareamento ja tirado dele.
type ValidToken = { client: Client; pairing?: PairingMaterial };

async function validateTokenParameters(clientId: string, refreshToken: string, challengeResponse: string, local: boolean, protocol: string, res: Response): Promise<ValidToken | false> {
    if (clientId === undefined) {
        returnError(res, 105, 'Required header clientid not defined.');
        return false;
    }
    if (challengeResponse === undefined && refreshToken === undefined) {
        returnError(res, 105, 'One of [challenge-response, refresh-token] headers should be defined.');
        return false;
    }

    const client = await manager.GetAuthorizedClient(clientId);

    if (refreshToken !== undefined) {
        if (!local && protocol !== 'https') {
            logger.debug('Request came from nom-local client without https');
            returnError(res, 106, 'Subsequent calls should use HTTPS protocol.');
            return false;
        }

        if(!client.validateRefreshToken(refreshToken as string)) {
            returnError(res, 101, `The received refresh-token is not associated to client ${clientId}`);
            return false;
        }
        return { client };
    }

    // O challenge vale uma vez. Sem challenge pendente (pareamento concluido, cliente local, reinicio do
    // tv3ws), 102, o mesmo do desafio errado (Tabela C.4).
    if (!client.hasPendingChallenge()) {
        returnError(res, 102, `No pending challenge for client ${clientId} (pairing already concluded or not started)`);
        return false;
    }
    // challenge-response que nao decifra (padding PKCS#7 invalido) ou nao e texto (parametro repetido) tambem
    // da 102: outro codigo distinguiria erro de padding de hash errado
    let response: Buffer<ArrayBufferLike>;
    try {
        if (typeof challengeResponse !== 'string') throw new TypeError('challenge-response is not a single value');
        response = aes128ECBDecrypt(base64UrlDecode(challengeResponse), client.getSecret());
    } catch (err) {
        logger.debug(`challenge-response of client ${clientId} not decrypted: ${(err as Error)?.message}`);
        returnError(res, 102, `Challenge response not correct for client ${clientId}`);
        return false;
    }

    if (!client.validateChallenge(response)) {
        returnError(res, 102, `Challenge response not correct for client ${clientId}`);
        return false;
    }

    // O material do pareamento sai no mesmo trecho sincrono da conferencia: dois /tv3/token simultaneos com o
    // mesmo challenge-response nao passam os dois. A Tabela C.4 permite descartar a chave apos o primeiro acesso.
    return { client, pairing: client.takePairingMaterial() };
}


export default { GETAuthorize, GETToken }