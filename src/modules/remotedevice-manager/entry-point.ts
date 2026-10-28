import http from 'http';
import https from 'https';
import { WebSocketServer } from 'ws';
import logger from '../../logger';
import { ApiError, positiveIntFromEnv } from '../../util';
import { TlsMaterial, tlsMaterial, wsTls } from '../../tls';

// WebSocket entry points: the one of the remote device, opened at the
// registration (C.6.15.2), and the local one, of the listing (C.6.15.5). A
// port in use draws another; after LISTEN_ATTEMPTS, 404 {error:200}
// (Table C.76). The port is handed out only when listening.
export const LISTEN_ATTEMPTS = 10;

// Close code sent to the clients when an entry point closes (going away).
const CLOSE_GOING_AWAY = 1001;

// Port drawn from WS_PORT_MIN to WS_PORT_MAX, both included, read on every
// opening.
export function generateDynamicallyPort(): number {
    const min = positiveIntFromEnv('WS_PORT_MIN');
    const max = positiveIntFromEnv('WS_PORT_MAX');
    const offset = Math.floor(Math.random() * (max - min + 1));
    return min + offset;
}

// The entry point of the remote device, with the receiver certificate when
// there is one: wss:// (Table C.76).
export function openRemoteDeviceEntryPoint(): Promise<WebSocketServer> {
    return openEntryPoint(wsTls() ? tlsMaterial() : undefined);
}

// The local entry point, always ws://.
export function openLocalEntryPoint(): Promise<WebSocketServer> {
    return openEntryPoint(undefined);
}

// URL with the scheme of the server that is listening.
export function entryPointUrl(wss: WebSocketServer, host: string): string {
    const scheme = wss.options.server instanceof https.Server ? 'wss' : 'ws';
    return `${scheme}://${host}:${wss.options.port}`;
}

// Closes the clients, the WebSocket server and the HTTP server: ws only
// closes the server it creates itself.
export function closeEntryPoint(wss: WebSocketServer): void {
    const server = wss.options.server;
    for (const client of wss.clients) {
        client.close(CLOSE_GOING_AWAY);
    }
    wss.close();
    if (server?.listening) {
        server.close();
    }
}

async function openEntryPoint(t: TlsMaterial | undefined): Promise<WebSocketServer> {
    for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt++) {
        const port = generateDynamicallyPort();
        const server = t ? https.createServer({ key: t.key, cert: t.cert }) : http.createServer();
        try {
            await listen(server, port);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
                logger.error(`[remote-device] port ${port} in use (EADDRINUSE); drawing another (attempt ${attempt}/${LISTEN_ATTEMPTS})`);
                continue;
            }
            throw err;
        }
        const wsServer = new WebSocketServer({ server });
        wsServer.options.port = port;
        // ws passes the errors of the http.Server on to the WebSocketServer;
        // without a listener, a late error would bring the process down.
        wsServer.on('error', (err: Error) => {
            logger.error(`[remote-device] error on the entry point of port ${port}: ${err.message}`);
        });
        logger.info(`WebSocket server is running on port ${port}`);
        return wsServer;
    }
    throw new ApiError(200, `no free port for a WebSocket entry point after ${LISTEN_ATTEMPTS} attempts`);
}

function listen(server: http.Server | https.Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
            server.off('listening', onListening);
            reject(err);
        };
        const onListening = (): void => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    });
}
