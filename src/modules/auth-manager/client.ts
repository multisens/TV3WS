import { randomBytes, ECDH } from 'crypto';
import { base64UrlEncode, safeEqual } from '../../util';

// Client classes (C.4.1.1), decided at authorization and written into the
// credential.
export type ClientClass = 'local-associated' | 'local-autonomous' | 'non-local';

// Ephemeral pairing material of a non-local client (C.4.3, C.6.1.2.2):
// symmetric key, challenge and ECDH pair (pm=kex), valid until the
// /tv3/token that checks the challenge-response.
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
    // SHA-256 of the random string of the challenge (C.6.1.2.2), as bytes.
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

    // Rebuilds a client from Redis; the pairing material is ephemeral and is
    // not restored.
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

    // Constant time, and only text is valid: ?refresh-token=a&refresh-token=b
    // arrives as a list.
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

    // Bytes, in constant time: with a UTF-8 .toString(), an invalid byte
    // becomes U+FFFD, and different responses would pass as equal.
    public validateChallenge(response: Buffer<ArrayBufferLike>): boolean {
        return this.challenge !== undefined && safeEqual(this.challenge, response);
    }

    public hasPendingChallenge(): boolean {
        return this.challenge !== undefined && this.secret !== undefined;
    }

    // Removes and returns the pairing material: the challenge is valid once.
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