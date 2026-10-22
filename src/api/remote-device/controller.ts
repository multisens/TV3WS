import { Request, Response } from "express";
import service from "./service";
import { returnError } from "../../util";

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

// abrir o ponto de entrada e assincrono: porta ocupada -> outra porta; esgotadas, 404 {error:200}
async function GETRemoteDevices(req: Request, res: Response): Promise<void> {
  const classId = req.params["classId"];
  if (!classId) {
    returnError(res, 105, "classId");
    return;
  }
  // 2.0: a listagem ja traz a url. 100.0: so handles; a url vem por GET /device/{handle}.
  const devices = res.locals.apiVersion === '100.0'
    ? service.getRemoteDevices(classId)
    : await service.getRemoteDevicesWithUrl(classId);
  if (!devices || devices.length === 0) {
    res.status(200).json({});
    return;
  }
  res.status(200).json({
    devices: devices,
  });
}

// Rotas por handle: extensao do testbed, fora da Tabela C.2, so na versao 100.0. A borda ja responde 100
// nas outras versoes; esta conferencia e para quem chega sem passar por ela.
function handleRoutesAreV100(req: Request, res: Response): boolean {
  if (res.locals.apiVersion !== '100.0') {
    returnError(res, 100, `${req.method} ${req.originalUrl} exists only with Accept-Version: 100.0`);
    return false;
  }
  return true;
}

async function GETRemoteDeviceEntryPoint(req: Request, res: Response): Promise<void> {
  if (!handleRoutesAreV100(req, res)) return;

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
  if (!handleRoutesAreV100(req, res)) return;

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
