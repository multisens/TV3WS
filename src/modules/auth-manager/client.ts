import { randomBytes, ECDH } from 'crypto';
import { base64UrlEncode } from '../../util';

// Classes de cliente da norma (C.4.1.1), decididas na autorizacao (P1) e
// gravadas na credencial — nunca inferidas de endereco de rede.
export type ClientClass = 'local-associated' | 'local-autonomous' | 'non-local';

export default class Client {
    protected id: string;
    protected clientClass: ClientClass;
    protected refreshToken: string;
    protected challenge?: string;
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

    public validateRefreshToken(refreshToken: string): boolean {
        return this.refreshToken == refreshToken;
    }

    public setChallenge(str: string) {
        this.challenge = str;
    }

    public getChallenge(): string {
        return this.challenge as string;
    }

    public validateChallenge(challenge: string): boolean {
        return this.challenge! == challenge;
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