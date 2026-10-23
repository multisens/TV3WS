import * as crypto from 'crypto';
import Client from '../../modules/auth-manager/client';
import * as core from '../../core';
import logger from '../../logger';
import { base64UrlEncode, base64UrlDecode, sha256Encrypt, aes128ECBEncrypt, createECDHKeys } from '../../util';

export const pairingMethods: string[] = ['qrcode', 'kex'];

// O pop-up do QR code e o do PIN ficam na tela ate o /tv3/token que confere o desafio (C.4.3.2, C.4.3.3).
// Este prazo e so uma trava para o pop-up nao ficar preso se o cliente sumir; a norma nao fixa prazo.
// Desafio errado da 102 e a tentativa segue aberta, sem limite de tentativas nem prazo do desafio.
export const PAIRING_POPUP_TIMEOUT_MS = 120 * 1000;

type PairingPopUp = 'qrcode' | 'pin';

// Camada grafica: um pop-up de autorizacao de cada vez. Com um sim/nao esperando resposta, ou o QR code ou
// o PIN de um pareamento na tela, um /tv3/authorize novo recebe 103 na hora (C.4.2.3; Tabela C.3).
// A reserva e do pedido, nao do clientid: o 103 de um segundo pedido com o mesmo clientid nao libera a do
// primeiro. No nao local que aceitou, ela passa ao pop-up do pareamento sem janela. Sai no fim do
// /tv3/authorize, no sucesso do pareamento ou no fim da trava; so em memoria, como o material do pareamento.
export const YESNO_TIMEOUT_MS = 10 * 1000;
// gravacao do Redis entre a resposta ao sim/nao e o fim do pedido (cada comando desiste em 1,5 s)
const YESNO_FOLGA_MS = 5 * 1000;

export type Reserva = { tipo: 'yesno' | PairingPopUp; dono: string; ate: number };
let ocupacao: Reserva | undefined;
let agora: () => number = Date.now;

function camadaOcupada(): Reserva | undefined {
    if (ocupacao && ocupacao.ate <= agora()) ocupacao = undefined;
    return ocupacao;
}

// Reserva a camada para o sim/nao do pedido; undefined se ela estiver ocupada
// (o controller responde 103).
function reservarCamada(clientId: string): Reserva | undefined {
    const atual = camadaOcupada();
    if (atual) {
        logger.info(`Camada grafica ocupada (${atual.tipo} do cliente ${atual.dono}): /tv3/authorize do cliente ${clientId} recebe 103`);
        return undefined;
    }
    ocupacao = { tipo: 'yesno', dono: clientId, ate: agora() + YESNO_TIMEOUT_MS + YESNO_FOLGA_MS };
    return ocupacao;
}

// Fim do pedido (local atendido, recusa, erro): libera a reserva dele se ela
// ainda for a do sim/nao. Se ela ja passou ao pop-up do pareamento, ou se a
// camada e de outro pedido, nada muda.
function liberarReserva(r: Reserva | undefined): void {
    if (r !== undefined && ocupacao === r) ocupacao = undefined;
}

// O pop-up do pareamento toma a camada (a reserva do sim/nao deste pedido sai
// sem janela) ate o sucesso ou o fim da trava.
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

// C.4.3.3, passo 2 e nota: o PIN e o resto do hash por 10 000, "a four-digit number", com zeros a esquerda
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
    // guarda o SHA-256 em bytes: .toString() UTF-8 perderia informacao
    client.setChallenge(sha256Encrypt(randomString));

    const encrypted = aes128ECBEncrypt(randomString, secret);

    return base64UrlEncode(encrypted);
}

// Fecha o pop-up de pareamento do cliente, se ainda for o dele, e libera a camada. Falha so vai para o
// log: a resposta do /tv3/token ja saiu, e a trava fecha o pop-up.
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