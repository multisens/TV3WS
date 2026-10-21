import { Application, Request, Response } from 'express';
import logger from './logger';
import { pairingMethods } from './api/client-identification';
import {
  AdvertisedEndpoint, advertiseWarnings, normalizeHost, resolveAdvertisedEndpoint,
} from './ssdp-config';

// GET /manifest (C.3.4), destino do LOCATION do anuncio SSDP (feito pelo anunciante nativo do host).
// O host tem de ser o do anuncio: SSDP_ADVERTISE_HOST, se definido; senao o Host original, que a borda
// repassa em X-TV30-Host; senao o Host da requisicao; senao SERVER_URL ou o IP local.
export const INTERNAL_HOST_HEADER = 'X-TV30-Host';

// Portas da borda e host de sobreposicao, resolvidos uma vez no boot.
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

export function manifestHost(endpoint: AdvertisedEndpoint, req: Pick<Request, 'get'>): string {
  if (endpoint.source === 'SSDP_ADVERTISE_HOST') return endpoint.host;
  return normalizeHost(req.get(INTERNAL_HOST_HEADER)) || normalizeHost(req.get('host')) || endpoint.host;
}

// O navegador so deixa JavaScript de outra origem ler o que estiver em Access-Control-Expose-Headers.
// Access-Control-Allow-Origin fica na borda: duplicado, o Chrome recusa.
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
