import { Request, Response } from 'express';
import core from '../../../core';
import { returnError } from '../../../util';

// As rotas de teste GET /authorize e GET /token que viviam aqui sobrepunham
// (por ordem de montagem) a implementacao real de apis/access — desafio
// AES-128, ECDH, refresh token. Removidas (M2 da vacina); este modulo fica
// so com a consulta de servico corrente.

type CurrentServiceResponse = {
	serviceContextId: string;
	serviceName?: string;
	transportStreamId: string;
	originalNetworkId: string;
	serviceId?: number;
};

// C.6.3.1 (Tabela C.8, p. 222; p. 240 do PDF). Servico em uso = o ultimo
// valor de aop/currentService (core.app.sid), publicado pela plataforma na
// selecao do servico e esvaziado quando ela o desfaz; vazio ou nunca recebido
// -> erro 300 ("If the DTV function is not in use in the receiver"). E o
// mesmo criterio da borda para o 300 da C.6.8 (session:current-service-id,
// espelho do mesmo topico). O 302 (sem recepcao de sinal) nao e emitido: o
// testbed nao tem estado de recepcao. O 107 e da borda (D-0510-1).
//
// "serviceId" e inteiro na Tabela C.8 (@serviceId do <Service> da SLT); antes
// saia como texto ("-1", "undefined").
// PENDENTE (Joel): lacuna L2 (A6 de decisoes-pendentes.md) — o testbed nao
// tem SLT, e o @serviceId so existiria se alguem publicasse aop/services, que
// nenhum modulo publica hoje. Sem valor inteiro conhecido, o campo e omitido
// (C.3.2.2), como no item de boundServices da C.6.8.3 respondido pela borda
// (infra/edgegateway/plugin/bindcontext.go). O serviceContextId segue a
// constante do core (mesma lacuna).
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

// Inteiro nao negativo, em numero ou em texto so de digitos (o JSON de
// aop/services nao tem esquema); qualquer outra coisa (o -1 inicial,
// undefined, null) -> sem valor.
function integerServiceId(raw: unknown): number | undefined {
	if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
	if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
	return undefined;
}


export default { GETCurrentService }
