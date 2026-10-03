import * as dotenv from 'dotenv';
import { Request, Response } from "express";
import { Socket } from 'dgram';
import { Server } from '@lvcabral/node-ssdp';
import logger from './logger';
import { pairingMethods } from './api/client-identification';
import {
  SSDP_ST, AdvertisedEndpoint, resolveAdvertisedEndpoint, baseURL, secureBaseURL, locationURL,
  advertiseWarnings,
} from './ssdp-config';
dotenv.config();

const brandName = process.env.BRAND_NAME || 'GenericBrand';
const model = process.env.MODEL || 'GenericModel';
const friendlyName = process.env.FRIENDLY_NAME || 'TV 3.0 Receiver';
const myUDN = process.env.UDN || 'uuid:TV30-1234-5678-9012-345678901234';

// Tempo para o ssdp:byebye sair antes de encerrar (o envio UDP e assincrono).
const BYEBYE_GRACE_MS = 300;

// D9 (morre-inteiro): o SSDP nao pode morrer em silencio com o resto do
// processo de pe. Em falha, log claro e exit 1 — o container tem restart.
function fatal(what: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[ssdp] FALHA em ${what}: ${msg} — encerrando o processo (descoberta SSDP e parte do servico)`);
  process.exit(1);
}

// Resolvido uma vez no boot: LOCATION e Server-*BaseURL saem do mesmo valor.
let endpoint: AdvertisedEndpoint;
try {
  endpoint = resolveAdvertisedEndpoint();
} catch (err) {
  fatal('configuracao do anuncio (EDGE_HTTP_PORT/EDGE_HTTPS_PORT)', err);
}
// logger.error: o nivel padrao (LOG_LEVEL=ERROR) esconderia info/debug.
for (const warning of advertiseWarnings(endpoint)) {
  logger.error(`[ssdp] AVISO ${warning}`);
}

import app from './app';
app.use('/manifest', (req: Request, res: Response) => {
  res.setHeader('Server-BaseURL', baseURL(endpoint));
  res.setHeader('Server-SecureBaseURL', secureBaseURL(endpoint));
  res.setHeader('Server-PairingMethods', pairingMethods.join(','));
  res.setHeader('Device-BrandName', brandName);
  res.setHeader('Device-Model', model);
  res.setHeader('Device-FriendlyName', friendlyName);
  res.sendStatus(200);
});

const ssdpServer = new Server({
  location: locationURL(endpoint),
  udn: myUDN,
  ssdpPort: 1900,
  reuseAddr: true,
  adInterval: 10000,
  ttl: 4,
});

ssdpServer.addUSN(SSDP_ST);

// Falhas da biblioteca que antes passavam em silencio:
//  - sem interface IPv4 externa ("No sockets available"): a promessa de
//    start() rejeita (bluebird so imprimia "Unhandled rejection");
//  - erro de socket (ex.: bind da 1900 recusado): a biblioteca so loga em
//    debug e o anuncio nunca comeca.
// A falha de addMembership ja derrubava o processo (excecao nao tratada
// dentro da biblioteca), entao nao e silenciosa.
function watchSockets(): void {
  const sockets = (ssdpServer as unknown as { sockets?: Record<string, Socket> }).sockets ?? {};
  for (const [address, socket] of Object.entries(sockets)) {
    socket.on('error', (err) => fatal(`socket UDP 1900 (${address})`, err));
  }
}

let stopping = false;
function sendByeAndExit(signal: NodeJS.Signals, code: number): void {
  if (stopping) return;
  stopping = true;
  logger.info(`[ssdp] ${signal}: enviando ssdp:byebye`);
  try {
    ssdpServer.advertise(false);
  } catch (err) {
    logger.error(`[ssdp] byebye nao enviado: ${err instanceof Error ? err.message : String(err)}`);
  }
  setTimeout(() => process.exit(code), BYEBYE_GRACE_MS);
}

export function startSSDP(): void {
  let started: void | Promise<void>;
  try {
    started = ssdpServer.start();
  } catch (err) {
    fatal('inicio do anunciante', err);
  }
  watchSockets();

  Promise.resolve(started).then(
    () => logger.info(`[ssdp] anunciando ${SSDP_ST} em UDP 1900; LOCATION ${locationURL(endpoint)} (host via ${endpoint.source})`),
    (err) => fatal('inicio do anunciante (bind UDP 1900)', err),
  );

  process.once('SIGTERM', () => sendByeAndExit('SIGTERM', 143));
  process.once('SIGINT', () => sendByeAndExit('SIGINT', 130));
}

export default ssdpServer;
