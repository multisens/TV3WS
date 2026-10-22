import { Request, Response } from 'express';
import { LocalClient } from '../../util/client';
import service from './service';

// Class-dependent query parameters; only the ones with a single text value
function queryParams(req: Request): Record<string, string> {
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.query)) {
        if (typeof value === 'string') {
            params[name] = value;
        }
    }
    return params;
}

function registerListener(req: Request, res: Response): void {
    const client = res.locals.client as LocalClient;
    const response = service.registerListener(req.params.className, client.clientId, queryParams(req));
    res.status(200).json(response);
}

function removeListener(req: Request, res: Response): void {
    service.removeListener(req.params.handle);
    res.status(200).json({});
}

export default { registerListener, removeListener };
