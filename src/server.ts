import * as dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import logger from './logger';
import { assertEnv } from './util';
dotenv.config();

// USER_DATA_FILE deixou de ser exigido: o tv3ws nao semeia mais perfis
// (D-0510-5, reuniao 05/10 com o Joel; a carga inicial e do redis).
assertEnv([
    'MQTT_HOST',
    'REDIS_HOST',
    'JWT_SECRET',
    'USER_THUMBS',
]);

import app from './app';

// Redis (D-0510-6): conexao aberta ja no boot, com log explicito de pronto,
// perda e falha (redis-client.ts). As tarefas de boot que dependem dele rodam
// no primeiro 'ready'; antes eram promessas soltas disparadas no import.
import { connectRedis, whenRedisReady } from './redis-client';
import { clearStoredRegistry } from './modules/remotedevice-manager/manager';
import { backfillAuthorizedClients } from './modules/auth-manager/manager';
whenRedisReady('limpeza do espelho de remote-devices', clearStoredRegistry);
whenRedisReady('clients:authorized a partir de client:*', async () => {
    const added = await backfillAuthorizedClients();
    if (added > 0) console.log(`[redis] ${added} cliente(s) antigo(s) incluido(s) em clients:authorized`);
});
connectRedis();

// /manifest (C.3.4): as portas da borda e o host de sobreposicao, resolvidos
// no boot; o host de cada resposta sai da requisicao (src/manifest.ts).
// Porta da borda invalida derruba o processo com log [ssdp] FALHA (D9).
import { loadAdvertisedEndpoint, registerManifest } from './manifest';
registerManifest(app, loadAdvertisedEndpoint());

// Enderecos de escuta (src/listen-hosts.ts): no host, so a propria maquina
// por padrao (Joel, 15/10); no container, todos (TV3WS_LISTEN_HOST do compose).
import { listenHosts } from './listen-hosts';
const hosts = listenHosts();

const httpPort = Number(process.env.HTTP_PORT || 44642);
for (const host of hosts) {
    http.createServer(app).listen(httpPort, host, () => {
        logger.info(`TV 3.0 HTTP Webservice running on ${host}:${httpPort}`);
    });
}

// HTTPS com o certificado do receptor (A7, src/tls.ts): o do .tv30/tls que o
// compose monta (TV30_TLS_DIR), senao HTTPS_KEY/HTTPS_CERT. Sem nenhum, so
// HTTP (o tv3ws rodando no host sem configuracao).
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


// Sem anunciante neste processo desde 15/10 (complemento do Joel: o anuncio
// e do anunciante nativo do host, ./tv30 up). O node como PID 1 do container
// ignoraria o SIGTERM, e o docker stop esperaria o SIGKILL.
process.once('SIGTERM', () => process.exit(143));
process.once('SIGINT', () => process.exit(130));


if (process.send) {
    process.send('ready');
}