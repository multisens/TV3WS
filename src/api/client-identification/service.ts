import * as crypto from 'crypto';
import Client from '../../modules/auth-manager/client';
import * as core from '../../core';
import logger from '../../logger';
import { base64UrlEncode, base64UrlDecode, sha256Encrypt, aes128ECBEncrypt, createECDHKeys } from '../../util';

export const pairingMethods: string[] = ['qrcode', 'kex'];

// Correcao de 12/10 (auditoria; spec-1210-defeitos, item 1): o pop-up do QR
// code e o do PIN ficam na tela ate o fim do pareamento, e nao mais 1 s (a
// camada grafica os fechava sozinha nesse prazo). Fim do pareamento = o
// /tv3/token que confere a solucao do desafio (C.6.1.3) com sucesso; o
// controller chama endPairing nessa hora. Na norma:
// - C.4.3.2 (p. 210; p. 228 do PDF): "When this stream ends, the pop-up with
//   the QR code is removed from the receiver screen, which informs that the
//   pairing has been successful";
// - C.4.3.3 (p. 211; p. 229 do PDF): "When this stream has ended, the pop-ups
//   for filling out the PIN are removed from both the non-local client's
//   screen and the TV 3.0 receiver (which notifies of successful pairing)".
//
// Trava de seguranca: o pop-up vai para a camada grafica com este prazo, e
// ela o fecha sozinha ao fim dele (aop/public/js/popup.js), para que nao
// fique preso na tela se o cliente desistir ou sumir no meio do pareamento.
// O valor e decisao do projeto; a norma nao fixa prazo para o pop-up.
export const PAIRING_POPUP_TIMEOUT_MS = 120 * 1000;

// Fechamento por falha: nao ha, hoje, caminho em que o pareamento falhe de
// vez. Desafio errado no /tv3/token da 102 e a tentativa continua aberta (o
// material do pareamento fica no cliente e o mesmo challenge pode ser
// respondido de novo); o pop-up so sai no sucesso ou pela trava acima. No
// sucesso o material sai do cliente e o challenge nao vale mais (correcao
// de 12/10, spec-1210-seguranca item 2: controller.ts,
// validateTokenParameters).
// PENDENTE (Joel): se o desafio errado deve encerrar a tentativa (descartar
// o material e fechar o pop-up) — a Tabela C.4 so diz que o 102 significa
// "the pairing was not successfully concluded".

type PairingPopUp = 'qrcode' | 'pin';

// Cliente dono do pop-up de pareamento de cada tipo que esta na tela. A
// camada grafica tem UM pop-up e o substitui quando chega outro: o fim do
// pareamento de um cliente cujo pop-up ja foi substituido pelo de outro
// cliente nao pode fechar o pop-up do outro. Vive so em memoria, como o
// material do pareamento (um reinicio do tv3ws perde os dois; a trava da
// camada grafica fecha o pop-up que estiver na tela).
const popUpOwner = new Map<PairingPopUp, string>();

async function askAuthorization(displayName: string): Promise<boolean> {
    const message = `A aplicação "${displayName}" deseja acessar as informações do sinal de TV Digital.\nVocê deseja autorizar isto?`;
    const response = await core.showYesNoPopUpAsync(message, 10000);
    logger.debug(`Received response ${response} in askAuthorization`);
    return response;
}

function generateQRCodeSecret(client: Client): Buffer<ArrayBufferLike> {
    // Generate random string
    const simm_key = crypto.randomBytes(32);
    
    // Use key to create QR Code
    const base64Key = base64UrlEncode(simm_key);
    popUpOwner.set('qrcode', client.getId());
    core.showQRCodePopUp(base64Key, PAIRING_POPUP_TIMEOUT_MS);

    // Applies SHA-256 to key and get the 128 most significative bits
    const secret = sha256Encrypt(simm_key).subarray(0, 16);
    client.setSecret(secret);
    return secret;
}

// C.4.3.3, passo 2 e nota (p. 211; p. 229 do PDF): o PIN e o resto da divisao
// do hash por 10 000, "a four-digit number". Sai com os zeros a esquerda
// ("0042"); antes saia "42", e o espectador via um PIN de dois digitos.
export function pinFromHash(hash: Buffer): string {
    const pin = BigInt('0x' + hash.toString('hex')) % BigInt(10000);
    return pin.toString().padStart(4, '0');
}

function generatePINSecret(client: Client, key: string): Buffer<ArrayBufferLike> {
    // Generate the ECDH key pair
    const [privateKey, publicKey] = createECDHKeys();
    client.setECDHKeys(privateKey, publicKey);

    // Get the key to derive the shared secret
    const clientKey = base64UrlDecode(key);
    let simm_key = privateKey.computeSecret(clientKey);
    simm_key = sha256Encrypt(simm_key);
    
    // Use key to create PIN
    popUpOwner.set('pin', client.getId());
    core.showPINPopUp(pinFromHash(simm_key), PAIRING_POPUP_TIMEOUT_MS);

    // Applies SHA-256 to key and get the 128 most significative bits
    const secret = simm_key.subarray(0, 16);
    client.setSecret(secret);
    return secret;
}

function generateChallenge(client: Client, secret: Buffer<ArrayBufferLike>) {
    // Random 16 bytes string for challenge
    const randomString = crypto.randomBytes(16);
    // guarda o SHA-256 em bytes (12/10, spec-1210-seguranca2 item 3; antes,
    // .toString() UTF-8 com perda; ver Client.validateChallenge)
    client.setChallenge(sha256Encrypt(randomString));

    // Encrypt random string using AES-128 ECB with PKCS#7 padding using SHA-256 key
    const encrypted = aes128ECBEncrypt(randomString, secret);

    // return challenge using safe base64 string
    return base64UrlEncode(encrypted);
}

// Fim do pareamento do cliente (C.4.3.2, C.4.3.3; ver PAIRING_POPUP_TIMEOUT_MS
// acima): manda a camada grafica fechar o pop-up de pareamento dele, se ainda
// for o dele. Falha na publicacao vai para o log e nao desfaz a resposta do
// /tv3/token, que ja saiu (a trava fecha o pop-up).
function endPairing(clientId: string): void {
    try {
        if (popUpOwner.get('qrcode') === clientId) {
            popUpOwner.delete('qrcode');
            core.closeQRCodePopUp();
        }
        if (popUpOwner.get('pin') === clientId) {
            popUpOwner.delete('pin');
            core.closePINPopUp();
        }
    } catch (err) {
        logger.error(`Failed to close the pairing popup of client ${clientId}: ${(err as Error)?.message}`);
    }
}

export default { askAuthorization, generateQRCodeSecret, generatePINSecret, generateChallenge, endPairing }