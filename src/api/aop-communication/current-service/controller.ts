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

// C.6.3.1 (Table C.8). The service in use is the last value of
// aop/currentService; empty or never received gives 300. A serviceId without
// a known integer value is omitted (C.3.2.2).
// TODO: error 302 is not emitted (C.6.3.1).
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
