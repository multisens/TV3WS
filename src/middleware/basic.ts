import express, { NextFunction, Request, Response, Router } from 'express';
import { returnError } from '../util';
const router: Router = express.Router();

// Negociacao de versao via Accept-Version (decisao de reuniao 21/09): a
// versao da norma e a 2.0 e vale quando o cabecalho falta; a 2.1 preserva a
// proposta em discussao no Forum (fluxo de remote-device por handle).
// Cabecalho malformado -> erro 101; versao fora do conjunto -> erro 100.
//
// C.3.6.6 (p. 201; p. 219 do PDF): TODA resposta leva API-Version, inclusive
// a de erro. Na resposta normal (e nos erros das proprias APIs), a versao
// negociada. No 100 o servidor nao consegue responder na versao pedida, e a
// norma manda a versao mais recente que ele suporta (LATEST_VERSION, hoje
// 2.1). No 101 o pedido nao traz versao legivel: vale a da norma, como na
// falta do cabecalho (C.3.6.5). Leitura feita na implementacao em 10/10;
// A CONFIRMAR (Luis). A borda tem a mesma negociacao para as rotas dela
// (apiVersion, infra/edgegateway/plugin/handler.go) e precisa casar com esta.
const SUPPORTED_VERSIONS = ['2.0', '2.1'];
const DEFAULT_VERSION = '2.0';
const LATEST_VERSION = SUPPORTED_VERSIONS.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));

// "X.Y" numerico (C.3.6.2): 2.10 e mais recente que 2.9.
function compareVersions(a: string, b: string): number {
    const [amaj, amin] = a.split('.').map(Number);
    const [bmaj, bmin] = b.split('.').map(Number);
    return amaj !== bmaj ? amaj - bmaj : amin - bmin;
}

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
        res.setHeader('API-Version', DEFAULT_VERSION);
        returnError(res, 101, `malformed Accept-Version '${requested}'`);
        return false;
    }

    if (!SUPPORTED_VERSIONS.includes(requested)) {
        res.setHeader('API-Version', LATEST_VERSION);
        returnError(res, 100, `unsupported version '${requested}' (supported: ${SUPPORTED_VERSIONS.join(', ')})`);
        return false;
    }

    res.locals.apiVersion = requested;
    res.setHeader('API-Version', requested);
    return true;
}

export default router;