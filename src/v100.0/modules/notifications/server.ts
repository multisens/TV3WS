import http, { IncomingMessage } from 'http';
import { Server, Socket } from 'net';
import { WebSocketServer } from 'ws';
import core from '../../../core';
import { ApiError } from '../../../util';
import { closeServer, listenOnFreePort } from '../../util/port';
import { listeners } from './listeners';

const LISTENER_PATH = 'ev';
const LISTENER_PREFIX = `/${LISTENER_PATH}/`;

const wss = new WebSocketServer({ noServer: true });

// Notification server (C.6.2.2); the port is undefined while it is not
// listening
let port: number | undefined;
let server: Server | undefined;

// Opens the notification server, without TLS, on a free port
export async function startNotificationServer(): Promise<void> {
    server = http.createServer();
    server.on('upgrade', onUpgrade);
    port = await listenOnFreePort(server);
    console.log(`[v100.0 notifications] notification server listening on port ${port}`);
}

// Closes every connection and the server
export async function stopNotificationServer(): Promise<void> {
    for (const ws of wss.clients) {
        ws.terminate();
    }
    await closeServer(server);
    server = undefined;
    port = undefined;
}

export function isNotificationServerListening(): boolean {
    return port !== undefined;
}

// C.6.2.2: URL of the WebSocket of the listener identified by the token
export function listenerUrl(token: string): string {
    if (port === undefined) {
        throw new ApiError(200, 'notification server is not listening');
    }
    return `ws://${core.server.url}:${port}${LISTENER_PREFIX}${token}`;
}

// Accepts the upgrade to the WebSocket of a registered listener; any other
// path or token is refused
function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = new URL(req.url ?? '', 'http://localhost').pathname;
    if (!path.startsWith(LISTENER_PREFIX)) {
        refuse(socket);
        return;
    }

    const listener = listeners.getByToken(path.slice(LISTENER_PREFIX.length));
    if (!listener) {
        refuse(socket);
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        listeners.connect(listener, ws);
        ws.on('close', () => listeners.disconnect(listener, ws));
        ws.on('error', () => console.log(`Error on socket of listener ${listener.handle}`));
    });
}

// Responds HTTP 404 and closes the socket, without opening the connection
function refuse(socket: Socket): void {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
}
