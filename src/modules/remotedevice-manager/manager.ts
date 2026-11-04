import { WebSocketServer } from 'ws';
import core from '../../core';
import logger from '../../logger';
import mqttClient, { TOPICS } from '../../mqtt-client';
import redis from '../../redis-client';
import { execOrThrow } from '../../util/redis-result';
import { ReqBody } from '../../api/remote-device/service';
import { onAssociatedEnded } from '../associated-app';
import { onClientBlocked } from '../client-revocation';
import RemoteDevice, { AppNode } from './remote-device';
import { CapabilitiesMetadata } from './types';

// The registry metadata is mirrored in Redis (remote-devices:index,
// remote-device:{handle}, remote-devices:class:{class}). The WebSockets exist
// only in the memory of the process, so the mirror is cleared on boot.
const INDEX_KEY = 'remote-devices:index';

const devices = new Map<string, RemoteDevice>();
const handlesByClass = new Map<string, string[]>();

// Boot task (server.ts, on the first 'ready' of Redis).
export async function clearStoredRegistry(): Promise<void> {
    const handles = await redis.smembers(INDEX_KEY);
    const keys = handles.map(deviceKey);
    const classKeys = await redis.keys(classKey('*'));
    const all = [...keys, ...classKeys, INDEX_KEY];
    if (all.length > 0) {
        await redis.del(...all);
    }
}

// Associates each node of the current application to the device it names,
// if the device supports its type.
export function associateAppNodes(): void {
    const nodes: AppNode[] = core.app.nodes;
    for (const node of nodes) {
        const device = devices.get(node.device);
        if (device?.support(node.mimeType)) {
            device.setNode(node);
        }
    }
}

export function disassociateAppNodes(): void {
    for (const device of devices.values()) {
        device.removeNode();
    }
}

// Storage first: if the write fails, the device does not enter the memory,
// the WebSocketServer is closed and the error goes up.
export async function addRemoteDevice(body: ReqBody, handle: string, wss: WebSocketServer, registeredBy: string): Promise<RemoteDevice> {
    const device = new RemoteDevice(body, handle, wss, registeredBy);
    try {
        await storeDevice(device);
    } catch (err) {
        device.terminate();
        throw err;
    }
    devices.set(handle, device);

    const deviceClass = device.getClass();
    const handles = [...(handlesByClass.get(deviceClass) ?? []), handle];
    handlesByClass.set(deviceClass, handles);
    publishClass(deviceClass);
    return device;
}

// C.6.15.2: replaces the class and the supported types of the registry of
// the handle and moves it between the class indexes. The memory changes
// before the mirror; false if there is no registry with the handle.
export async function updateRemoteDevice(handle: string, body: ReqBody): Promise<boolean> {
    const device = devices.get(handle);
    if (!device) {
        return false;
    }
    const previousClass = device.getClass();
    device.update(body);
    const currentClass = device.getClass();
    if (currentClass !== previousClass) {
        handlesByClass.set(previousClass, (handlesByClass.get(previousClass) ?? []).filter(h => h !== handle));
        handlesByClass.set(currentClass, [...(handlesByClass.get(currentClass) ?? []), handle]);
        publishClass(previousClass);
        publishClass(currentClass);
    }
    await restoreDevice(device, previousClass);
    return true;
}

// Storage first: if the removal fails, the device stays registered and
// connected, and the error goes up.
export async function removeRemoteDevice(handle: string): Promise<boolean> {
    const device = devices.get(handle);
    if (!device) {
        return false;
    }
    const deviceClass = device.getClass();

    await unstoreDevice(handle, deviceClass);
    // Another removal of the same handle (API and closing of the socket) may
    // have finished during the wait.
    if (devices.get(handle) !== device) {
        return true;
    }

    devices.delete(handle);
    handlesByClass.set(deviceClass, (handlesByClass.get(deviceClass) ?? []).filter(h => h !== handle));
    device.terminate();
    logger.info(`Remote device ${handle} unregistered.`);
    publishClass(deviceClass);
    return true;
}

// C.4.4: removes the registrations made by the client.
export async function releaseClient(clientId: string): Promise<void> {
    const handles = [...devices.values()]
        .filter(device => device.registeredBy === clientId)
        .map(device => device.getHandle());
    for (const handle of handles) {
        await removeRemoteDevice(handle);
    }
}

export function getDevicesByClass(classId: string): RemoteDevice[] {
    const handles = handlesByClass.get(classId) ?? [];
    const result: RemoteDevice[] = [];
    for (const handle of handles) {
        const device = devices.get(handle);
        if (device) {
            result.push(device);
        }
    }
    return result;
}

export function getDeviceByHandle(handle: string): RemoteDevice | undefined {
    return devices.get(handle);
}

// Capabilities of the device of the handle in the format of the
// capabilities message; throws if there is no such device.
export function requestDeviceCapabilities(handle: string): CapabilitiesMetadata[] {
    const device = devices.get(handle);
    if (!device) {
        throw new Error(`Device with handle ${handle} not found`);
    }
    const result = device.getCapabilities().map((capability) => ({
        type: capability.effectType,
        capabilities: [
            { name: 'state', value: capability.state },
            { name: 'location', value: capability.location },
            { name: 'preparationTime', value: capability.preparationTime },
        ],
    }));
    return result as CapabilitiesMetadata[];
}

async function storeDevice(device: RemoteDevice): Promise<void> {
    const handle = device.getHandle();
    await execOrThrow(redis.multi()
        .sadd(INDEX_KEY, handle)
        .sadd(classKey(device.getClass()), handle)
        .hset(deviceKey(handle), deviceRecord(device)));
}

// Moves the registry from the index of the previous class to the one of the
// current class and rewrites its record.
async function restoreDevice(device: RemoteDevice, previousClass: string): Promise<void> {
    const handle = device.getHandle();
    await execOrThrow(redis.multi()
        .srem(classKey(previousClass), handle)
        .sadd(classKey(device.getClass()), handle)
        .hset(deviceKey(handle), deviceRecord(device)));
}

async function unstoreDevice(handle: string, deviceClass: string): Promise<void> {
    await execOrThrow(redis.multi()
        .srem(INDEX_KEY, handle)
        .srem(classKey(deviceClass), handle)
        .del(deviceKey(handle)));
}

// Retained list of the handles of the class; empty when there is none.
function publishClass(deviceClass: string): void {
    const handles = handlesByClass.get(deviceClass) ?? [];
    const payload = handles.length > 0 ? JSON.stringify(handles) : '';
    mqttClient.publish(`${TOPICS.devices}/${deviceClass}`, payload, true);
}

function deviceRecord(device: RemoteDevice): Record<string, string> {
    return {
        deviceClass: device.getClass(),
        supportedTypes: JSON.stringify(device.getSupportedTypes()),
        url: device.getUrl(),
        registeredBy: device.registeredBy,
    };
}

function deviceKey(handle: string): string {
    return `remote-device:${handle}`;
}

function classKey(deviceClass: string): string {
    return `remote-devices:class:${deviceClass}`;
}

// Without an API to answer, a storage failure of the release goes to the
// log.
function releaseClientLogged(clientId: string): void {
    releaseClient(clientId).catch((err: Error) => {
        logger.error(`[remote-devices] release of the client ${clientId} failed: ${err.message}`);
    });
}

onAssociatedEnded(releaseClientLogged);
onClientBlocked(releaseClientLogged);
