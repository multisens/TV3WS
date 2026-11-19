import { Request, Response } from 'express';
import { appContextIdOf, currentServiceId } from '../../../modules/broadcast-signaling';
import { returnError } from '../../../util';
import service from './service';

// ABNT NBR 25608, C.6.4.7, Table C.17. Without a tuned service, 300. An
// appId outside the BALD of the tuned service, a path outside the
// filesystem of the application, or a file not received, 305. path is
// optional: omitted or empty, the listing of the base; a directory also
// answers the listing.
async function GETAppFile(req: Request, res: Response): Promise<void> {
    if (currentServiceId() === undefined) {
        returnError(res, 300);
        return;
    }
    const appId = String(req.params.appid);
    const appContextId = appContextIdOf(appId);
    if (appContextId === undefined) {
        returnError(res, 305, `appid ${appId}`);
        return;
    }
    const requested = req.query.path ?? '';
    if (typeof requested !== 'string') {
        returnError(res, 305, 'path');
        return;
    }

    const tree = await service.contextTree(appContextId);
    const entry = service.resolvePath(tree, requested);
    if (entry === undefined) {
        returnError(res, 305, `path ${requested}`);
        return;
    }
    if (entry.kind === 'dir') {
        res.status(200).json(entry.listing);
        return;
    }
    const file = await service.readFile(appContextId, entry.location, req.get('Range'));
    if (file === undefined) {
        returnError(res, 305, `path ${requested} not received`);
        return;
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', file.body.length);
    if (file.contentRange !== undefined) {
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Range', file.contentRange);
    }
    res.status(file.status).end(file.body);
}

export default { GETAppFile };
