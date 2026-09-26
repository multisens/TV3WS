import express, { NextFunction, Request, Response, Router } from 'express';
import { returnError } from '../util';
import { getRequestClass } from '../modules/auth-manager/manager';
const router: Router = express.Router();

router.use((req: Request, res: Response, next: NextFunction) => {
    // CORS eh tratado pelo KrakenD (gateway). Setar aqui causa duplicacao
    // do header Access-Control-Allow-Origin no response final, que o Chrome
    // bloqueia como CORS violation.

    // Default header values
    res.setHeader('API-Version', '2.0');
    res.setHeader('Content-Type', 'application/json');

    // Basic validation
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
    // Check if the client is compatible with current version
    var client_version = req.get('Accept-Version');
    if (client_version !== undefined && client_version !== '2.0') {
        returnError(res, 100);
        return false;
    }
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