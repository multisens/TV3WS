import { v4 as uuidv4 } from 'uuid';
import * as manager from '../../modules/remotedevice-manager/manager';
import { closeEntryPoint, openLocalEntryPoint, openRemoteDeviceEntryPoint } from '../../modules/remotedevice-manager/entry-point';
import { ApiError } from '../../util';
import logger from '../../logger';
import { Device } from './types';
import { RegisterBody } from './schema';

export type ReqBody = RegisterBody;

export type Response = {
    handle: string;
    url: string;
};

type RemoteDevice = NonNullable<ReturnType<typeof manager.getDeviceByHandle>>;

// Opening of the local entry point of each device, shared by simultaneous
// requests for the same device.
const pendingLocalEntryPoints = new Map<string, Promise<string>>();

// Opens the entry point of the device and then registers it, with the URL
// of the port that is listening.
async function createWebSocket(body: ReqBody): Promise<Response> {
    const wsServer = await openRemoteDeviceEntryPoint();
    const uuid = uuidv4();

    const device = await manager.addRemoteDevice(body, uuid, wsServer);
    logger.info(`Remote device ${device.getHandle()} registered.`);

    return {
        handle: device.getHandle(),
        url: device.getUrl(),
    };
}

// C.6.15.2: replaces the class and the supported types of the registry of
// the handle; false if there is none.
function updateWebSocket(handle: string, body: ReqBody): Promise<boolean> {
    return manager.updateRemoteDevice(handle, body);
}

function deleteWebSocket(handle: string): Promise<boolean> {
    return manager.removeRemoteDevice(handle);
}

// Returns the URL of the local entry point of the device, opening it when
// it does not exist; simultaneous requests wait for the same opening.
function ensureLocalEntryPoint(device: RemoteDevice): Promise<string> {
    const existing = device.getLocalEntryPointUrl();
    if (existing) {
        return Promise.resolve(existing);
    }

    const handle = device.getHandle();
    let pending = pendingLocalEntryPoints.get(handle);
    if (!pending) {
        pending = openLocalEntryPointFor(device)
            .finally(() => pendingLocalEntryPoints.delete(handle));
        pendingLocalEntryPoints.set(handle, pending);
    }
    return pending;
}

// Opens a local entry point for the device; if the device was deregistered
// during the opening, closes the new server and throws error 101.
async function openLocalEntryPointFor(device: RemoteDevice): Promise<string> {
    const handle = device.getHandle();
    const wsServer = await openLocalEntryPoint();
    if (manager.getDeviceByHandle(handle) !== device) {
        closeEntryPoint(wsServer);
        throw new ApiError(101, `handle ${handle} does not exist`);
    }
    device.addLocalEntryPoint(wsServer);
    return device.getLocalEntryPointUrl();
}

// C.6.15.5: the devices of the class, each one with the URL of its local
// entry point.
async function getRemoteDevicesWithUrl(classId: string): Promise<Device[] | undefined> {
    const devices = manager.getDevicesByClass(classId);
    if (!devices) {
        return undefined;
    }

    return Promise.all(devices.map(async (device) => ({
        handle: device.getHandle(),
        supportedTypes: device.getSupportedTypes(),
        url: await ensureLocalEntryPoint(device),
    })));
}

export default { createWebSocket, updateWebSocket, deleteWebSocket, getRemoteDevicesWithUrl };
