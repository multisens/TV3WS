import { Request, Response } from 'express';
import core from '../../../core';
import { returnError } from '../../../util';
import { integerServiceId } from '../../../util/service-id';

type CurrentServiceResponse = {
	serviceContextId: string;
	serviceName?: string;
	transportStreamId: string;
	originalNetworkId: string;
	serviceId?: number;
};

// C.6.3.1 (Tabela C.8). Servico em uso = ultimo valor de aop/currentService; vazio ou nunca recebido -> 300,
// o mesmo criterio da borda na C.6.8. O 302 nao e emitido: o testbed nao modela recepcao de sinal.
// serviceId sem valor inteiro conhecido e omitido (C.3.2.2); nenhum modulo publica aop/services.
function GETCurrentService(req: Request, res: Response): void {
	if (!core.app.sid) {
		returnError(res, 300);
		return;
	}

	const body: CurrentServiceResponse = {
		serviceContextId : core.current.serviceContextId,
		serviceName : core.current.serviceName || undefined,
		transportStreamId : core.current.transportStreamId,
		originalNetworkId : core.current.originalNetworkId,
	};
	const serviceId = integerServiceId(core.current.serviceId);
	if (serviceId !== undefined) {
		body.serviceId = serviceId;
	}
	res.status(200).json(body);
}

export default { GETCurrentService }
