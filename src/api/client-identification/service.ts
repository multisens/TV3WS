import * as crypto from 'crypto';
import Client from '../../modules/auth-manager/client';
import * as core from '../../core';
import logger from '../../logger';
import { base64UrlEncode, base64UrlDecode, sha256Encrypt, aes128ECBEncrypt, createECDHKeys } from '../../util';

type PairingPopUp = 'qrcode' | 'pin';

// Reservation of the graphics layer: the pop-up that holds it, the request
// that owns it and the instant it ends.
export type Reservation = { kind: 'yesno' | PairingPopUp; owner: string; until: number };

export const pairingMethods: string[] = ['qrcode', 'kex'];

// Lock of the QR code and PIN pop-ups: they stay on screen until the
// /tv3/token that checks the challenge (C.4.3.2, C.4.3.3) or until this time
// expires; the pending attempt ends with them.
export const PAIRING_POPUP_TIMEOUT_MS = 120 * 1000;

// Graphics layer: one authorization pop-up at a time. With a yes/no waiting
// for an answer, or the QR code or PIN of a pairing on screen, a new
// /tv3/authorize gets 103 at once (C.4.2.3; Table C.3). The reservation
// belongs to the request, not to the clientid: the 103 of a second request
// with the same clientid does not release the first one's. For a non-local
// client that accepted, it passes to the pairing pop-up without a gap. It
// is released at the end of /tv3/authorize, on the success of the pairing or
// at the end of the lock; memory only.
export const YESNO_TIMEOUT_MS = 10 * 1000;

// Redis writing between the answer to the yes/no and the end of the request
// (each command gives up after 1.5 s).
const YESNO_MARGIN_MS = 5 * 1000;

const SYMMETRIC_KEY_BYTES = 32;
const SECRET_BYTES = 16;
const CHALLENGE_BYTES = 16;
const PIN_MODULUS = BigInt(10000);
const PIN_DIGITS = 4;

let layerReservation: Reservation | undefined;
let now: () => number = Date.now;

export const _layerForTests = {
    clock(f?: () => number): void {
        now = f ?? Date.now;
    },
    clear(): void {
        layerReservation = undefined;
    },
    reservation(): Reservation | undefined {
        return currentReservation();
    },
};

// Reserves the layer for the yes/no of the request; undefined if it is busy.
function reserveLayer(clientId: string): Reservation | undefined {
    const current = currentReservation();
    if (current !== undefined) {
        logger.info(`Graphics layer busy (${current.kind} of client ${current.owner}): /tv3/authorize of client ${clientId} gets 103`);
        return undefined;
    }
    layerReservation = { kind: 'yesno', owner: clientId, until: now() + YESNO_TIMEOUT_MS + YESNO_MARGIN_MS };
    return layerReservation;
}

// End of the request (local client served, refusal, error): releases its
// reservation if it is still the one of the yes/no. If it already passed to
// the pairing pop-up, or the layer belongs to another request, nothing
// changes.
function releaseReservation(reservation: Reservation | undefined): void {
    if (reservation !== undefined && layerReservation === reservation) {
        layerReservation = undefined;
    }
}

async function askAuthorization(displayName: string): Promise<boolean> {
    const message = `A aplicação "${displayName}" deseja acessar as informações do sinal de TV Digital.\nVocê deseja autorizar isto?`;
    const response = await core.showYesNoPopUpAsync(message, YESNO_TIMEOUT_MS);
    logger.debug(`Received response ${response} in askAuthorization`);
    return response;
}

function generateQRCodeSecret(client: Client): Buffer<ArrayBufferLike> {
    const symmetricKey = crypto.randomBytes(SYMMETRIC_KEY_BYTES);
    const base64Key = base64UrlEncode(symmetricKey);
    holdForPairing('qrcode', client.getId());
    core.showQRCodePopUp(base64Key, PAIRING_POPUP_TIMEOUT_MS);

    const secret = sha256Encrypt(symmetricKey).subarray(0, SECRET_BYTES);
    client.setSecret(secret);
    return secret;
}

function generatePINSecret(client: Client, key: string): Buffer<ArrayBufferLike> {
    const [privateKey, publicKey] = createECDHKeys();
    client.setECDHKeys(privateKey, publicKey);

    const clientKey = base64UrlDecode(key);
    const sharedSecret = privateKey.computeSecret(clientKey);
    const symmetricKey = sha256Encrypt(sharedSecret);
    holdForPairing('pin', client.getId());
    core.showPINPopUp(pinFromHash(symmetricKey), PAIRING_POPUP_TIMEOUT_MS);

    const secret = symmetricKey.subarray(0, SECRET_BYTES);
    client.setSecret(secret);
    return secret;
}

function generateChallenge(client: Client, secret: Buffer<ArrayBufferLike>): string {
    const randomString = crypto.randomBytes(CHALLENGE_BYTES);
    // Keeps the SHA-256 as bytes: a UTF-8 .toString() would lose information.
    client.setChallenge(sha256Encrypt(randomString));

    const encrypted = aes128ECBEncrypt(randomString, secret);
    return base64UrlEncode(encrypted);
}

// True while the QR code or PIN pop-up of the client holds the layer: the
// pending attempt of the client is valid only until the end of the lock.
function pairingOpen(clientId: string): boolean {
    const reservation = currentReservation();
    return reservation !== undefined && reservation.kind !== 'yesno' && reservation.owner === clientId;
}

// Closes the pairing pop-up of the client, if it is still its own, and
// releases the layer. A failure is only logged.
function endPairing(clientId: string): void {
    try {
        const reservation = currentReservation();
        if (reservation === undefined || reservation.kind === 'yesno' || reservation.owner !== clientId) {
            return;
        }
        layerReservation = undefined;
        if (reservation.kind === 'qrcode') {
            core.closeQRCodePopUp();
        } else {
            core.closePINPopUp();
        }
    } catch (err) {
        logger.error(`Failed to close the pairing popup of client ${clientId}: ${(err as Error)?.message}`);
    }
}

// C.4.3.3, step 2 and note: the PIN is the remainder of the hash by 10 000,
// "a four-digit number", with leading zeros.
export function pinFromHash(hash: Buffer): string {
    const pin = BigInt('0x' + hash.toString('hex')) % PIN_MODULUS;
    return pin.toString().padStart(PIN_DIGITS, '0');
}

// The reservation in force; an expired one is dropped.
function currentReservation(): Reservation | undefined {
    if (layerReservation !== undefined && layerReservation.until <= now()) {
        layerReservation = undefined;
    }
    return layerReservation;
}

// The pairing pop-up takes the layer (the yes/no reservation of this
// request leaves without a gap) until success or the end of the lock.
function holdForPairing(kind: PairingPopUp, clientId: string): void {
    layerReservation = { kind, owner: clientId, until: now() + PAIRING_POPUP_TIMEOUT_MS };
}

export default {
    askAuthorization,
    generateQRCodeSecret,
    generatePINSecret,
    generateChallenge,
    pairingOpen,
    endPairing,
    reserveLayer,
    releaseReservation,
};
