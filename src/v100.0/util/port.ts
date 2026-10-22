import { once } from 'events';
import { Server } from 'net';

const LISTEN_ATTEMPTS = parseInt(process.env.LISTEN_ATTEMPTS || '10');

function generateDynamicallyPort(): number {
    const min = parseInt(process.env.WS_PORT_MIN || '45000');
    const max = parseInt(process.env.WS_PORT_MAX || '45199');
    return Math.floor(min + Math.random() * (max - min));
}

// Makes the server listen on a free port drawn by generateDynamicallyPort,
// drawing again while the port is in use, up to LISTEN_ATTEMPTS times.
// Returns the port; throws if no free port is found or on another error
export async function listenOnFreePort(server: Server): Promise<number> {
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

// Closes the server and waits until it stops, if there is one
export async function closeServer(server: Server | undefined): Promise<void> {
    if (!server) {
        return;
    }
    const closing = once(server, 'close');
    server.close();
    await closing;
}
