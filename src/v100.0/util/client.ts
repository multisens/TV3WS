import { NextFunction, Request, Response } from 'express';
import { returnError } from '../../util';
import { currentAssociatedId } from '../../modules/associated-app';

export type ClientType = 'associated' | 'standAlone';

export type LocalClient = {
    clientId: string;
    clientType: ClientType;
};

const CLIENT_CLASS_HEADER = 'X-TV30-Client-Class';
const CLIENT_ID_HEADER = 'X-TV30-Client-Id';

// Stores in res.locals.client the class and the identity of the local
// client: for the associated one, the running application; for the
// stand-alone one, the clientid set by the edge. Responds error 107 if the
// request does not come from a local client or no associated application
// is running
export function identifyLocalClient(req: Request, res: Response, next: NextFunction): void {
    const clientType = req.get(CLIENT_CLASS_HEADER);

    if (clientType === 'associated') {
        const clientId = currentAssociatedId();
        if (clientId === undefined) {
            returnError(res, 107, 'no associated application running');
            return;
        }
        const client: LocalClient = { clientId, clientType };
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
