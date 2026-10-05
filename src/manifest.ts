import { Application, Request, Response } from 'express';
import { pairingMethods } from './api/client-identification';
import { AdvertisedEndpoint, baseURL, secureBaseURL } from './ssdp-config';

// GET /manifest (C.3.4): o destino do LOCATION do anuncio SSDP. Fica no tv3ws,
// atras da borda (rota em infra/edgegateway/routes.json), e responde sempre,
// anuncie este processo ou nao: no compose quem anuncia e o tv3ws-ssdp
// (src/ssdp-announcer.ts, L6 = opcao B). Os dois calculam o host com a mesma
// funcao (resolveAdvertisedEndpoint) a partir da mesma configuracao; o compose
// raiz entrega aos dois os mesmos arquivos de ambiente.
export function registerManifest(
  app: Pick<Application, 'use'>,
  endpoint: AdvertisedEndpoint,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const brandName = env.BRAND_NAME || 'GenericBrand';
  const model = env.MODEL || 'GenericModel';
  const friendlyName = env.FRIENDLY_NAME || 'TV 3.0 Receiver';

  app.use('/manifest', (req: Request, res: Response) => {
    res.setHeader('Server-BaseURL', baseURL(endpoint));
    res.setHeader('Server-SecureBaseURL', secureBaseURL(endpoint));
    res.setHeader('Server-PairingMethods', pairingMethods.join(','));
    res.setHeader('Device-BrandName', brandName);
    res.setHeader('Device-Model', model);
    res.setHeader('Device-FriendlyName', friendlyName);
    res.sendStatus(200);
  });
}
