import { randomBytes, ECDH } from 'crypto';
import { base64UrlEncode, safeEqual } from '../../util';

// Classes de cliente da norma (C.4.1.1), decididas na autorizacao (P1) e
// gravadas na credencial — nunca inferidas de endereco de rede.
export type ClientClass = 'local-associated' | 'local-autonomous' | 'non-local';

// Material efemero do pareamento do cliente nao local (C.4.3, C.6.1.2.2):
// chave simetrica, challenge e par ECDH (pm=kex). Vale ate o /tv3/token que
// confere o challenge-response; ver takePairingMaterial.
export type PairingMaterial = {
    challenge?: Buffer<ArrayBufferLike>;
    secret?: Buffer<ArrayBufferLike>;
    ECDHKey?: {
        privateKey: ECDH,
        publicKey: Buffer<ArrayBufferLike>
    };
};

export default class Client {
    protected id: string;
    protected clientClass: ClientClass;
    protected refreshToken: string;
    // SHA-256 da string aleatoria do desafio (C.6.1.2.2), em bytes
    protected challenge?: Buffer<ArrayBufferLike>;
    protected secret?: Buffer<ArrayBufferLike>;
    protected ECDHKey?: {
        privateKey: ECDH,
        publicKey: Buffer<ArrayBufferLike>
    }
    protected accessToken?: string;

    constructor(id: string, clientClass: ClientClass = 'local-autonomous') {
        this.id = id;
        this.clientClass = clientClass;
        this.refreshToken = this.createRefreshToken();
    }

    public getId(): string {
        return this.id;
    }

    public getClass(): ClientClass {
        return this.clientClass;
    }

    public isLocal(): boolean {
        return this.clientClass !== 'non-local';
    }

    // Rehidrata um cliente persistido no armazenamento (P5). O material de
    // pareamento (secret/challenge/ECDH) e efemero por natureza — vive so
    // durante o handshake — e nao e restaurado.
    public restore(refreshToken: string, accessToken?: string): void {
        this.refreshToken = refreshToken;
        if (accessToken) this.accessToken = accessToken;
    }

    public getRefreshToken(): string {
        return this.refreshToken;
    }

    public updateRefreshToken(): string {
        this.refreshToken = this.createRefreshToken();
        return this.refreshToken;
    }

    // Correcao de 12/10 (spec-1210-seguranca2, item 3): comparacao em tempo
    // constante (safeEqual, util/encryption.ts); antes "==", que para no
    // primeiro caractere diferente, e aceitava lista (?refresh-token=a&
    // refresh-token=b chega como ['a','b'], e ['a','b'] == 'a,b'). So texto
    // vale; o formato do refresh token e o mesmo (Tabela C.4: "defined by the
    // server implementation").
    public validateRefreshToken(refreshToken: string): boolean {
        if (typeof refreshToken !== 'string') return false;
        return safeEqual(Buffer.from(this.refreshToken, 'utf8'), Buffer.from(refreshToken, 'utf8'));
    }

    public setChallenge(hash: Buffer<ArrayBufferLike>) {
        this.challenge = hash;
    }

    public getChallenge(): Buffer<ArrayBufferLike> | undefined {
        return this.challenge;
    }

    // Correcao de 12/10 (spec-1210-seguranca2, item 3): o challenge-response
    // decifrado (Tabela C.4: SHA-256 da string decifrada, cifrado com a chave
    // simetrica) e comparado em BYTES e em tempo constante com o SHA-256
    // guardado. Antes os dois lados eram convertidos com .toString() (UTF-8):
    // byte que nao forma UTF-8 valido vira U+FFFD, e respostas com bytes
    // diferentes nessas posicoes passavam como iguais; e "==" nao e tempo
    // constante. O que o cliente manda nao muda.
    public validateChallenge(response: Buffer<ArrayBufferLike>): boolean {
        return this.challenge !== undefined && safeEqual(this.challenge, response);
    }

    // Ha challenge esperando resposta (pareamento em andamento).
    public hasPendingChallenge(): boolean {
        return this.challenge !== undefined && this.secret !== undefined;
    }

    // Correcao de 12/10 (spec-1210-seguranca, item 2): o challenge vale uma
    // vez. Tira do cliente e devolve o material do pareamento; quem chama
    // (controller do /tv3/token, logo depois de conferir o
    // challenge-response) usa a chave para cifrar a primeira resposta e, se
    // a emissao falhar, devolve o material com restorePairingMaterial.
    public takePairingMaterial(): PairingMaterial {
        const material: PairingMaterial = { challenge: this.challenge, secret: this.secret, ECDHKey: this.ECDHKey };
        this.challenge = undefined;
        this.secret = undefined;
        this.ECDHKey = undefined;
        return material;
    }

    public restorePairingMaterial(material: PairingMaterial): void {
        this.challenge = material.challenge;
        this.secret = material.secret;
        this.ECDHKey = material.ECDHKey;
    }

    public setSecret(key: Buffer<ArrayBufferLike>) {
        this.secret = key;
    }

    public getSecret(): Buffer<ArrayBufferLike> {
        return this.secret as Buffer<ArrayBufferLike>;
    }

    public setECDHKeys(privateKey: ECDH, publicKey: Buffer<ArrayBufferLike>) {
        this.ECDHKey = {
            privateKey: privateKey,
            publicKey: publicKey
        }
    }

    public getECDHPublicKey(): Buffer<ArrayBufferLike> {
        if (this.ECDHKey === undefined)
            throw Error(`Client ${this.id} has no ECDH key pair.`);

        return this.ECDHKey?.publicKey;
    }

    public setAccessToken(token: string) {
        this.accessToken = token;
    }

    public hasAccessToken(): boolean {
        return this.accessToken !== undefined;
    }

    public getAccessToken(): string {
        return this.accessToken as string;
    }

    protected createRefreshToken(): string {
        return base64UrlEncode(randomBytes(16));
    }
}