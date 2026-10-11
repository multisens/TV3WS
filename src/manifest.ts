import { Application, Request, Response } from 'express';
import { pairingMethods } from './api/client-identification';
import { AdvertisedEndpoint, baseURL, secureBaseURL } from './ssdp-config';

// GET /manifest (C.3.4): o destino do LOCATION do anuncio SSDP. Fica no tv3ws,
// atras da borda (rota em infra/edgegateway/routes.json), e responde sempre,
// anuncie este processo ou nao: no compose quem anuncia e a BORDA, em rede do
// host (L6 = opcao A, decisao do Luis em 09/10; infra/edgegateway/ssdp, em Go).
// Os dois leem os mesmos arquivos de ambiente, que o compose raiz e o
// docker-compose.ssdp.yml entregam aos dois. O host daqui segue a regra de
// ./ssdp-config.ts (SSDP_ADVERTISE_HOST > SERVER_URL > IP local); a borda,
// desde a decisao do Luis em 11/10 (B2), so anuncia com SSDP_ADVERTISE_HOST
// definido (sem ele, erro de configuracao), entao, com o anuncio ligado, os
// dois saem do mesmo SSDP_ADVERTISE_HOST.

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
    const values: Record<(typeof MANIFEST_HEADERS)[number], string> = {
      'Server-BaseURL': baseURL(endpoint),
      'Server-SecureBaseURL': secureBaseURL(endpoint),
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
