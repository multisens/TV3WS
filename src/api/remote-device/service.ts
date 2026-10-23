import { v4 as uuidv4 } from "uuid";
import * as manager from "../../modules/remotedevice-manager/manager";
import { closeEntryPoint, openLocalEntryPoint, openRemoteDeviceEntryPoint } from "../../modules/remotedevice-manager/entry-point";
import { ApiError } from "../../util";
import { Device } from "./types";

export type ReqBody = {
  deviceClass: string;
  supportedTypes: string[];
};

export type Response = {
  handle: string;
  url?: string;
};

export type DeviceResponse = {
  url: string;
};

type RemoteDevice = ReturnType<typeof manager.getDeviceByHandle> & {};

// A porta abre antes do registro: a URL gravada e a da porta que de fato escuta. Se o armazenamento
// falhar, addRemoteDevice fecha o servidor: nao fica porta aberta sem dispositivo.
async function createWebSocket(body: ReqBody): Promise<Response> {
  const wsServer = await openRemoteDeviceEntryPoint();
  const uuid = uuidv4();

  const device = await manager.addRemoteDevice(body, uuid, wsServer);
  console.log(`Client ${device.getHandle()} registered.`);

  return {
    handle: device.getHandle(),
    url: device.getUrl(),
  };
}

function deleteWebSocket(handle: string): Promise<boolean> {
  return manager.removeRemoteDevice(handle);
}

// Reusa o ponto de entrada existente (a listagem 2.0 pode vir varias vezes); pedidos simultaneos esperam a
// mesma abertura, em vez de abrir dois servidores e deixar um sem dono.
const pendingLocalEntryPoints = new Map<string, Promise<string>>();

function ensureLocalEntryPoint(device: RemoteDevice): Promise<string> {
  const existing = device.getLocalEntryPointUrl();
  if (existing) return Promise.resolve(existing);

  const handle = device.getHandle();
  let pending = pendingLocalEntryPoints.get(handle);
  if (!pending) {
    pending = (async () => {
      const wsServer = await openLocalEntryPoint();
      // descadastrado durante a abertura: fecha o servidor recem-aberto
      if (manager.getDeviceByHandle(handle) !== device) {
        closeEntryPoint(wsServer);
        throw new ApiError(101, `handle ${handle} does not exist`);
      }
      device.addLocalEntryPoint(wsServer);
      return device.getLocalEntryPointUrl();
    })().finally(() => pendingLocalEntryPoints.delete(handle));
    pendingLocalEntryPoints.set(handle, pending);
  }
  return pending;
}

// versao 100.0: so handles; a url vem por GET /device/{handle}
function getRemoteDevices(classId: string): Device[] | undefined {
  const devices = manager.getDevicesByClass(classId);
  if (!devices) return undefined;

  return devices.map((device) => ({
    handle: device.getHandle(),
    supportedTypes: device.getSupportedTypes()
  }));
}

// versao 2.0 (C.6.15.5): a listagem ja traz a url de cada dispositivo
async function getRemoteDevicesWithUrl(classId: string): Promise<Device[] | undefined> {
  const devices = manager.getDevicesByClass(classId);
  if (!devices) return undefined;

  return Promise.all(devices.map(async (device) => ({
    handle: device.getHandle(),
    supportedTypes: device.getSupportedTypes(),
    url: await ensureLocalEntryPoint(device),
  })));
}

async function getRemoteDevice(handle: string): Promise<DeviceResponse | undefined> {
  const device = manager.getDeviceByHandle(handle);
  if (!device) return undefined;

  return {
    url: await ensureLocalEntryPoint(device),
  };
}

function removeLocalEntryPoint(handle: string): boolean {
  const device = manager.getDeviceByHandle(handle);
  if (!device) return false;

  device.removeLocalEntryPoint();
  return true;
}

export default { createWebSocket, deleteWebSocket, getRemoteDevices, getRemoteDevicesWithUrl, getRemoteDevice, removeLocalEntryPoint };
