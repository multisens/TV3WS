import http from "http";
import { v4 as uuidv4 } from "uuid";
import { WebSocketServer } from "ws";
import * as manager from "../../modules/remotedevice-manager/manager";
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

function createWebSocket(body: ReqBody): Response {
  const server = http.createServer();
  const wsServer = new WebSocketServer({ server });
  const port = generateDynamicallyPort();
  const uuid = uuidv4();

  server.listen(port, () => {
    console.log(`WebSocket server is running on port ${port}`);
  });
  wsServer.options.port = port;

  const device = manager.addRemoteDevice(body, uuid, wsServer);
  console.log(`Client ${device.getHandle()} registered.`);

  return {
    handle: device.getHandle(),
    url: device.getUrl(),
  };
}

function generateDynamicallyPort(): number {
  const min = parseInt(process.env.WS_PORT_MIN || '1000');
  const max = parseInt(process.env.WS_PORT_MAX || '9999');
  return Math.floor(min + Math.random() * (max - min));
}

function deleteWebSocket(handle: string): boolean {
  return manager.removeRemoteDevice(handle);
}

// Garante um ponto de entrada local para o dispositivo e devolve a URL.
// Reusa o existente — a listagem 2.0 pode ser chamada varias vezes.
function ensureLocalEntryPoint(device: ReturnType<typeof manager.getDeviceByHandle> & {}): string {
  const existing = device.getLocalEntryPointUrl();
  if (existing) return existing;

  const server = http.createServer();
  const wsServer = new WebSocketServer({ server });
  const port = generateDynamicallyPort();

  server.listen(port, () => {
    console.log(`WebSocket server is running on port ${port}`);
  });
  wsServer.options.port = port;

  device.addLocalEntryPoint(wsServer);
  return device.getLocalEntryPointUrl();
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
function getRemoteDevicesWithUrl(classId: string): Device[] | undefined {
  const devices = manager.getDevicesByClass(classId);
  if (!devices) return undefined;

  return devices.map((device) => ({
    handle: device.getHandle(),
    supportedTypes: device.getSupportedTypes(),
    url: ensureLocalEntryPoint(device),
  }));
}

function getRemoteDevice(handle: string): DeviceResponse | undefined {
  const device = manager.getDeviceByHandle(handle);
  if (!device) return undefined;

  return {
    url: ensureLocalEntryPoint(device),
  };
}

function removeLocalEntryPoint(handle: string): boolean {
  const device = manager.getDeviceByHandle(handle);
  if (!device) return false;

  device.removeLocalEntryPoint();
  return true;
}

export default { createWebSocket, deleteWebSocket, getRemoteDevices, getRemoteDevicesWithUrl, getRemoteDevice, removeLocalEntryPoint };
