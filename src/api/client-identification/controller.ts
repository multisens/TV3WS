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

// Class decided at authorization: a client that asks for pairing is
// non-local; one with an Origin in origins:associated is associated; any
// other is stand-alone.
async function classifyClient(req: Request, pm: string | undefined): Promise<ClientClass> {
    if (pm !== undefined) return 'non-local';

    const origin = req.get('Origin');
    if (origin) {
        const scid = await redis.hget('origins:associated', origin);
        if (scid !== null) return 'local-associated';
    }
    return 'local-autonomous';
}

// An empty or blank value counts as absent (105, Tables C.3 and C.4). A
// non-empty value is kept untrimmed; an empty pm= classifies as local.
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

    // The associated client gets no credential (C.4.1.1; Table C.3, 106).
    if (clientClass === 'local-associated') {
        returnError(res, 106, 'associated local clients do not obtain credentials (C.4.1.1); invoked from an associated local client');
        return;
    }

    if (!validateAuthorizeParameters(clientId, displayName, pm, key, local, res)) {
        return;
    }

    // The reservation of the graphics layer is released at the end of the
    // request, unless it passed to the pairing pop-up.
    const reserva: { r?: Reserva } = {};
    try {
        await authorizeReserved(res, clientId, displayName, pm, key, clientClass, local, reserva);
    } finally {
        service.liberarReserva(reserva.r);
    }
}

// The rest of /tv3/authorize, with the graphics layer reserved (or 103).
async function authorizeReserved(res: Response, clientId: string, displayName: string,
                                 pm: string, key: string, clientClass: ClientClass, local: boolean,
                                 reserva: { r?: Reserva }): Promise<void> {
    const client = await checkAuthorization(clientId as string, displayName as string, clientClass, res, reserva);
    logger.debug(`GETAuthorize received authorized = ${client !== undefined}`);
    if (client === undefined) return;

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
            // Table C.3, format (3), and C.4.3.3 step 1: for kex, "key" too,
            // the partial key of the server (SEC 1 point without compression in
            // base64url, C.4.3.4).
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

// A clientid already used gives 101 for any class, without a pop-up (Table
// C.3; C.6.1.4.4): in clients:authorized, in clients:blocked or with a
// client:{id} record. A blocked one also gives 101 (note of Table C.3); 102
// is for a refusal in the pop-up. A pending attempt of a non-local client
// does not count: the new request discards it and goes on as new. Returns
// the authorized client (a non-local one still pending) or undefined, with
// the error already answered.
async function checkAuthorization(clientId: string, displayName: string, clientClass: ClientClass, res: Response,
                                  reserva: { r?: Reserva }): Promise<Client | undefined> {
    const status = await manager.clientIdStatus(clientId as string);
    if (status === 'used') {
        returnError(res, 101, 'clientid has been used before (already authorized); retry with a new clientid.');
        return undefined;
    }

    if (status === 'blocked') {
        returnError(res, 101, 'clientid has been used before (blocked by the viewer); retry with a new clientid.');
        return undefined;
    }

    manager.DiscardPending(clientId);

    // 103 with the graphics layer busy (C.4.2.3, Table C.3), only for a request
    // that would reach the pop-up. No await between the reservation and the
    // publication of the yes/no: two requests do not reserve together.
    reserva.r = service.reservarCamada(clientId);
    if (!reserva.r) {
        returnError(res, 103, 'another authorization or pairing pop-up is on screen; try again later.');
        return undefined;
    }

    const authorized = await service.askAuthorization(displayName as string);
    if (!authorized) {
        // The refusal is stored at once, for both classes.
        await manager.BlockClient(clientId);
        returnError(res, 102, 'Viewer did not authorize the client.');
        return undefined;
    }
    // The yes of a non-local client is stored only when /tv3/token checks the
    // challenge.
    if (clientClass === 'non-local') return manager.StartPairing(clientId);
    return manager.AuthorizeClient(clientId, clientClass);
}

async function GETToken(req: Request, res: Response): Promise<void> {
    logger.debug('\nReceived call to /token');

    const clientId = queryParam(req, 'clientid') as string;
    const challengeResponse = queryParam(req, 'challenge-response') as string;
    const refreshToken = queryParam(req, 'refresh-token') as string;

    // Without refresh-token, the pending attempt of a non-local client counts,
    // stored only with the challenge-response checked; with it, only the stored
    // authorization.
    const pending = clientId !== undefined && refreshToken === undefined ? manager.GetPendingClient(clientId) : undefined;
    if (clientId !== undefined && pending === undefined && !(await manager.isAuthorized(clientId))) {
        returnError(res, 102, `Client ${clientId} is not authorized.`);
        return;
    }

    // The class comes from the record made at authorization.
    const registered = clientId !== undefined ? pending ?? await manager.GetAuthorizedClient(clientId) : undefined;
    const local = registered !== undefined ? registered.isLocal() : true;

    // Table C.4, 106: not even a client:{id} record of the associated class
    // gets a credential.
    if (registered !== undefined && registered.getClass() === 'local-associated') {
        returnError(res, 106, 'associated local clients do not obtain credentials (C.4.1.1)');
        return;
    }

    const valid = validateTokenParameters(clientId, refreshToken, challengeResponse, registered, local, req.protocol, res);
    if (!valid) {
        return;
    }

    // With challenge-response, the pairing material (the source of the key of
    // the first response) was already taken from the client; if storing the
    // authorization or issuing fails, it is restored and the attempt stays
    // open.
    const { client, pairing } = valid;
    let encr: Buffer<ArrayBufferLike> | undefined;
    let resp: TokenResponse;
    try {
        if (pairing) await manager.AuthorizePairedClient(client);
        const [token, expire] = await manager.getClientAccessToken(clientId as string);
        resp = {
            accessToken : token,
            tokenType : "Bearer",
            expiresIn : expire,
            refreshToken : await manager.rotateRefreshToken(clientId)
        };

        if (!local && refreshToken === undefined && req.protocol == 'http') {
            logger.info(`First access of nom-local client ${clientId} send response encrypted`);

            // The certificate of the receiver.
            resp.serverCert = serverCert();

            // Without the material, nothing goes out in clear text.
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

    // End of the pairing: the challenge-response matched and the credential
    // went out; closes the pop-up (C.4.3.2, C.4.3.3).
    if (!refreshToken && challengeResponse) {
        service.endPairing(clientId);
    }
}

// A checked /tv3/token request: the client and, when it came by
// challenge-response, the pairing material already taken from it.
type ValidToken = { client: Client; pairing?: PairingMaterial };

// Synchronous: no await from the lookup of the pending attempt to the
// removal of the material.
function validateTokenParameters(clientId: string, refreshToken: string, challengeResponse: string, registered: Client | undefined, local: boolean, protocol: string, res: Response): ValidToken | false {
    if (clientId === undefined || registered === undefined) {
        returnError(res, 105, 'Required header clientid not defined.');
        return false;
    }
    if (challengeResponse === undefined && refreshToken === undefined) {
        returnError(res, 105, 'One of [challenge-response, refresh-token] headers should be defined.');
        return false;
    }

    const client = registered;

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

    // The challenge is valid once. Without a pending challenge (pairing
    // concluded, local client, tv3ws restart), 102, the same as a wrong
    // challenge (Table C.4).
    if (!client.hasPendingChallenge()) {
        returnError(res, 102, `No pending challenge for client ${clientId} (pairing already concluded or not started)`);
        return false;
    }
    // A challenge-response that does not decrypt (invalid PKCS#7 padding) or is
    // not a single text (repeated parameter) also gives 102: another code would
    // tell a padding error from a wrong hash.
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

    // The pairing material is taken in the same synchronous stretch as the
    // check: two simultaneous /tv3/token calls with the same
    // challenge-response do not both pass.
    return { client, pairing: client.takePairingMaterial() };
}


export default { GETAuthorize, GETToken }