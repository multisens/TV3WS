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

// Camada grafica: um pop-up de autorizacao de cada vez (decisao do Luis em
// 12/10, noite; a primeira pergunta da G2 de docs/decisoes-pendentes.md).
// Enquanto houver na tela o sim/nao de um pedido esperando resposta, ou o QR
// code ou o PIN de um pareamento, um /tv3/authorize novo recebe 103 na hora,
// sem pop-up. Na norma:
// - C.4.2.3 (p. 209; p. 227 do PDF): "If there is any restriction preventing
//   the pop-up from being displayed at that time, the implementation shall
//   immediately send a response to the request with error code 103, so that
//   the client can try again later";
// - Tabela C.3 (p. 215; p. 233 do PDF): "103: When the TV 3.0 receiver is
//   unable to display the authorization pop-up".
// Ate 12/10 o pop-up novo substituia o da tela: o sim/nao de outro cliente
// tirava o QR code ou o PIN de um pareamento em andamento, e dois pedidos ao
// mesmo tempo se misturavam (o core.ts guarda um tratador por topico de
// resposta; KNOWN-ISSUES.md).
//
// A reserva e do PEDIDO (um objeto por /tv3/authorize), e nao do clientid: o
// 103 de um segundo pedido com o mesmo clientid nao pode liberar a reserva do
// primeiro. Ela nasce antes do sim/nao e, no nao local que aceitou, passa ao
// pop-up do pareamento sem janela entre os dois: o controller so libera a
// reserva que ainda for a do sim/nao. Sai:
// - a do sim/nao, no fim do /tv3/authorize (o controller chama
//   liberarReserva) ou, por seguranca, no prazo do sim/nao mais uma folga;
// - a do QR code ou do PIN, no sucesso do pareamento (endPairing) ou no fim
//   da trava de 120 s, quando a camada grafica fecha o pop-up sozinha.
// O prazo do desafio continua com o Joel (G2): a trava fecha o pop-up e
// libera a camada, mas o desafio pendente segue valendo. Vive so em memoria,
// como o material do pareamento (um reinicio do tv3ws perde os dois; a trava
// da camada grafica fecha o pop-up que estiver na tela).
export const YESNO_TIMEOUT_MS = 10 * 1000;
// gravacoes do Redis entre o "sim" e o pop-up do pareamento (o comando do
// Redis desiste em 1,5 s, D-0510-6)
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

// So para os testes (test/pairing-popup.test.ts e
// test/client-identification.test.ts): relogio e estado da camada.
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
    // Generate random string
    const simm_key = crypto.randomBytes(32);
    
    // Use key to create QR Code
    const base64Key = base64UrlEncode(simm_key);
    ocuparComPareamento('qrcode', client.getId());
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
    ocuparComPareamento('pin', client.getId());
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
// for o dele, e libera a camada (reservarCamada). Depois da trava, o pop-up ja
// saiu da tela e a camada ja esta livre: nada a fechar. Falha na publicacao
// vai para o log e nao desfaz a resposta do /tv3/token, que ja saiu (a trava
// fecha o pop-up).
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