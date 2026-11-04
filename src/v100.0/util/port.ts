import { randomInt } from 'crypto';
import { once } from 'events';
import { Server } from 'net';
import { positiveIntFromEnv } from '../../util';

const MAX_PORT = 65535;
const WS_PORT_MIN = positiveIntFromEnv('WS_PORT_MIN');
const WS_PORT_MAX = positiveIntFromEnv('WS_PORT_MAX');
const LISTEN_ATTEMPTS = positiveIntFromEnv('LISTEN_ATTEMPTS');

// Makes the server listen on a free port drawn from WS_PORT_MIN to
// WS_PORT_MAX, drawing again while the port is in use, up to
// LISTEN_ATTEMPTS times. Returns the port; throws if no free port is found
// or on another error
export async function listenOnFreePort(server: Server): Promise<number> {
    for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt++) {
        const port = drawPort();
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

// Closes the server and waits until it stops, if there is one
export async function closeServer(server: Server | undefined): Promise<void> {
    if (!server) {
        return;
    }
    const closing = once(server, 'close');
    server.close();
    await closing;
}

// Returns a port drawn from WS_PORT_MIN to WS_PORT_MAX, both included
function drawPort(): number {
    return randomInt(WS_PORT_MIN, WS_PORT_MAX + 1);
}

// Throws if the port range is not valid
function assertPortRange(): void {
    if (WS_PORT_MIN > WS_PORT_MAX || WS_PORT_MAX > MAX_PORT) {
        throw new Error(`invalid port range WS_PORT_MIN=${WS_PORT_MIN} WS_PORT_MAX=${WS_PORT_MAX}`);
    }
}

assertPortRange();
