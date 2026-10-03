import { Request, Response } from 'express';
import core from '../../core';
import service from './service';
import { checkRegistration } from './bind-token';
import { returnError } from '../../util';

// Broadcaster security APIs (C.6.8). A classe de cliente que pode chamar
// cada rota (106: POST/DELETE so associado, GET so autonomo/nao local) NAO
// e checada aqui: fica na borda, no plugin tv30-auth (D1). Erros de negocio
// (300, 101, 108) sobem como ApiError ate o errorHandler.

// C.6.8.2 (Tabela C.47): registra {alg, key} para o servico corrente.
async function POSTBindContext(req: Request, res: Response): Promise<void> {
    const check = checkRegistration(req.body);
    if (!check.ok) {
        returnError(res, check.code, check.detail);
        return;
    }
    await service.registerKey(check.alg, check.key);
    res.status(200).json({ serviceContextId: core.current.serviceContextId });
}

// C.6.8.3 (Tabela C.48): servicos aos quais o bind-token da acesso.
async function GETBindContext(req: Request, res: Response): Promise<void> {
    const token = req.get('bind-token')?.trim();
    if (!token) {
        returnError(res, 104, 'missing header, bind-token');
        return;
    }
    const boundServices = await service.boundServices(token);
    res.status(200).json({ boundServices });
}

// C.6.8.4 (Tabela C.49): revoga a chave do servico corrente; {} mesmo se
// ela nao existia.
async function DELETEBindContext(req: Request, res: Response): Promise<void> {
    const key = req.get('key')?.trim();
    if (!key) {
        returnError(res, 105, 'key');
        return;
    }
    await service.revokeKey(key);
    res.status(200).json({});
}

export default { POSTBindContext, GETBindContext, DELETEBindContext };
