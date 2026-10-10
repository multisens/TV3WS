import * as crypto from 'crypto';
import Client from '../../modules/auth-manager/client';
import * as core from '../../core';
import logger from '../../logger';
import { base64UrlEncode, base64UrlDecode, sha256Encrypt, aes128ECBEncrypt, createECDHKeys } from '../../util';

export const pairingMethods: string[] = ['qrcode', 'kex'];

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
    core.showQRCodePopUp(base64Key, 1000);

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
    core.showPINPopUp(pinFromHash(simm_key), 1000);

    // Applies SHA-256 to key and get the 128 most significative bits
    const secret = simm_key.subarray(0, 16);
    client.setSecret(secret);
    return secret;
}

function generateChallenge(client: Client, secret: Buffer<ArrayBufferLike>) {
    // Random 16 bytes string for challenge
    const randomString = crypto.randomBytes(16);
    client.setChallenge(sha256Encrypt(randomString).toString());

    // Encrypt random string using AES-128 ECB with PKCS#7 padding using SHA-256 key
    const encrypted = aes128ECBEncrypt(randomString, secret);

    // return challenge using safe base64 string
    return base64UrlEncode(encrypted);
}

export default { askAuthorization, generateQRCodeSecret, generatePINSecret, generateChallenge }