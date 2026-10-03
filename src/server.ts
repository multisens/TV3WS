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


// Descoberta SSDP (C.3.4): falha de inicio derruba o processo com log claro
// (D9); o log de "anunciando" so sai quando o bind da 1900 conclui.
import { startSSDP } from './ssdp-server';
startSSDP();


if (process.send) {
    process.send('ready');
}