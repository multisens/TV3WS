import { Request, Response } from 'express';
import { returnError } from '../../../util';
import { RegisterBody } from './schema';
import service from './service';

function registerDevice(req: Request, res: Response): void {
    const body = req.body as RegisterBody;
    const response = service.registerDevice(body);
    res.status(200).json(response);
}

function updateDevice(req: Request, res: Response): void {
    const body = req.body as RegisterBody;
    const response = service.updateDevice(req.params.handle, body);
    res.status(200).json(response);
}

function removeDevice(req: Request, res: Response): void {
    service.removeDevice(req.params.handle);
    res.status(200).json({});
}

async function listDevices(req: Request, res: Response): Promise<void> {
    returnError(res, 200, 'not implemented');
}

export default { registerDevice, updateDevice, removeDevice, listDevices };
