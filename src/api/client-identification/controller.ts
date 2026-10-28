import * as dotenv from 'dotenv';
import { Request, Response } from 'express';
import logger from '../../logger';
import * as manager from '../../modules/auth-manager/manager';
import Client, { ClientClass, PairingMaterial } from '../../modules/auth-manager/client';
import redis from '../../redis-client';
import service, { pairingMethods, Reserva } from './service';
import { returnError, aes128ECBEncrypt, base64UrlDecode, base64UrlEncode, aes128ECBDecrypt } from '../../util';
import { serverCert } from '../../tls';
dotenv.config();

type TokenResponse = {
    accessToken: string;
    tokenType: string;
    expiresIn: number;
    refreshToken: string;
    serverCert?: string;
};

// Pairing asked by a non-local client in /tv3/authorize (C.4.3).
type Pairing = { method: 'qrcode' } | { method: 'kex'; key: string };

// Checked parameters of /tv3/authorize; pairing only for a non-local
// client.
type AuthorizeParams = {
    clientId: string;
    displayName: string;
    pairing?: Pairing;
};

// A checked /tv3/token request: the client and, when it came by
// challenge-response, the pairing material already taken from it.
type ValidToken = { client: Client; pairing?: PairingMaterial };

async function GETAuthorize(req: Request, res: Response): Promise<void> {
    logger.debug('Received call to /authorize');

    const pm = queryParam(req, 'pm');
    const clientClass = await classifyClient(req, pm);

    // The associated client gets no credential (C.4.1.1; Table C.3, 106).
    if (clientClass === 'associated') {
        returnError(res, 106, 'associated local clients do not obtain credentials (C.4.1.1); invoked from an associated local client');
        return;
    }

    const params = validateAuthorizeParameters(req, clientClass, pm, res);
    if (params === undefined) {
        return;
    }

    // The reservation of the graphics layer is released at the end of the
    // request, unless it passed to the pairing pop-up.
    const reservation: { r?: Reserva } = {};
    try {
        await authorizeReserved(res, params, clientClass, reservation);
    } finally {
        service.liberarReserva(reservation.r);
    }
}

async function GETToken(req: Request, res: Response): Promise<void> {
    logger.debug('Received call to /token');

    const clientId = queryParam(req, 'clientid');
    const challengeResponse = queryParam(req, 'challenge-response');
    const refreshToken = queryParam(req, 'refresh-token');

    // Without refresh-token, the pending attempt of a non-local client counts,
    // stored only with the challenge-response checked; with it, only the stored
    // authorization.
    let pending: Client | undefined;
    if (clientId !== undefined && refreshToken === undefined) {
        pending = manager.getPendingClient(clientId);
    }
    if (clientId !== undefined && pending === undefined) {
        const authorized = await manager.isAuthorized(clientId);
        if (!authorized) {
            returnError(res, 102, `Client ${clientId} is not authorized.`);
            return;
        }
    }

    // The class comes from the record made at authorization.
    let registered: Client | undefined;
    if (clientId !== undefined) {
        registered = pending ?? await manager.getAuthorizedClient(clientId);
    }
    const local = registered !== undefined ? registered.isLocal() : true;

    // Table C.4, 106: not even a client:{id} record of the associated class
    // gets a credential.
    if (registered !== undefined && registered.getClass() === 'associated') {
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
    const id = client.getId();
    let encrypted: Buffer<ArrayBufferLike> | undefined;
    let resp: TokenResponse;
    try {
        if (pairing) {
            await manager.authorizePairedClient(client);
        }
        const [token, expire] = await manager.getClientAccessToken(id);
        resp = {
            accessToken: token,
            tokenType: 'Bearer',
            expiresIn: expire,
            refreshToken: await manager.rotateRefreshToken(id),
        };

        if (!local && refreshToken === undefined && req.protocol === 'http') {
            logger.info(`First access of non-local client ${id}: response encrypted`);

            // The certificate of the receiver.
            resp.serverCert = serverCert();

            // Without the material, nothing goes out in clear text.
            const secret = pairing?.secret;
            if (secret === undefined) {
                throw Error(`Client ${id} has no pairing key to encrypt the first-access response.`);
            }
            const data = Buffer.from(JSON.stringify(resp), 'utf8');
            encrypted = aes128ECBEncrypt(data, secret);
        }
    } catch (err) {
        if (pairing) {
            client.restorePairingMaterial(pairing);
        }
        throw err;
    }

    if (encrypted !== undefined) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.status(200).send(encrypted);
    } else {
        res.status(200).json(resp);
    }

    // End of the pairing: the challenge-response matched and the credential
    // went out; closes the pop-up (C.4.3.2, C.4.3.3).
    if (!refreshToken && challengeResponse) {
        service.endPairing(id);
    }
}

// The rest of /tv3/authorize, with the graphics layer reserved (or 103).
async function authorizeReserved(res: Response, params: AuthorizeParams, clientClass: ClientClass,
                                 reservation: { r?: Reserva }): Promise<void> {
    const client = await checkAuthorization(params, clientClass, res, reservation);
    logger.debug(`GETAuthorize received authorized = ${client !== undefined}`);
    if (client === undefined) {
        return;
    }

    const pairing = params.pairing;
    if (pairing === undefined) {
        logger.debug(`Request came from local client (${clientClass})`);
        res.status(200).json({
            refreshToken: client.getRefreshToken(),
        });
        return;
    }

    switch (pairing.method) {
        case 'qrcode': {
            const secret = service.generateQRCodeSecret(client);
            const challenge = service.generateChallenge(client, secret);
            res.status(200).json({ challenge });
            break;
        }
        case 'kex': {
            const secret = service.generatePINSecret(client, pairing.key);
            const challenge = service.generateChallenge(client, secret);
            // Table C.3, format (3), and C.4.3.3 step 1: for kex, "key" too,
            // the partial key of the server (SEC 1 point without compression in
            // base64url, C.4.3.4).
            res.status(200).json({
                challenge,
                key: base64UrlEncode(client.getECDHPublicKey()),
            });
            break;
        }
        default:
            break;
    }
}

// A clientid already used gives 101 for any class, without a pop-up (Table
// C.3; C.6.1.4.4): in clients:authorized, in clients:blocked or with a
// client:{id} record. A blocked one also gives 101 (note of Table C.3); 102
// is for a refusal in the pop-up. A pending attempt of a non-local client
// does not count: the new request discards it and goes on as new. Returns
// the authorized client (a non-local one still pending) or undefined, with
// the error already answered.
async function checkAuthorization(params: AuthorizeParams, clientClass: ClientClass, res: Response,
                                  reservation: { r?: Reserva }): Promise<Client | undefined> {
    const clientId = params.clientId;
    const status = await manager.clientIdStatus(clientId);
    if (status === 'used') {
        returnError(res, 101, 'clientid has been used before (already authorized); retry with a new clientid.');
        return undefined;
    }

    if (status === 'blocked') {
        returnError(res, 101, 'clientid has been used before (blocked by the viewer); retry with a new clientid.');
        return undefined;
    }

    manager.discardPending(clientId);

    // 103 with the graphics layer busy (C.4.2.3, Table C.3), only for a request
    // that would reach the pop-up. No await between the reservation and the
    // publication of the yes/no: two requests do not reserve together.
    reservation.r = service.reservarCamada(clientId);
    if (!reservation.r) {
        returnError(res, 103, 'another authorization or pairing pop-up is on screen; try again later.');
        return undefined;
    }

    const authorized = await service.askAuthorization(params.displayName);
    if (!authorized) {
        // The refusal is stored at once, for both classes.
        await manager.blockClient(clientId);
        returnError(res, 102, 'Viewer did not authorize the client.');
        return undefined;
    }
    // The yes of a non-local client is stored only when /tv3/token checks the
    // challenge.
    if (clientClass === 'nonLocal') {
        return manager.startPairing(clientId);
    }
    return manager.authorizeClient(clientId, clientClass);
}

// Class decided at authorization: a client that asks for pairing is
// non-local; one with an Origin in origins:associated is associated; any
// other is stand-alone.
async function classifyClient(req: Request, pm: string | undefined): Promise<ClientClass> {
    if (pm !== undefined) {
        return 'nonLocal';
    }

    const origin = req.get('Origin');
    if (origin) {
        const scid = await redis.hget('origins:associated', origin);
        if (scid !== null) {
            return 'associated';
        }
    }
    return 'standAlone';
}

// Returns the checked parameters of /tv3/authorize, or undefined with the
// error already answered.
function validateAuthorizeParameters(req: Request, clientClass: ClientClass, pm: string | undefined,
                                     res: Response): AuthorizeParams | undefined {
    const clientId = queryParam(req, 'clientid');
    const displayName = queryParam(req, 'display-name');
    if (clientId === undefined || displayName === undefined) {
        returnError(res, 105, 'Required headers clientid and/or display-name not defined.');
        return undefined;
    }

    if (clientClass !== 'nonLocal' || pm === undefined) {
        return { clientId, displayName };
    }

    if (!pairingMethods.includes(pm)) {
        returnError(res, 101, 'Unsupported pairing method.');
        return undefined;
    }

    switch (pm) {
        case 'kex': {
            const key = queryParam(req, 'key');
            if (key === undefined) {
                returnError(res, 105, 'Header key should be defined for kex pairing mode.');
                return undefined;
            }
            return { clientId, displayName, pairing: { method: 'kex', key } };
        }
        case 'qrcode':
            return { clientId, displayName, pairing: { method: 'qrcode' } };
        default:
            returnError(res, 101, 'Unsupported pairing method.');
            return undefined;
    }
}

// Synchronous: no await from the lookup of the pending attempt to the
// removal of the material.
function validateTokenParameters(clientId: string | undefined, refreshToken: string | undefined,
                                 challengeResponse: string | undefined, registered: Client | undefined,
                                 local: boolean, protocol: string, res: Response): ValidToken | false {
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
            logger.debug('Request came from non-local client without https');
            returnError(res, 106, 'Subsequent calls should use HTTPS protocol.');
            return false;
        }

        if (!client.validateRefreshToken(refreshToken)) {
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
        if (typeof challengeResponse !== 'string') {
            throw new TypeError('challenge-response is not a single value');
        }
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

// An empty or blank value counts as absent (105, Tables C.3 and C.4). A
// non-empty value is kept untrimmed; an empty pm= classifies as local.
function queryParam(req: Request, name: string): string | undefined {
    const value = req.query[name];
    if (typeof value === 'string' && value.trim() === '') {
        return undefined;
    }
    return value as string | undefined;
}

export default { GETAuthorize, GETToken };
