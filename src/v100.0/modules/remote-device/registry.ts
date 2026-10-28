import { v4 as uuidv4 } from 'uuid';
import { RawData, WebSocket } from 'ws';
import { generateToken } from '../../util/token';
import { ClientType } from '../../util/client';
import { PairNotice } from './messages';

// Figure C.8: local client in a communication pair with the device
export type Pair = {
    ws: WebSocket;
    clientId: string;
    clientType: ClientType;
};

export default class Registry {
    public readonly handle = uuidv4();
    public readonly deviceId = uuidv4();
    public readonly token = generateToken();

    // Client that made the registration (C.4.4)
    public readonly registeredBy: string;

    protected deviceClass: string;
    protected supportedTypes: string[];

    // Token of the local entry point of each local client, by clientId
    protected localTokens = new Map<string, string>();
    protected ws?: WebSocket;
    protected disconnectedAt: number;
    protected pair?: Pair;

    constructor(deviceClass: string, supportedTypes: string[], registeredBy: string) {
        this.registeredBy = registeredBy;
        this.deviceClass = deviceClass;
        this.supportedTypes = supportedTypes;
        this.disconnectedAt = Date.now();
    }

    public getDeviceClass(): string {
        return this.deviceClass;
    }

    public getSupportedTypes(): string[] {
        return this.supportedTypes;
    }

    public getLocalToken(clientId: string): string | undefined {
        return this.localTokens.get(clientId);
    }

    public getLocalTokens(): string[] {
        return [...this.localTokens.values()];
    }

    public getDisconnectedAt(): number {
        return this.disconnectedAt;
    }

    public setLocalToken(clientId: string, token: string): void {
        this.localTokens.set(clientId, token);
    }

    public deleteLocalToken(clientId: string): void {
        this.localTokens.delete(clientId);
    }

    // Replaces the class and the supported types; handle, deviceId, token
    // and connection are kept
    public update(deviceClass: string, supportedTypes: string[]): void {
        this.deviceClass = deviceClass;
        this.supportedTypes = supportedTypes;
    }

    // Figure C.7: Connected while there is a connection of the device
    public isConnected(): boolean {
        return this.ws !== undefined;
    }

    public isPaired(): boolean {
        return this.pair !== undefined;
    }

    public getPair(): Pair | undefined {
        return this.pair;
    }

    public setPair(pair: Pair | undefined): void {
        this.pair = pair;
    }

    // Sends the Table C.86 message to the device, if it is connected
    public notifyDevice(notice: PairNotice): void {
        this.ws?.send(JSON.stringify(notice));
    }

    // C.6.15.5: forwards a message of the local client in the pair to the
    // device, if it is connected
    public sendToDevice(data: RawData, isBinary: boolean): void {
        this.ws?.send(data, { binary: isBinary });
    }

    public isDeviceConnection(ws: WebSocket): boolean {
        return this.ws === ws;
    }

    // Takes the new connection and closes the previous one, if any. Returns
    // true if the registry was disconnected
    public connect(ws: WebSocket): boolean {
        const previous = this.ws;
        this.ws = ws;
        previous?.close();
        return previous === undefined;
    }

    // Called when the socket has closed; ignores a socket that is no longer
    // the current one. Returns true if the socket was the current one
    public disconnect(ws: WebSocket): boolean {
        if (this.ws !== ws) {
            return false;
        }
        this.ws = undefined;
        this.disconnectedAt = Date.now();
        return true;
    }

    // Closes the connection of the device, if any; disconnect() runs when
    // the socket closes
    public close(): void {
        this.ws?.close();
    }
}
