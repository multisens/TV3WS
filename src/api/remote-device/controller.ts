import { Request, Response } from "express";
import service from "./service";
import { returnError } from "../../util";
import { Device } from "./types";

async function POSTRemoteDevice(req: Request, res: Response): Promise<void> {
    const body = req.body;
    if (!body) {
        returnError(res, 105, "request body");
        return;
    }
    const missing: string[] = [];
    if (!body.deviceClass) {
        missing.push("deviceClass");
    }
    if (!body.supportedTypes) {
        missing.push("supportedTypes");
    } else if (body.supportedTypes.length === 0) {
        missing.push("supportedTypes is empty");
    }

    if (missing.length > 0) {
        returnError(res, 105, missing.join(", "));
        return;
    }
    const response = await service.createWebSocket(body);
    res.status(200).json(response);
}

async function DELETERemoteDevice(req: Request, res: Response): Promise<void> {
    const handle = req.params.handle;
    const removed = await service.deleteWebSocket(handle);
    if (!removed) {
        returnError(res, 101, `handle ${handle} does not exist`);
        return;
    }
    res.status(204).json({});
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

export default { POSTRemoteDevice, DELETERemoteDevice, GETRemoteDevices };
