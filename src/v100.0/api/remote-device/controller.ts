import { Request, Response } from 'express';
import { RegisterBody } from './schema';
import service from './service';

function registerDevice(req: Request, res: Response): void {
    const body = req.body as RegisterBody;
    const response = service.registerDevice(body, res.locals.clientId);
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

function listDevices(req: Request, res: Response): void {
    res.status(200).json(service.listDevices(req.params.classId, res.locals.client));
}

export default { registerDevice, updateDevice, removeDevice, listDevices };
