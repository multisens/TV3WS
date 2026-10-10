import * as dotenv from 'dotenv';
import { Request, Response } from 'express';
import logger from '../../logger';
import * as manager from '../../modules/auth-manager/manager'
import { ClientClass } from '../../modules/auth-manager/client';
import redis from '../../redis-client';
import service, { pairingMethods } from './service';
import { returnError, aes128ECBEncrypt, base64UrlDecode, base64UrlEncode, aes128ECBDecrypt } from '../../util';
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
// DECIDIDO (Luis, 03/10): risco aceito — lacuna L1. O Origin eh forjavel
// fora do navegador: quem manda uma origem presente em origins:associated eh
// classificado aqui como associado. Mesmo criterio e mesmo risco do plugin
// da borda (infra/edgegateway/plugin/handler.go); sem mudanca de
// comportamento.
// D-0510-6 (reuniao 05/10 com o Joel): falha lendo origins:associated nao
// vira mais "autonomo" em silencio (classe errada gravada na credencial):
// o erro sobe e a resposta e 404 {error:200} (errorHandler, C.3.2).
async function classifyClient(req: Request, pm: string | undefined): Promise<ClientClass> {
    if (pm !== undefined) return 'non-local';

    const origin = req.get('Origin');
    if (origin) {
        const scid = await redis.hget('origins:associated', origin);
        if (scid !== null) return 'local-associated';
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

    // DECIDIDO (Luis, 03/10): 101 no reuso de clientid, para qualquer classe
    // (ver checkAuthorization). Saiu daqui o atalho que reemitia o refresh
    // token ao cliente local ja autorizado sem nova consulta ao espectador:
    // com ele, quem conhecesse o clientid de outro cliente local obtinha um
    // token com a classe dele. Quem perdeu o refresh token repete a
    // autorizacao com clientid NOVO, e o espectador e consultado de novo
    // (C.6.1.4.5, p. 219; p. 237 do PDF).

    const authorized = await checkAuthorization(clientId as string, displayName as string, clientClass, res);
    logger.debug(`GETAuthorize received authorized = ${authorized}`);
    if (!authorized) return;

    const client = await manager.GetAuthorizedClient(clientId);

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

        const challenge = service.generateChallenge(client, secret!);
        if (pm == 'kex') {
            // Tabela C.3, formato (3) (p. 214; p. 232 do PDF) e C.4.3.3 passo 1
            // (p. 210; p. 228 do PDF): no kex a resposta leva tambem "key", a
            // chave parcial do servidor (ponto SEC 1 sem compressao em
            // base64url, C.4.3.4). Sem ela o cliente nao deriva a chave
            // simetrica e nao resolve o challenge. Correcao de conformidade
            // feita na integracao de 04/10; A CONFIRMAR (Luis).
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
//
// DECIDIDO (Luis, 03/10): clientid ja autorizado neste receptor da 101, para
// qualquer classe (local autonomo, local associado, nao local), sem pop-up.
// Na norma:
// - Tabela C.3 (p. 215; p. 233 do PDF), erro 101: "if clientid has been
//   used before";
// - C.6.1.4.4 (p. 219; p. 237 do PDF): usar na C.6.1.2 um clientid ja
//   usado eh colisao, e o servidor devolve 101; o cliente repete com
//   clientid diferente.
// Clientid recusado pelo espectador (clients:blocked): 101, e nao mais 102,
// pela nota da mesma Tabela C.3 ("any attempt to authorize immediately
// returns error 101, without displaying the authorization dialog"). Eh
// conformidade com a norma numa leitura da decisao acima feita na
// implementacao; A CONFIRMAR (Luis). O 102 fica so para a recusa no proprio
// pop-up ("If the user does not grant access").
// D-0510-4 (reuniao 05/10 com o Joel): "ja usado" = em clients:authorized,
// em clients:blocked ou com registro client:{id} (autorizacao anterior ao
// conjunto); uma leitura so (manager.clientIdStatus).
async function checkAuthorization(clientId: string, displayName: string, clientClass: ClientClass, res: Response): Promise<boolean> {
    const status = await manager.clientIdStatus(clientId as string);
    if (status === 'used') {
        returnError(res, 101, 'clientid has been used before (already authorized); retry with a new clientid.');
        return false;
    }

    if (status === 'blocked') {
        returnError(res, 101, 'clientid has been used before (blocked by the viewer); retry with a new clientid.');
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

    const clientId = req.query.clientid as string;
    const challengeResponse = req.query['challenge-response'] as string;
    const refreshToken = req.query['refresh-token'] as string;

    if (clientId !== undefined && !(await manager.isAuthorized(clientId))) {
        returnError(res, 102, `Client ${clientId} is not authorized.`);
        return;
    }

    // A classe vem do registro feito na autorizacao (P1) — nao do endereco.
    const local = clientId !== undefined
        ? (await manager.GetAuthorizedClient(clientId)).isLocal()
        : true;

    if (!(await validateTokenParameters(clientId, refreshToken, challengeResponse, local, req.protocol, res))) {
        return;
    }

    // Everything is fine. Generate response body
    const client = await manager.GetAuthorizedClient(clientId);
    const [token, expire] = await manager.getClientAccessToken(clientId as string);
    const resp: TokenResponse = {
		accessToken : token,
		tokenType : "Bearer",
		expiresIn : expire,
		refreshToken : await manager.rotateRefreshToken(clientId)
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

async function validateTokenParameters(clientId: string, refreshToken: string, challengeResponse: string, local: boolean, protocol: string, res: Response): Promise<boolean> {
    if (clientId === undefined) {
        returnError(res, 105, 'Required header clientid not defined.');
        return false;
    }
    if (challengeResponse === undefined && refreshToken === undefined) {
        returnError(res, 105, 'One of [challenge-response, refresh-token] headers should be defined.');
        return false;
    }

    const client = await manager.GetAuthorizedClient(clientId);

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