import express, { NextFunction, Request, Response, Router } from 'express';
const router: Router = express.Router();

// Versao de API (C.3.6): a borda negocia e repassa a versao em X-TV30-API-Version (apagando a do
// cliente); aqui ela vai para res.locals e para o API-Version de toda resposta, inclusive erro
// (C.3.6.6). Sem o cabecalho (requisicao que nao passou pela borda, como nos testes), vale 2.0 (C.3.6.5).
export const INTERNAL_VERSION_HEADER = 'X-TV30-API-Version';
const DEFAULT_VERSION = '2.0';

function decidedVersion(req: Request): string {
    const v = req.get(INTERNAL_VERSION_HEADER);
    return v !== undefined && /^\d+\.\d+$/.test(v) ? v : DEFAULT_VERSION;
}

router.use((req: Request, res: Response, next: NextFunction) => {
    // CORS fica na borda: setar aqui duplica o Access-Control-Allow-Origin, e o Chrome bloqueia.

    res.setHeader('Content-Type', 'application/json');

    const version = decidedVersion(req);
    res.locals.apiVersion = version;
    res.setHeader('API-Version', version);
    next();
});

export default router;
