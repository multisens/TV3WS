import { v4 as uuidv4 } from "uuid";
import * as manager from "../../modules/remotedevice-manager/manager";
import { closeEntryPoint, openEntryPoint } from "../../modules/remotedevice-manager/entry-point";
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

// A porta e aberta ANTES do registro (entry-point.ts): a URL gravada e
// devolvida e a da porta que de fato escuta, e porta ocupada vira nova
// tentativa em vez de derrubar o processo. Se o armazenamento falhar
// (D-0510-6), o addRemoteDevice chama o terminate() do dispositivo, que fecha
// o servidor: a API responde 404 {error:200} e nao fica porta aberta sem
// dispositivo.
async function createWebSocket(body: ReqBody): Promise<Response> {
  const wsServer = await openEntryPoint();
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

// Garante um ponto de entrada local para o dispositivo e devolve a URL.
// Reusa o existente — a listagem 2.0 pode ser chamada varias vezes. Abrir a
// porta agora e assincrono (entry-point.ts); pedidos simultaneos para o mesmo
// dispositivo esperam a mesma abertura, em vez de abrir dois servidores e
// deixar um escutando sem dono.
const pendingLocalEntryPoints = new Map<string, Promise<string>>();

function ensureLocalEntryPoint(device: RemoteDevice): Promise<string> {
  const existing = device.getLocalEntryPointUrl();
  if (existing) return Promise.resolve(existing);

  const handle = device.getHandle();
  let pending = pendingLocalEntryPoints.get(handle);
  if (!pending) {
    pending = (async () => {
      const wsServer = await openEntryPoint();
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

// Versao 2.1 (proposta em discussao no Forum): lista so handles; o ponto de
// entrada vem depois, por GET /device/{handle}.
function getRemoteDevices(classId: string): Device[] | undefined {
  const devices = manager.getDevicesByClass(classId);
  if (!devices) return undefined;

  return devices.map((device) => ({
    handle: device.getHandle(),
    supportedTypes: device.getSupportedTypes()
  }));
}

// Versao 2.0 (norma, C.6.15.5): a listagem por classe ja entrega o ponto de
// entrada de cada dispositivo no campo url — nao existem rotas por handle.
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
