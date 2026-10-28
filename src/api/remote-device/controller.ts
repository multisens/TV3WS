import { Request, Response } from 'express';
import service from './service';
import { returnError } from '../../util';
import { Device } from './types';
import { RegisterBody } from './schema';

async function POSTRemoteDevice(req: Request, res: Response): Promise<void> {
    const body = req.body as RegisterBody;
    const response = await service.createWebSocket(body, res.locals.clientId);
    res.status(200).json(response);
}

async function POSTRemoteDeviceUpdate(req: Request, res: Response): Promise<void> {
    const handle = req.params.handle;
    const body = req.body as RegisterBody;
    const updated = await service.updateWebSocket(handle, body);
    if (!updated) {
        returnError(res, 305, `handle ${handle}`);
        return;
    }
    res.status(200).json({ handle });
}

async function DELETERemoteDevice(req: Request, res: Response): Promise<void> {
    const handle = req.params.handle;
    const removed = await service.deleteWebSocket(handle);
    if (!removed) {
        returnError(res, 305, `handle ${handle}`);
        return;
    }
    res.status(200).json({});
}

// Responds the list of devices, or an empty object when there is none.
function sendDevices(res: Response, devices: Device[] | undefined): void {
    if (!devices || devices.length === 0) {
        res.status(200).json({});
        return;
    }
    res.status(200).json({
        devices: devices,
    });
}

// Responds the devices of the class, each one with the URL of its local
// entry point.
async function GETRemoteDevices(req: Request, res: Response): Promise<void> {
    const classId = req.params.classId;
    const devices = await service.getRemoteDevicesWithUrl(classId);
    sendDevices(res, devices);
}

export default { POSTRemoteDevice, POSTRemoteDeviceUpdate, DELETERemoteDevice, GETRemoteDevices };
