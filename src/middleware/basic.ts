import express, { NextFunction, Request, Response, Router } from 'express';
import { returnError } from '../util';
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

    // D-0510-1 (reuniao 05/10 com o Joel): a checagem de classe/protocolo
    // (antigo validateClientProtocol, erro 106 ao nao local fora de HTTPS)
    // saiu daqui junto com a validacao do accessToken (107): credencial e
    // classe sao conferidas so na borda.
    // PENDENTE (Joel): lacuna L3 — sem TLS na borda, o 106 por protocolo da
    // C.4.1.6 (nao local por HTTP fora de C.6.1.2/C.6.1.3) nao e aplicado em
    // lugar nenhum depois desta saida.
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

export default router;