import * as crypto from 'crypto';
import Client from '../../modules/auth-manager/client';
import * as core from '../../core';
import logger from '../../logger';
import { base64UrlEncode, base64UrlDecode, sha256Encrypt, aes128ECBEncrypt, createECDHKeys } from '../../util';

export const pairingMethods: string[] = ['qrcode', 'kex'];

// Lock of the QR code and PIN pop-ups: they stay on screen until the
// /tv3/token that checks the challenge (C.4.3.2, C.4.3.3) or until this time
// expires.
export const PAIRING_POPUP_TIMEOUT_MS = 120 * 1000;

type PairingPopUp = 'qrcode' | 'pin';

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
const YESNO_FOLGA_MS = 5 * 1000;

export type Reserva = { tipo: 'yesno' | PairingPopUp; dono: string; ate: number };
let ocupacao: Reserva | undefined;
let agora: () => number = Date.now;

function camadaOcupada(): Reserva | undefined {
    if (ocupacao && ocupacao.ate <= agora()) ocupacao = undefined;
    return ocupacao;
}

// Reserves the layer for the yes/no of the request; undefined if it is busy.
function reservarCamada(clientId: string): Reserva | undefined {
    const atual = camadaOcupada();
    if (atual) {
        logger.info(`Camada grafica ocupada (${atual.tipo} do cliente ${atual.dono}): /tv3/authorize do cliente ${clientId} recebe 103`);
        return undefined;
    }
    ocupacao = { tipo: 'yesno', dono: clientId, ate: agora() + YESNO_TIMEOUT_MS + YESNO_FOLGA_MS };
    return ocupacao;
}

// End of the request (local client served, refusal, error): releases its
// reservation if it is still the one of the yes/no. If it already passed to
// the pairing pop-up, or the layer belongs to another request, nothing
// changes.
function liberarReserva(r: Reserva | undefined): void {
    if (r !== undefined && ocupacao === r) ocupacao = undefined;
}

// The pairing pop-up takes the layer (the yes/no reservation of this
// request leaves without a gap) until success or the end of the lock.
function ocuparComPareamento(tipo: PairingPopUp, clientId: string): void {
    ocupacao = { tipo, dono: clientId, ate: agora() + PAIRING_POPUP_TIMEOUT_MS };
}

export const _camadaParaTestes = {
    relogio(f?: () => number): void { agora = f ?? Date.now; },
    limpar(): void { ocupacao = undefined; },
    ocupacao(): Reserva | undefined { return camadaOcupada(); },
};

async function askAuthorization(displayName: string): Promise<boolean> {
    const message = `A aplicação "${displayName}" deseja acessar as informações do sinal de TV Digital.\nVocê deseja autorizar isto?`;
    const response = await core.showYesNoPopUpAsync(message, YESNO_TIMEOUT_MS);
    logger.debug(`Received response ${response} in askAuthorization`);
    return response;
}

function generateQRCodeSecret(client: Client): Buffer<ArrayBufferLike> {
    const simm_key = crypto.randomBytes(32);
    
    const base64Key = base64UrlEncode(simm_key);
    ocuparComPareamento('qrcode', client.getId());
    core.showQRCodePopUp(base64Key, PAIRING_POPUP_TIMEOUT_MS);

    const secret = sha256Encrypt(simm_key).subarray(0, 16);
    client.setSecret(secret);
    return secret;
}

// C.4.3.3, step 2 and note: the PIN is the remainder of the hash by 10 000,
// "a four-digit number", with leading zeros.
export function pinFromHash(hash: Buffer): string {
    const pin = BigInt('0x' + hash.toString('hex')) % BigInt(10000);
    return pin.toString().padStart(4, '0');
}

function generatePINSecret(client: Client, key: string): Buffer<ArrayBufferLike> {
    const [privateKey, publicKey] = createECDHKeys();
    client.setECDHKeys(privateKey, publicKey);

    const clientKey = base64UrlDecode(key);
    let simm_key = privateKey.computeSecret(clientKey);
    simm_key = sha256Encrypt(simm_key);
    
    ocuparComPareamento('pin', client.getId());
    core.showPINPopUp(pinFromHash(simm_key), PAIRING_POPUP_TIMEOUT_MS);

    const secret = simm_key.subarray(0, 16);
    client.setSecret(secret);
    return secret;
}

function generateChallenge(client: Client, secret: Buffer<ArrayBufferLike>) {
    const randomString = crypto.randomBytes(16);
    // Keeps the SHA-256 as bytes: a UTF-8 .toString() would lose information.
    client.setChallenge(sha256Encrypt(randomString));

    const encrypted = aes128ECBEncrypt(randomString, secret);

    return base64UrlEncode(encrypted);
}

// Closes the pairing pop-up of the client, if it is still its own, and
// releases the layer. A failure is only logged.
function endPairing(clientId: string): void {
    try {
        const o = camadaOcupada();
        if (o && o.tipo !== 'yesno' && o.dono === clientId) {
            ocupacao = undefined;
            if (o.tipo === 'qrcode') core.closeQRCodePopUp();
            else core.closePINPopUp();
        }
    } catch (err) {
        logger.error(`Failed to close the pairing popup of client ${clientId}: ${(err as Error)?.message}`);
    }
}

export default { askAuthorization, generateQRCodeSecret, generatePINSecret, generateChallenge, endPairing, reservarCamada, liberarReserva }