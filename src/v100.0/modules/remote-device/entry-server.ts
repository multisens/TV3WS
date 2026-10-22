import http, { IncomingMessage } from 'http';
import https from 'https';
import { once } from 'events';
import { Server, Socket } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import core from '../../../core';
import { tlsMaterial, wsTls } from '../../../tls';
import { ApiError } from '../../../util';
import { registries } from './manager';
import Registry from './registry';

const LISTEN_ATTEMPTS = parseInt(process.env.LISTEN_ATTEMPTS || '10');
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || '15000');
const ENTRY_PATH = 'rd';
const ENTRY_PREFIX = `/${ENTRY_PATH}/`;

const wss = new WebSocketServer({ noServer: true });
const alive = new WeakSet<WebSocket>();

// Port of the entry server; undefined while it is not listening
let port: number | undefined;
let server: Server | undefined;
let pingTimer: NodeJS.Timeout | undefined;

function generateDynamicallyPort(): number {
  const min = parseInt(process.env.WS_PORT_MIN || '45000');
  const max = parseInt(process.env.WS_PORT_MAX || '45199');
  return Math.floor(min + Math.random() * (max - min));
}

// Makes the server listen on a free port drawn by generateDynamicallyPort,
// drawing again while the port is in use, up to LISTEN_ATTEMPTS times.
// Returns the port; throws if no free port is found or on another error
async function listenOnFreePort(server: Server): Promise<number> {
    for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt++) {
        const port = generateDynamicallyPort();
        try {
            server.listen(port);
            await once(server, 'listening');
            return port;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
                throw err;
            }
        }
    }
    throw new Error(`no free port after ${LISTEN_ATTEMPTS} attempts`);
}

// Opens the single entry server, with TLS when wsTls() is on and there is
// TLS material, on a free port
export async function startEntryServer(): Promise<void> {
    const tls = wsTls() ? tlsMaterial() : undefined;
    const entryServer = tls
        ? https.createServer({ key: tls.key, cert: tls.cert })
        : http.createServer();
    entryServer.on('upgrade', onUpgrade);
    port = await listenOnFreePort(entryServer);
    server = entryServer;
    console.log(`[v100.0 remote-device] entry server listening on port ${port}`);

    pingTimer = setInterval(() => {
        for (const ws of wss.clients) {
            if (alive.has(ws)) {
                alive.delete(ws);
                ws.ping();
            }
            else {
                ws.terminate();
            }
        }
    }, PING_INTERVAL_MS);
}

// Stops the ping timer, closes every connection and the server
export async function stopEntryServer(): Promise<void> {
    clearInterval(pingTimer);
    pingTimer = undefined;
    for (const ws of wss.clients) {
        ws.terminate();
    }
    if (server) {
        const closing = once(server, 'close');
        server.close();
        await closing;
    }
    server = undefined;
    port = undefined;
}

export function isEntryServerListening(): boolean {
    return port !== undefined;
}

// C.6.15.2: URL of the entry point identified by the token
export function entryPointUrl(token: string): string {
    if (port === undefined) {
        throw new ApiError(200, 'entry server is not listening');
    }
    return `${wsTls() ? 'wss' : 'ws'}://${core.server.url}:${port}${ENTRY_PREFIX}${token}`;
}

// Accepts the upgrade to the entry point of a registered device; any other
// path or token is refused
function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = new URL(req.url ?? '', 'http://localhost').pathname;
    if (!path.startsWith(ENTRY_PREFIX)) {
        refuse(socket);
        return;
    }

    const token = path.slice(ENTRY_PREFIX.length);
    const entryPoint = registries.getEntryPoint(token);
    if (!entryPoint || entryPoint.kind !== 'device') {
        refuse(socket);
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        alive.add(ws);
        ws.on('pong', () => alive.add(ws));
        onDeviceConnection(entryPoint.registry, ws);
    });
}

// Responds HTTP 404 and closes the socket, without opening the connection
function refuse(socket: Socket): void {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
}

function onDeviceConnection(registry: Registry, ws: WebSocket): void {
    registry.connect(ws);
    ws.on('close', () => registry.disconnect(ws));
    ws.on('error', () => console.log(`Error on socket for device ${registry.handle}`));
    ws.on('message', () => console.log(`Message on socket for device ${registry.handle}`));
}
