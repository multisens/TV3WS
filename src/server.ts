import './boot-env';
import http from 'http';
import https from 'https';
import logger from './logger';
import app from './app';
import { connectRedis, whenRedisReady } from './redis-client';
import { clearStoredRegistry } from './modules/remotedevice-manager/manager';
import { backfillAuthorizedClients } from './modules/auth-manager/manager';
import { startEntryServer } from './v100.0/modules/remote-device/entry-server';
import { startProjection } from './v100.0/modules/remote-device/projection';
import { startNotificationServer } from './v100.0/modules/notifications/server';
import { loadAdvertisedEndpoint, registerManifest } from './manifest';
import { listenHosts } from './listen-hosts';
import { tlsMaterial } from './tls';
import { positiveIntFromEnv } from './util';

const BOOT_FAILURE_EXIT_CODE = 1;
const SIGTERM_EXIT_CODE = 143;
const SIGINT_EXIT_CODE = 130;
const HTTP_PORT = positiveIntFromEnv('HTTP_PORT');
const HTTPS_PORT = positiveIntFromEnv('HTTPS_PORT');

// Fills clients:authorized from the client:* keys of Redis.
async function backfillClients(): Promise<void> {
    const added = await backfillAuthorizedClients();
    if (added > 0) {
        logger.info(`[redis] ${added} registered client(s) added to clients:authorized`);
    }
}

// Starts the servers of API version 100.0; a server that does not start
// stops the process.
async function startV100Servers(): Promise<void> {
    try {
        await startEntryServer();
        await startNotificationServer();
    } catch (err) {
        logger.error(`[v100.0] server not started: ${(err as Error).message}`);
        process.exit(BOOT_FAILURE_EXIT_CODE);
    }
}

// Serves the app over HTTP on each listening host.
function startHttp(hosts: string[]): void {
    for (const host of hosts) {
        http.createServer(app).listen(HTTP_PORT, host, () => {
            logger.info(`TV 3.0 HTTP Webservice running on ${host}:${HTTP_PORT}`);
        });
    }
}

// Serves the app over HTTPS on each listening host, when there is a
// certificate.
function startHttps(hosts: string[]): void {
    const tls = tlsMaterial();
    if (!tls) {
        logger.info('[boot] no certificate (TV30_TLS_DIR, HTTPS_KEY/HTTPS_CERT): HTTPS disabled (HTTP only)');
        return;
    }
    for (const host of hosts) {
        https.createServer({ key: tls.key, cert: tls.cert }, app).listen(HTTPS_PORT, host, () => {
            logger.info(`TV 3.0 HTTPS Webservice running on ${host}:${HTTPS_PORT} (certificate from ${tls.source})`);
        });
    }
}

whenRedisReady('cleanup of the remote-devices mirror', clearStoredRegistry);
whenRedisReady('clients:authorized from client:*', backfillClients);
whenRedisReady('cleanup of the v100.0 remote-devices projection', startProjection);
connectRedis();

void startV100Servers();

// /manifest (C.3.4). An invalid edge port stops the process at startup.
registerManifest(app, loadAdvertisedEndpoint());

const hosts = listenHosts();
startHttp(hosts);
startHttps(hosts);

// node as PID 1 of the container would ignore SIGTERM.
process.once('SIGTERM', () => process.exit(SIGTERM_EXIT_CODE));
process.once('SIGINT', () => process.exit(SIGINT_EXIT_CODE));

if (process.send) {
    process.send('ready');
}
