import core from "../../core";
import mqttClient, { TOPICS } from "../../mqtt-client";
import redis from "../../redis-client";
import { execOrThrow } from "../../util/redis-result";
import { ReqBody } from "../../api/multi-device/service";
import RemoteDevice, { AppNode } from "./remote-device";
import { WebSocketServer } from "ws";
import { CapabilitiesMetadata } from "./types";

// P5: os METADADOS do registro (handle, classe, tipos suportados) sao
// espelhados no armazenamento (remote-devices:index + remote-device:{h} +
// remote-devices:class:{c}) — observaveis por outros componentes. Os
// WebSockets vivos ficam necessariamente na memoria do processo; por isso
// o espelho e LIMPO no boot: apos reinicio nao ha socket sobrevivente, e
// entrada orfa mentiria sobre dispositivos conectados.
// D-0510-6 (reuniao 05/10 com o Joel): a gravacao do espelho deixou de ser
// promessa solta com .catch que so logava. Registro e remocao esperam o
// armazenamento; se ele falhar, nada muda (memoria e Redis ficam como
// estavam) e a API responde 404 {error:200}.
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

// Allows SEPE to request the capabilities of a device whenever it needs
function requestDeviceCapabilities(handle: string): CapabilitiesMetadata[] {
  const device = devices.get(handle);
  if (!device) throw new Error(`Device with handle ${handle} not found`);

  const deviceCapabilities = device.getCapabilities();

  const result = deviceCapabilities.map((capability) => {
    return {
      type: capability.effectType,
      capabilities: [
        { name: "state", value: capability.state },
        { name: "locator", value: capability.locator },
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
  removeRemoteDevice,
  getDevicesByClass,
  getDeviceByHandle,
  requestDeviceCapabilities,
};
