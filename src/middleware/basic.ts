import express, { NextFunction, Request, Response, Router } from 'express';
const router: Router = express.Router();

// Versao de API (C.3.6). D2 e D4 (Joel, 15/10): quem negocia e a BORDA, rota a
// rota, pelas versoes que o infra/edgegateway/routes.json declara (campo
// versions); ela responde 100 e 101 e repassa a versao decidida no cabecalho
// interno X-TV30-API-Version, que apaga o que vier do cliente. O tv3ws deixou
// de interpretar o Accept-Version: produz a resposta na versao recebida
// (res.locals.apiVersion) e a devolve no API-Version de toda resposta,
// inclusive a de erro (C.3.6.6). Sem o cabecalho — requisicao que nao passou
// pela borda, como nos testes, ou o tv3ws alcancado direto, o que a condicao
// de validade de Escopo e desenho 6.2 veda — vale a 2.0 (C.3.6.5). Ate 15/10
// o tv3ws negociava aqui, com o conjunto ['2.0', '2.1'] escrito a mao tambem
// na borda (infra/edgegateway/plugin/edge.go).
export const INTERNAL_VERSION_HEADER = 'X-TV30-API-Version';
const DEFAULT_VERSION = '2.0';

function decidedVersion(req: Request): string {
    const v = req.get(INTERNAL_VERSION_HEADER);
    return v !== undefined && /^\d+\.\d+$/.test(v) ? v : DEFAULT_VERSION;
}

router.use((req: Request, res: Response, next: NextFunction) => {
    // CORS eh tratado pelo KrakenD (gateway). Setar aqui causa duplicacao
    // do header Access-Control-Allow-Origin no response final, que o Chrome
    // bloqueia como CORS violation.

    // Default header values
    res.setHeader('Content-Type', 'application/json');

    const version = decidedVersion(req);
    res.locals.apiVersion = version;
    res.setHeader('API-Version', version);

    // D-0510-1 (reuniao 05/10 com o Joel): credencial e classe sao conferidas
    // so na borda, inclusive o 106 ao nao local por HTTP (C.4.1.6), que voltou
    // la em 15/10 (E7, Joel).
    next();
});

export default router;
