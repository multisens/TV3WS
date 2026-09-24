import { Request, Response } from "express";
import service from "./service";
import { returnError } from "../../util";

function POSTRemoteDevice(req: Request, res: Response): void {
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
  const response = service.createWebSocket(body);
  res.status(200).json(response);
}

function DELETERemoteDevice(req: Request, res: Response): void {
  const handle = req.params.handle;
  if (!handle) {
    returnError(res, 105, "handle");
    return;
  }
  if (!service.deleteWebSocket(handle)) {
    returnError(res, 101, `handle ${handle} does not exist`);
    return;
  }
  res.status(204).json({});
}

function GETRemoteDevices(req: Request, res: Response): void {
  const classId = req.params["classId"];
  if (!classId) {
    returnError(res, 105, "classId");
    return;
  }
  const devices = service.getRemoteDevices(classId);
  if (!devices || devices.length === 0) {
    res.status(200).json({});
    return;
  }
  res.status(200).json({
    devices: devices,
  });
}

function GETRemoteDeviceEntryPoint(req: Request, res: Response): void {
  const handle = req.params.handle;
  if (!handle) {
    returnError(res, 105, "handle");
    return;
  }

  const device = service.getRemoteDevice(handle);
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

export default { POSTRemoteDevice, DELETERemoteDevice, GETRemoteDevices, GETRemoteDeviceEntryPoint, DELETERemoteDeviceEntryPoint };
