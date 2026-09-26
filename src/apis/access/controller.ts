import * as dotenv from 'dotenv';
import { Request, Response } from 'express';
import logger from '../../logger';
import * as manager from '../../modules/auth-manager/manager'
import { ClientClass } from '../../modules/auth-manager/client';
import redis from '../../redis-client';
import service, { pairingMethods } from './service';
import { returnError, aes128ECBEncrypt, base64UrlDecode, aes128ECBDecrypt } from '../../util';
dotenv.config();


type TokenResponse = {
    accessToken: string
    tokenType: string
    expiresIn: number
    refreshToken: string
    serverCert?: string
};

// Classificacao P1: o cliente se classifica NO MOMENTO da autorizacao, por
// dois sinais — o metodo de pareamento separa nao-local de local (quem pede
// pareamento e nao-local), e o Origin confrontado com a lista de origens de
// aplicacoes associadas (origins:associated, escrita pela plataforma) separa
// associado de autonomo. Endereco de rede nao participa: em conteineres,
// requisicoes do proprio equipamento e da rede domestica chegam com o mesmo
// endereco (medido).
async function classifyClient(req: Request, pm: string | undefined): Promise<ClientClass> {
    if (pm !== undefined) return 'non-local';

    const origin = req.get('Origin');
    if (origin) {
        try {
            const scid = await redis.hget('origins:associated', origin);
            if (scid !== null) return 'local-associated';
        } catch (err: any) {
            logger.debug(`classifyClient: falha lendo origins:associated (${err?.message}); assumindo autonomo`);
        }
    }
    return 'local-autonomous';
}

async function GETAuthorize(req: Request, res: Response): Promise<void> {
    logger.debug('\nReceived call to /authorize');

    const clientId = req.query.clientid as string;
    const displayName = req.query['display-name'] as string;
    const pm = req.query.pm as string;
    const key = req.query.key as string;
    const clientClass = await classifyClient(req, pm);
    const local = clientClass !== 'non-local';

    if (!validateAuthorizeParameters(clientId, displayName, pm, key, local, res)) {
        return;
    }

    // Cliente local ja autorizado que perdeu o refresh token (recarga de
    // pagina, armazenamento limpo): reemite o token corrente sem nova
    // consulta ao espectador — o consentimento ja foi dado uma vez.
    if (local && manager.isAuthorized(clientId)) {
        res.status(200).json({
            refreshToken: manager.GetAuthorizedClient(clientId).getRefreshToken()
        });
        return;
    }

    const authorized = await checkAuthorization(clientId as string, displayName as string, clientClass, res);
    logger.debug(`GETAuthorize received authorized = ${authorized}`);
    if (!authorized) return;

    const client = manager.GetAuthorizedClient(clientId);

    if (local) {
        // If it is a local client, return a refresh token
        logger.debug(`Request came from local client (${clientClass})`);

        res.status(200).json({
            refreshToken: client.getRefreshToken()
        });
        return;
    }
    else {
        // It is a nom-local client proceede according to pairing mode
        let secret;

        if (pm == 'qrcode') {
            secret = service.generateQRCodeSecret(client);
        }
        else if (pm == 'kex') {
            secret = service.generatePINSecret(client, key);
        }

        res.status(200).json({
            challenge: service.generateChallenge(client, secret!)
        });
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

    // It is a nom-local client
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

// A antiga excecao por nome de exibicao ("guarana") — porta dos fundos que
// dispensava a consulta ao espectador — foi removida junto com a religacao
// deste caminho (IV.3 da vacina).
async function checkAuthorization(clientId: string, displayName: string, clientClass: ClientClass, res: Response): Promise<boolean> {
    if (manager.isAuthorized(clientId as string)) {
        returnError(res, 101, 'This client was already authorized before.');
        return false;
    }

    if (manager.isBlocked(clientId as string)) {
        returnError(res, 102, 'This client was not authorized before and is blocked.');
        return false;
    }

    const authorized = await service.askAuthorization(displayName as string);
    if (authorized) {
        manager.AuthorizeClient(clientId, clientClass);
    }
    else {
        manager.BlockClient(clientId);
        returnError(res, 102, 'Viewer did not authorize the client.');
    }
    return authorized;
}

function GETToken(req: Request, res: Response): void {
    logger.debug('\nReceived call to /token');

    const clientId = req.query.clientid as string;
    const challengeResponse = req.query['challenge-response'] as string;
    const refreshToken = req.query['refresh-token'] as string;

    if (clientId !== undefined && !manager.isAuthorized(clientId)) {
        returnError(res, 102, `Client ${clientId} is not authorized.`);
        return;
    }

    // A classe vem do registro feito na autorizacao (P1) — nao do endereco.
    const local = clientId !== undefined
        ? manager.GetAuthorizedClient(clientId).isLocal()
        : true;

    if (!validateTokenParameters(clientId, refreshToken, challengeResponse, local, req.protocol, res)) {
        return;
    }

    // Everything is fine. Generate response body
    const client = manager.GetAuthorizedClient(clientId);
    const [token, expire] = manager.getClientAccessToken(clientId as string);
    const resp: TokenResponse = {
		accessToken : token,
		tokenType : "Bearer",
		expiresIn : expire,
		refreshToken : client.updateRefreshToken()
	}
    
    // test if is first access of nom-local client
    if (!local && refreshToken === undefined && req.protocol == 'http') {
        logger.info(`First access of nom-local client ${clientId} send response encrypted`);
        
        resp.serverCert = process.env.HTTPS_CERT;

        const secret = client.getSecret();
        const data = Buffer.from(JSON.stringify(resp), 'utf8');
        const encr = aes128ECBEncrypt(data, secret);
        
        res.setHeader('Content-Type', 'application/octet-stream');
        res.status(200).send(encr);
    }
    else {
        res.status(200).json(resp);
    }
}

function validateTokenParameters(clientId: string, refreshToken: string, challengeResponse: string, local: boolean, protocol: string, res: Response): boolean {
    if (clientId === undefined) {
        returnError(res, 105, 'Required header clientid not defined.');
        return false;
    }
    if (challengeResponse === undefined && refreshToken === undefined) {
        returnError(res, 105, 'One of [challenge-response, refresh-token] headers should be defined.');
        return false;
    }

    const client = manager.GetAuthorizedClient(clientId);

    // A refresh-token was provided
    if (refreshToken){
        // If it came from a nom-local client should be via HTTPS
        if (!local && protocol !== 'https') {
            logger.debug('Request came from nom-local client without https');
            returnError(res, 106, 'Subsequent calls should use HTTPS protocol.');
            return false;
        }
        
        // Try to validate the refresh-token
        if(!client.validateRefreshToken(refreshToken as string)) {
            returnError(res, 101, `The received refresh-token is not associated to client ${clientId}`);
            return false;
        }
    }
    // Otherwise, validate the challenge response
    else if (challengeResponse) {
        let response = base64UrlDecode(challengeResponse);
        response = aes128ECBDecrypt(response, client.getSecret());

        if (!client.validateChallenge(response.toString())) {
            returnError(res, 102, `Challenge response not correct for client ${clientId}`);
            return false;
        }
    }

    return true;
}


export default { GETAuthorize, GETToken }