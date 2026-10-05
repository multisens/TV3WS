// Processo que SO anuncia a descoberta SSDP (C.3.4): o container tv3ws-ssdp
// do compose raiz, em rede do host (L6 = opcao B, informado pelo Luis em
// 04/10). Mesma imagem do tv3ws, outro programa (dist/ssdp-announcer.js):
// sem Express, sem Redis, sem MQTT, sem porta TCP. O LOCATION aponta para o
// /manifest servido pelo tv3ws atras da borda.
//
// Morre-inteiro (D9): falha do anuncio encerra este processo com log
// [ssdp] FALHA e exit 1 (o container tem restart), sem derrubar as APIs do
// tv3ws, que roda em outro container.
import * as dotenv from 'dotenv';
dotenv.config();

import logger from './logger';
import { loadAdvertisedEndpoint, ssdpEnabled, startSSDP } from './ssdp-server';

// SSDP_ENABLED vale para o anuncio de dentro do tv3ws; aqui pode chegar pelo
// tv3ws/.env (env_file comum aos dois servicos) e e ignorado: este processo
// existe so para anunciar.
if (!ssdpEnabled()) {
  logger.error(`[ssdp] SSDP_ENABLED=${process.env.SSDP_ENABLED?.trim()} ignorado: este processo existe so para anunciar`);
}

startSSDP(loadAdvertisedEndpoint());
