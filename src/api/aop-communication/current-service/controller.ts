import { Request, Response } from 'express';
import core from '../../../core';

// As rotas de teste GET /authorize e GET /token que viviam aqui sobrepunham
// (por ordem de montagem) a implementacao real de apis/access — desafio
// AES-128, ECDH, refresh token. Removidas (M2 da vacina); este modulo fica
// so com a consulta de servico corrente.

function GETCurrentService(req: Request, res: Response): void {
	res.status(200).json({
		serviceContextId : core.current.serviceContextId,
		serviceName : core.current.serviceName,
		transportStreamId : core.current.transportStreamId,
		originalNetworkId : core.current.originalNetworkId,
		serviceId : String(core.current.serviceId)
	});
}


export default { GETCurrentService }