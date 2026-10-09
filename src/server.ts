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
    'USER_DATA_FILE',
    'USER_THUMBS',
]);

import app from './app';

// Endereco divulgado pela descoberta SSDP (C.3.4), resolvido uma vez no boot:
// o /manifest (sempre servido aqui, atras da borda) e o anuncio, quando ligado
// neste processo, saem do mesmo valor. Porta da borda invalida derruba o
// processo com log [ssdp] FALHA (D9).
import { loadAdvertisedEndpoint, ssdpEnabled, startSSDP } from './ssdp-server';
import { registerManifest } from './manifest';
const advertised = loadAdvertisedEndpoint();
registerManifest(app, advertised);

const http_server = http.createServer(app);

const httpPort = process.env.HTTP_PORT || 44642;
http_server.listen(httpPort, () => {
    logger.info(`TV 3.0 HTTP Webservice running on port: ${httpPort}`);
});

// HTTPS sobe apenas quando HTTPS_KEY/HTTPS_CERT (base64) estao presentes.
// Sem eles o servico opera so em HTTP — suficiente pra subida local em
// maquina nova sem nenhum arquivo pre-criado.
const httpsKey = process.env.HTTPS_KEY?.trim();
const httpsCert = process.env.HTTPS_CERT?.trim();
if (httpsKey && httpsCert) {
    const https_server = https.createServer({
        key: Buffer.from(httpsKey, 'base64'),
        cert: Buffer.from(httpsCert, 'base64')
    }, app);
    const httpsPort = process.env.HTTPS_PORT || 44643;
    https_server.listen(httpsPort, () => {
        logger.info(`TV 3.0 HTTPS Webservice running on port: ${httpsPort}`);
    });
} else {
    logger.info('[boot] HTTPS_KEY/HTTPS_CERT ausentes — HTTPS desabilitado (somente HTTP)');
}


// Anuncio SSDP (C.3.4). No compose quem anuncia e a borda, em rede do host
// (L6 = opcao A, decisao do Luis em 09/10): o tv3ws da bridge roda com
// SSDP_ENABLED=false, porque o multicast nao sai da bridge. Sozinho no host
// (dev-host), o padrao e anunciar daqui: falha de inicio derruba o processo
// com log claro (D9); o log de "anunciando" so sai quando o bind da 1900 conclui.
if (ssdpEnabled()) {
    startSSDP(advertised);
} else {
    logger.error(`[ssdp] anuncio desligado (SSDP_ENABLED=${process.env.SSDP_ENABLED?.trim()}); `
        + 'o /manifest continua servido por este processo');
    // O anunciante tratava SIGTERM/SIGINT. Sem ele, o node como PID 1 do
    // container ignoraria o SIGTERM e o docker stop esperaria o SIGKILL.
    process.once('SIGTERM', () => process.exit(143));
    process.once('SIGINT', () => process.exit(130));
}


if (process.send) {
    process.send('ready');
}