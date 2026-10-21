import { randomBytes, ECDH } from 'crypto';
import { base64UrlEncode, safeEqual } from '../../util';

// Classes de cliente (C.4.1.1), definidas na autorizacao e gravadas na credencial, nunca pelo endereco.
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

    // Rehidrata um cliente do Redis; o material de pareamento e efemero e nao e restaurado.
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

    // Tempo constante, e so texto vale: ?refresh-token=a&refresh-token=b chega como lista.
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

    // Bytes, em tempo constante: com .toString() UTF-8, byte invalido vira U+FFFD, e respostas diferentes
    // passariam como iguais.
    public validateChallenge(response: Buffer<ArrayBufferLike>): boolean {
        return this.challenge !== undefined && safeEqual(this.challenge, response);
    }

    public hasPendingChallenge(): boolean {
        return this.challenge !== undefined && this.secret !== undefined;
    }

    // O challenge vale uma vez. Se a emissao falhar, quem chama devolve o material com restorePairingMaterial.
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