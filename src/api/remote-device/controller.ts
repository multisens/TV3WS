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
  let missing: string[] = [];
  if (!body.deviceClass) {
    missing.push("deviceClass");
  }
  if (!body.supportedTypes) {
    missing.push("supportedTypes");
  } else if (body.supportedTypes.length == 0) {
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
  if (!handle) {
    returnError(res, 105, "handle");
    return;
  }
  if (!(await service.deleteWebSocket(handle))) {
    returnError(res, 101, `handle ${handle} does not exist`);
    return;
  }
  res.status(204).json({});
}

function sendDevices(res: Response, devices: Device[] | undefined): void {
  if (!devices || devices.length === 0) {
    res.status(200).json({});
    return;
  }
  res.status(200).json({
    devices: devices,
  });
}

// 2.0: a listagem ja traz a url. Abrir o ponto de entrada e assincrono: porta ocupada -> outra porta;
// esgotadas, 404 {error:200}
async function GETRemoteDevices(req: Request, res: Response): Promise<void> {
  const classId = req.params["classId"];
  if (!classId) {
    returnError(res, 105, "classId");
    return;
  }
  sendDevices(res, await service.getRemoteDevicesWithUrl(classId));
}

// 100.0: so handles; a url vem por GET /device/{handle}
function GETRemoteDeviceHandles(req: Request, res: Response): void {
  const classId = req.params["classId"];
  if (!classId) {
    returnError(res, 105, "classId");
    return;
  }
  sendDevices(res, service.getRemoteDevices(classId));
}

async function GETRemoteDeviceEntryPoint(req: Request, res: Response): Promise<void> {
  const handle = req.params.handle;
  if (!handle) {
    returnError(res, 105, "handle");
    return;
  }

  const device = await service.getRemoteDevice(handle);
  if (!device) {
    returnError(res, 101, `handle ${handle} does not exist`);
    return;
  }
  res.status(200).json(device);
}

function DELETERemoteDeviceEntryPoint(req: Request, res: Response): void {
  const handle = req.params.handle;
  if (!handle) {
    returnError(res, 105, "handle");
    return;
  }
  if (!service.removeLocalEntryPoint(handle)) {
    returnError(res, 101, `handle ${handle} does not exist`);
    return;
  }
  res.status(204).json({});
}

export default { POSTRemoteDevice, DELETERemoteDevice, GETRemoteDevices, GETRemoteDeviceHandles, GETRemoteDeviceEntryPoint, DELETERemoteDeviceEntryPoint };
