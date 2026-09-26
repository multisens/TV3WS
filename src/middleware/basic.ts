import express, { NextFunction, Request, Response, Router } from 'express';
import { returnError } from '../util';
import { getRequestClass } from '../modules/auth-manager/manager';
const router: Router = express.Router();

// Negociacao de versao via Accept-Version (decisao de reuniao 21/09): a
// versao da norma e a 2.0 e vale quando o cabecalho falta; a 2.1 preserva a
// proposta em discussao no Forum (fluxo de remote-device por handle).
// Cabecalho malformado -> erro 101; versao fora do conjunto -> erro 100.
const SUPPORTED_VERSIONS = ['2.0', '2.1'];
const DEFAULT_VERSION = '2.0';

router.use((req: Request, res: Response, next: NextFunction) => {
    // CORS eh tratado pelo KrakenD (gateway). Setar aqui causa duplicacao
    // do header Access-Control-Allow-Origin no response final, que o Chrome
    // bloqueia como CORS violation.

    // Default header values
    res.setHeader('Content-Type', 'application/json');

    // Basic validation (define res.locals.apiVersion e o header API-Version)
    if (!validateAcceptVersion(req, res)) return;

    // Avoid access validation for authorization API
    if (req.path === '/authorize' || req.path === '/token') {
        return next();
    }

    // Autentication validation
    if (!validateClientProtocol(req, res)) return;

    next();
});

function validateAcceptVersion(req: Request, res: Response): boolean {
    const requested = req.get('Accept-Version');

    if (requested === undefined) {
        res.locals.apiVersion = DEFAULT_VERSION;
        res.setHeader('API-Version', DEFAULT_VERSION);
        return true;
    }

    if (!/^\d+\.\d+$/.test(requested)) {
        returnError(res, 101, `malformed Accept-Version '${requested}'`);
        return false;
    }

    if (!SUPPORTED_VERSIONS.includes(requested)) {
        returnError(res, 100, `unsupported version '${requested}' (supported: ${SUPPORTED_VERSIONS.join(', ')})`);
        return false;
    }

    res.locals.apiVersion = requested;
    res.setHeader('API-Version', requested);
    return true;
}

// Restricao por grupo de API (C.4.1): o cliente NAO LOCAL que chegue por
// HTTP fora das rotas de identificacao recebe erro 106. A classe vem da
// credencial (P1) — o antigo teste de faixa RFC1918 invertia o conceito
// (o nao-local tipico e justamente o dispositivo da rede domestica).
function validateClientProtocol(req: Request, res: Response): boolean {
    const clientClass = getRequestClass(req.get('Authorization'));
    const protocol = (req.get('X-Forwarded-Proto') || req.protocol).toLowerCase();

    if (clientClass === 'non-local' && protocol !== 'https') {
        returnError(res, 106);
        return false;
    }
    return true;
}

export default router;