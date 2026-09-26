import express, { NextFunction, Request, Response, Router } from 'express';
import * as manager from '../modules/auth-manager/manager';
import { returnError } from '../util';
const router: Router = express.Router();

// Validacao de credencial nas APIs. A isencao antiga por faixa de endereco
// (isLocalClient/RFC1918) saiu: classe de cliente nao se infere de rede (P1).
//
// TRANSICAO: credencial presente e validada (invalida -> erro 107); ausencia
// de credencial ainda passa, porque a EXIGENCIA do accessToken e trabalho do
// item 9 (P2 — validacao na borda), que sera avaliado antes de implementado.
router.use((req: Request, res: Response, next: NextFunction) => {
    // As rotas de identificacao de cliente sao as unicas sem credencial por
    // definicao (e delas que a credencial sai).
    if (req.path === '/authorize' || req.path === '/token') {
        return next();
    }

    const token = req.get('Authorization');
    if (token !== undefined) {
        const payload = manager.decodeAccessToken(token);
        if (payload === null) {
            returnError(res, 107);
            return;
        }
        // classe declarada na credencial, disponivel aos handlers
        res.locals.clientClass = payload.class;
        res.locals.clientId = payload.sub;
    }

    next();
});

export default router;
