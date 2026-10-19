import { Application, Request, Response } from 'express';
import logger from './logger';
import { pairingMethods } from './api/client-identification';
import {
  AdvertisedEndpoint, advertiseWarnings, normalizeHost, resolveAdvertisedEndpoint,
} from './ssdp-config';

// GET /manifest (C.3.4): o destino do LOCATION do anuncio SSDP. Fica no tv3ws,
// atras da borda (rota em infra/edgegateway/routes.json). Quem anuncia e o
// anunciante nativo do host (infra/edgegateway/ssdp, em Go, subido pelo
// comando ./tv30 up; complemento do Joel de 15/10), que detecta o host — o
// IPv4 da interface por onde o anuncio sai. O /manifest tem de sair com o
// MESMO host (complemento, 3.4): ele usa o endereco pelo qual o cliente acabou
// de alcanca-lo — o cabecalho Host original da requisicao, que a borda repassa
// em X-TV30-Host (apagando o que vier do cliente) —, e o SSDP_ADVERTISE_HOST,
// se definido, prevalece, como no anunciante. Sem X-TV30-Host (requisicao que
// nao passou pela borda), vale o Host da propria requisicao; sem nenhum dos
// dois, a cadeia antiga (SERVER_URL, depois o IP local). Ate 15/10 o host era
// resolvido uma vez no boot (SSDP_ADVERTISE_HOST > SERVER_URL > IP local), e o
// anunciante Node deste processo (dev-host) saiu nessa data.
export const INTERNAL_HOST_HEADER = 'X-TV30-Host';

// Resolvido uma vez no boot: as portas da borda e o host de sobreposicao.
// Porta da borda invalida derruba o processo com log [ssdp] FALHA (D9).
export function loadAdvertisedEndpoint(env: NodeJS.ProcessEnv = process.env): AdvertisedEndpoint {
  let endpoint: AdvertisedEndpoint;
  try {
    endpoint = resolveAdvertisedEndpoint(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[ssdp] FALHA em configuracao do /manifest (EDGE_HTTP_PORT/EDGE_HTTPS_PORT): ${msg} — encerrando o processo`);
    process.exit(1);
  }
  // logger.error: o nivel padrao (LOG_LEVEL=ERROR) esconderia info/debug.
  for (const warning of advertiseWarnings(endpoint)) {
    logger.error(`[ssdp] AVISO ${warning}`);
  }
  return endpoint;
}

// host do /manifest para esta requisicao (ver o cabecalho deste arquivo)
export function manifestHost(endpoint: AdvertisedEndpoint, req: Pick<Request, 'get'>): string {
  if (endpoint.source === 'SSDP_ADVERTISE_HOST') return endpoint.host;
  return normalizeHost(req.get(INTERNAL_HOST_HEADER)) || normalizeHost(req.get('host')) || endpoint.host;
}

// Cabecalhos do /manifest, na ordem em que saem. O navegador so deixa o
// JavaScript de outra origem ler os que estiverem em
// Access-Control-Expose-Headers (decisao do Luis em 11/10, B3): a lista sai
// destes mesmos nomes. Access-Control-Allow-Origin nao sai daqui: a borda o
// define em toda resposta (plugin tv30-auth), e duplicado o Chrome recusa.
export const MANIFEST_HEADERS = [
  'Server-BaseURL',
  'Server-SecureBaseURL',
  'Server-PairingMethods',
  'Device-BrandName',
  'Device-Model',
  'Device-FriendlyName',
] as const;

export function registerManifest(
  app: Pick<Application, 'use'>,
  endpoint: AdvertisedEndpoint,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const brandName = env.BRAND_NAME || 'GenericBrand';
  const model = env.MODEL || 'GenericModel';
  const friendlyName = env.FRIENDLY_NAME || 'TV 3.0 Receiver';

  app.use('/manifest', (req: Request, res: Response) => {
    const host = manifestHost(endpoint, req);
    const values: Record<(typeof MANIFEST_HEADERS)[number], string> = {
      'Server-BaseURL': `${host}:${endpoint.httpPort}`,
      'Server-SecureBaseURL': `${host}:${endpoint.httpsPort}`,
      'Server-PairingMethods': pairingMethods.join(','),
      'Device-BrandName': brandName,
      'Device-Model': model,
      'Device-FriendlyName': friendlyName,
    };
    for (const name of MANIFEST_HEADERS) res.setHeader(name, values[name]);
    res.setHeader('Access-Control-Expose-Headers', MANIFEST_HEADERS.join(', '));
    res.sendStatus(200);
  });
}
