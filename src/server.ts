import * as dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import logger from './logger';
import { assertEnv } from './util';
dotenv.config();

assertEnv([
    'MQTT_HOST',
    'REDIS_HOST',
    'JWT_SECRET',
    'USER_THUMBS',
]);

import app from './app';

import { connectRedis, whenRedisReady } from './redis-client';
import { clearStoredRegistry } from './modules/remotedevice-manager/manager';
import { backfillAuthorizedClients } from './modules/auth-manager/manager';
whenRedisReady('limpeza do espelho de remote-devices', clearStoredRegistry);
whenRedisReady('clients:authorized a partir de client:*', async () => {
    const added = await backfillAuthorizedClients();
    if (added > 0) console.log(`[redis] ${added} cliente(s) registrado(s) incluido(s) em clients:authorized`);
});
connectRedis();

// /manifest (C.3.4). Porta da borda invalida derruba o processo no boot.
import { loadAdvertisedEndpoint, registerManifest } from './manifest';
registerManifest(app, loadAdvertisedEndpoint());

import { listenHosts } from './listen-hosts';
const hosts = listenHosts();

const httpPort = Number(process.env.HTTP_PORT || 44642);
for (const host of hosts) {
    http.createServer(app).listen(httpPort, host, () => {
        logger.info(`TV 3.0 HTTP Webservice running on ${host}:${httpPort}`);
    });
}

import { tlsMaterial } from './tls';
const tls = tlsMaterial();
if (tls) {
    const httpsPort = Number(process.env.HTTPS_PORT || 44643);
    for (const host of hosts) {
        https.createServer({ key: tls.key, cert: tls.cert }, app).listen(httpsPort, host, () => {
            logger.info(`TV 3.0 HTTPS Webservice running on ${host}:${httpsPort} (certificado de ${tls.source})`);
        });
    }
} else {
    logger.info('[boot] sem certificado (TV30_TLS_DIR, HTTPS_KEY/HTTPS_CERT) — HTTPS desabilitado (somente HTTP)');
}

// O node como PID 1 do container ignoraria o SIGTERM, e o docker stop esperaria o SIGKILL.
process.once('SIGTERM', () => process.exit(143));
process.once('SIGINT', () => process.exit(130));

if (process.send) {
    process.send('ready');
}