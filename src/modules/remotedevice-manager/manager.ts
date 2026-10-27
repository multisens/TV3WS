import core from "../../core";
import mqttClient, { TOPICS } from "../../mqtt-client";
import redis from "../../redis-client";
import { execOrThrow } from "../../util/redis-result";
import { ReqBody } from "../../api/remote-device/service";
import RemoteDevice, { AppNode } from "./remote-device";
import { WebSocketServer } from "ws";
import { CapabilitiesMetadata } from "./types";

// Os metadados do registro sao espelhados no Redis (remote-devices:index, remote-device:{h},
// remote-devices:class:{c}) para outros componentes. Os WebSockets so existem na memoria do processo,
// por isso o espelho e limpo no boot: entrada orfa mentiria sobre dispositivos conectados.
const devices = new Map<string, RemoteDevice>();
const devclasses = new Map<string, string[]>();

// Tarefa de boot (server.ts, no primeiro 'ready' do Redis).
export async function clearStoredRegistry(): Promise<void> {
    const handles = await redis.smembers('remote-devices:index');
    const keys = handles.map(h => `remote-device:${h}`);
    const classKeys = await redis.keys('remote-devices:class:*');
    const all = [...keys, ...classKeys, 'remote-devices:index'];
    if (all.length > 0) await redis.del(...all);
}

async function storeDevice(device: RemoteDevice): Promise<void> {
    const handle = device.getHandle();
    await execOrThrow(redis.multi()
        .sadd('remote-devices:index', handle)
        .sadd(`remote-devices:class:${device.getClass()}`, handle)
        .hset(`remote-device:${handle}`, {
            deviceClass: device.getClass(),
            supportedTypes: JSON.stringify(device.getSupportedTypes()),
            url: device.getUrl(),
        }));
}

// Moves the registry from the index of the previous class to the one of the
// current class and rewrites its record.
async function restoreDevice(device: RemoteDevice, previousClass: string): Promise<void> {
    const handle = device.getHandle();
    await execOrThrow(redis.multi()
        .srem(`remote-devices:class:${previousClass}`, handle)
        .sadd(`remote-devices:class:${device.getClass()}`, handle)
        .hset(`remote-device:${handle}`, {
            deviceClass: device.getClass(),
            supportedTypes: JSON.stringify(device.getSupportedTypes()),
            url: device.getUrl(),
        }));
}

async function unstoreDevice(handle: string, devclass: string): Promise<void> {
    await execOrThrow(redis.multi()
        .srem('remote-devices:index', handle)
        .srem(`remote-devices:class:${devclass}`, handle)
        .del(`remote-device:${handle}`));
}

function associateAppNodes() {
  let nodes: AppNode[] = core.app.nodes;
  nodes.forEach((node) => {
    if (devices.has(node.device)) {
      if (devices.get(node.device)?.support(node.mimeType)) {
        devices.get(node.device)?.setNode(node);
      }
    }
  });
}

function disassociateAppNodes() {
  devices.forEach((dev) => {
    dev.removeNode();
  });
}

// Armazenamento primeiro: se a gravacao falhar, o dispositivo nao entra na
// memoria, o WebSocketServer e fechado e o erro sobe.
async function addRemoteDevice(body: ReqBody, handle: string, wss: WebSocketServer): Promise<RemoteDevice> {
  let device = new RemoteDevice(body, handle, wss);
  try {
    await storeDevice(device);
  } catch (err) {
    device.terminate();
    throw err;
  }
  devices.set(handle, device);

  let devclass = device.getClass();
  if (devclasses.has(devclass)) {
    devclasses.get(devclass)?.push(device.getHandle());
  } else {
    devclasses.set(devclass, [device.getHandle()]);
  }

  mqttClient.publish(`${TOPICS.devices}/${devclass}`, JSON.stringify(devclasses.get(devclass)), true);

  return device;
}

// C.6.15.2: replaces the class and the supported types of the registry of
// the handle and moves it between the class indexes. The memory changes
// before the mirror; false if there is no registry with the handle.
async function updateRemoteDevice(handle: string, body: ReqBody): Promise<boolean> {
  const dev = devices.get(handle);
  if (!dev) {
    return false;
  }
  const previousClass = dev.getClass();
  dev.update(body);
  const currentClass = dev.getClass();
  if (currentClass !== previousClass) {
    const previousHandles = (devclasses.get(previousClass) ?? []).filter(h => h !== handle);
    devclasses.set(previousClass, previousHandles);
    devclasses.set(currentClass, [...(devclasses.get(currentClass) ?? []), handle]);
    mqttClient.publish(`${TOPICS.devices}/${previousClass}`, previousHandles.length > 0 ? JSON.stringify(previousHandles) : '', true);
    mqttClient.publish(`${TOPICS.devices}/${currentClass}`, JSON.stringify(devclasses.get(currentClass)), true);
  }
  await restoreDevice(dev, previousClass);
  return true;
}

// Armazenamento primeiro: se a remocao falhar, o dispositivo continua
// registrado e conectado, e o erro sobe.
async function removeRemoteDevice(handle: string): Promise<boolean> {
  const dev = devices.get(handle);
  if (!dev) return false;
  const devclass = dev.getClass();

  await unstoreDevice(handle, devclass);
  // outra remocao do mesmo handle (API e fechamento do socket) pode ter
  // concluido durante a espera
  if (devices.get(handle) !== dev) return true;

  devices.delete(handle);
  const handles = (devclasses.get(devclass) ?? []).filter(h => h !== handle);
  devclasses.set(devclass, handles);
  dev.terminate();
  console.log(`Client ${handle} unregistered.`);

  mqttClient.publish(`${TOPICS.devices}/${devclass}`, handles.length > 0 ? JSON.stringify(handles) : '', true);
  return true;
}

function getDevicesByClass(classId: string): RemoteDevice[] {
  if (!devclasses.has(classId)) return [];

  let handles = devclasses.get(classId);
  if (!handles) return [];

  let result: RemoteDevice[] = [];
  handles.forEach((handle) => {
    if (devices.has(handle)) {
      result.push(devices.get(handle)!);
    }
  });

  return result;
}

function getDeviceByHandle(handle: string): RemoteDevice | undefined {
  if (!devices.has(handle)) return undefined;
  return devices.get(handle);
}

function requestDeviceCapabilities(handle: string): CapabilitiesMetadata[] {
  const device = devices.get(handle);
  if (!device) throw new Error(`Device with handle ${handle} not found`);

  const deviceCapabilities = device.getCapabilities();

  const result = deviceCapabilities.map((capability) => {
    return {
      type: capability.effectType,
      capabilities: [
        { name: "state", value: capability.state },
        { name: "location", value: capability.location },
        {
          name: "preparationTime",
          value: capability.preparationTime,
        },
      ],
    };
  });

  return result as CapabilitiesMetadata[];
}

export {
  associateAppNodes,
  disassociateAppNodes,
  addRemoteDevice,
  updateRemoteDevice,
  removeRemoteDevice,
  getDevicesByClass,
  getDeviceByHandle,
  requestDeviceCapabilities,
};
