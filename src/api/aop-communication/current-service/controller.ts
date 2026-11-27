import { Request, Response } from 'express';
import { returnError } from '../../../util';
import { readCurrentService } from './service';

// ABNT NBR 25608, C.6.3.1, Table C.8. The service in use is the one of the
// session; without one, 300. Error 302 is not emitted.
async function GETCurrentService(req: Request, res: Response): Promise<void> {
    const service = await readCurrentService();
    if (service === undefined) {
        returnError(res, 300);
        return;
    }
    res.status(200).json(service);
}

export default { GETCurrentService };
