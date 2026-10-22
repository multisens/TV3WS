import { NextFunction, Request, Response } from 'express';
import { returnError } from '../../util';

export type ClientType = 'associated' | 'standAlone';

export type LocalClient = {
    clientId: string;
    clientType: ClientType;
};

const CLIENT_CLASS_HEADER = 'X-TV30-Client-Class';
const CLIENT_ID_HEADER = 'X-TV30-Client-Id';

// The associated local client is unique and has a fixed identity
// TODO: remove the local entry points of the associated client when its
// application ends, a signal the application lifecycle component will
// publish on the broker
export const ASSOCIATED_CLIENT_ID = 'associated';

// Stores in res.locals.client the class and the identity of the local
// client, set by the edge; responds error 107 if the request does not come
// from a local client
export function identifyLocalClient(req: Request, res: Response, next: NextFunction): void {
    const clientType = req.get(CLIENT_CLASS_HEADER);

    if (clientType === 'associated') {
        const client: LocalClient = { clientId: ASSOCIATED_CLIENT_ID, clientType };
        res.locals.client = client;
        next();
        return;
    }

    const clientId = req.get(CLIENT_ID_HEADER);
    if (clientType === 'standAlone' && clientId) {
        const client: LocalClient = { clientId, clientType };
        res.locals.client = client;
        next();
        return;
    }

    returnError(res, 107, 'not a local client');
}
