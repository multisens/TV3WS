import { NextFunction, Request, Response } from 'express';
import { returnError } from '../../util';
import { currentAssociatedId } from '../associated-app';

// Class and identity of the client, written by the edge.
export const CLIENT_CLASS_HEADER = 'X-TV30-Client-Class';
export const CLIENT_ID_HEADER = 'X-TV30-Client-Id';

// Identity of the client of the request: for the associated one, the
// running application; for the others, the clientid written by the edge;
// undefined when there is none.
export function requestClientId(req: Request): string | undefined {
    if (req.get(CLIENT_CLASS_HEADER) === 'associated') {
        return currentAssociatedId();
    }
    return req.get(CLIENT_ID_HEADER) || undefined;
}

// Stores the identity of the client in res.locals.clientId; responds error
// 107 when the request has none.
export function requireClientId(req: Request, res: Response, next: NextFunction): void {
    const clientId = requestClientId(req);
    if (clientId === undefined) {
        returnError(res, 107, 'client not identified');
        return;
    }
    res.locals.clientId = clientId;
    next();
}
