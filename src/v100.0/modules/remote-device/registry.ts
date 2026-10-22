import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import { generateToken } from '../../util/token';

export default class Registry {
    public readonly handle = uuidv4();
    public readonly deviceId = uuidv4();
    public readonly token = generateToken();

    protected deviceClass: string;
    protected supportedTypes: string[];

    // Token of the local entry point of each local client, by clientId
    protected localTokens = new Map<string, string>();
    protected ws?: WebSocket;
    protected disconnectedAt: number;

    constructor(deviceClass: string, supportedTypes: string[]) {
        this.deviceClass = deviceClass;
        this.supportedTypes = supportedTypes;
        this.disconnectedAt = Date.now();
    }

    public getDeviceClass(): string {
        return this.deviceClass;
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

    // Takes the new connection and closes the previous one, if any
    public connect(ws: WebSocket): void {
        const previous = this.ws;
        this.ws = ws;
        previous?.close();
    }

    // Called when the socket has closed; ignores a socket that is no longer
    // the current one
    public disconnect(ws: WebSocket): void {
        if (this.ws !== ws) {
            return;
        }
        this.ws = undefined;
        this.disconnectedAt = Date.now();
    }

    // Closes the connection of the device, if any; disconnect() runs when
    // the socket closes
    public close(): void {
        this.ws?.close();
    }
}
