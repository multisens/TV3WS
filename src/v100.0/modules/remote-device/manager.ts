import { generateToken } from '../../util/token';
import { ClientType } from '../../util/client';
import { RawData, WebSocket } from 'ws';
import {
    CLOSE_DEVICE_BUSY, CLOSE_DEVICE_UNAVAILABLE, CLOSE_PREEMPTED, sendAndClose,
} from './messages';
import { listeners } from '../notifications/listeners';
import { projectRegistry } from './projection';
import Registry from './registry';

// Entry point identified by a token in the URL path: the one of the device
// (C.6.15.2) or the local one of a local client for the device (C.6.15.5)
export type EntryPoint =
    | { kind: 'device'; registry: Registry }
    | { kind: 'local'; registry: Registry; clientId: string; clientType: ClientType };

export type LocalEntryPoint = Extract<EntryPoint, { kind: 'local' }>;

export enum EventType {
    AVAILABLE = 'available',
    UNAVAILABLE = 'unavailable',
    PAIR_FORMED = 'pairFormed',
    PAIR_ENDED = 'pairEnded'
};

// C.6.15.6, Table C.87
export const REMOTE_DEVICE_EVENT_CLASS = 'remote-device';

export type RemoteDeviceEvent = {
    eventType: EventType;
    classId: string;
    deviceId: string;
    sequence: number;
};

listeners.defineEventClass(REMOTE_DEVICE_EVENT_CLASS);

class RegistryManager {
    protected registryByHandle = new Map<string, Registry>();
    protected entryPointByToken = new Map<string, EntryPoint>();
    protected registryByClass = new Map<string, Set<Registry>>();
    protected sequenceByClass = new Map<string, number>();

    public addRegistry(deviceClass: string, supportedTypes: string[]): Registry {
        const registry = new Registry(deviceClass, supportedTypes);
        this.registryByHandle.set(registry.handle, registry);
        this.entryPointByToken.set(registry.token, { kind: 'device', registry });
        this.addToClass(registry);
        this.project(registry.handle);
        return registry;
    }

    // Returns false if there is no registry with the handle
    public updateRegistry(handle: string, deviceClass: string, supportedTypes: string[]): boolean {
        const registry = this.registryByHandle.get(handle);
        if (!registry) {
            return false;
        }
        const classChanged = registry.getDeviceClass() !== deviceClass;
        if (classChanged && registry.isConnected()) {
            this.endPairByUnavailability(registry);
            this.notify(EventType.UNAVAILABLE, registry);
        }
        this.removeFromClass(registry);
        registry.update(deviceClass, supportedTypes);
        this.addToClass(registry);
        if (classChanged && registry.isConnected()) {
            this.notify(EventType.AVAILABLE, registry);
        }
        this.project(handle);
        return true;
    }

    // Removes the registry and its entry points, device and local, from every
    // map and closes the connection of the device. Returns false if there is
    // no registry with the handle
    public removeRegistry(handle: string): boolean {
        const registry = this.registryByHandle.get(handle);
        if (!registry) {
            return false;
        }
        if (registry.isConnected()) {
            this.endPairByUnavailability(registry);
            this.notify(EventType.UNAVAILABLE, registry);
        }
        this.registryByHandle.delete(handle);
        this.entryPointByToken.delete(registry.token);
        for (const token of registry.getLocalTokens()) {
            this.entryPointByToken.delete(token);
        }
        this.removeFromClass(registry);
        registry.close();
        this.project(handle);
        return true;
    }

    // Figure C.7: the device connects to its entry point; a connection that
    // replaces another keeps the device available
    public connect(registry: Registry, ws: WebSocket): void {
        const becameAvailable = registry.connect(ws);
        if (becameAvailable) {
            this.notify(EventType.AVAILABLE, registry);
            this.project(registry.handle);
            return;
        }
        // Table C.86: the new connection of a device in a pair is told so
        const pair = registry.getPair();
        if (pair) {
            registry.notifyDevice({ event: 'pairFormed', clientType: pair.clientType });
        }
    }

    // Figure C.8: decides the connection of a local client to its local entry
    // point: refuses it, forms the pair, replaces the connection of the same
    // client or transfers the pair to the associated client. Synchronous: no
    // await between the decision and the change of the pair
    public connectClient(entryPoint: LocalEntryPoint, ws: WebSocket): void {
        const { registry, clientId, clientType } = entryPoint;
        const pair = registry.getPair();

        if (!registry.isConnected()) {
            sendAndClose(ws, { event: 'pairRefused', reason: 'deviceUnavailable' }, CLOSE_DEVICE_UNAVAILABLE);
            return;
        }

        if (!pair) {
            registry.setPair({ ws, clientId, clientType });
            this.notify(EventType.PAIR_FORMED, registry);
            registry.notifyDevice({ event: 'pairFormed', clientType });
            this.project(registry.handle);
            return;
        }

        if (pair.clientId === clientId) {
            registry.setPair({ ws, clientId, clientType });
            pair.ws.close();
            return;
        }

        // The pair changes before the messages, so that what the stand-alone
        // client still sends is not forwarded; the transfer has no event
        if (pair.clientType === 'standAlone' && clientType === 'associated') {
            registry.setPair({ ws, clientId, clientType });
            sendAndClose(pair.ws, { event: 'pairEnded', reason: 'preemptedByAssociated' }, CLOSE_PREEMPTED);
            registry.notifyDevice({ event: 'pairEnded', clientType: 'standAlone' });
            registry.notifyDevice({ event: 'pairFormed', clientType: 'associated' });
            return;
        }

        sendAndClose(ws, { event: 'pairRefused', reason: 'deviceBusy' }, CLOSE_DEVICE_BUSY);
    }

    // Figure C.7: the connection of the device closed. Ignores a replaced
    // connection and a removed registry, whose event removeRegistry emitted
    public disconnect(registry: Registry, ws: WebSocket): void {
        const wasCurrent = registry.disconnect(ws);
        const isRegistered = this.registryByHandle.get(registry.handle) === registry;
        if (wasCurrent && isRegistered) {
            this.endPairByUnavailability(registry);
            this.notify(EventType.UNAVAILABLE, registry);
            this.project(registry.handle);
        }
    }

    // Figure C.8: the connection of a local client closed. Ends the pair if
    // the socket is the one of the pair; a refused, replaced or preempted
    // socket is ignored
    public disconnectClient(registry: Registry, ws: WebSocket): void {
        const pair = registry.getPair();
        if (pair?.ws !== ws) {
            return;
        }
        registry.setPair(undefined);
        this.notify(EventType.PAIR_ENDED, registry);
        registry.notifyDevice({ event: 'pairEnded', clientType: pair.clientType });
        this.project(registry.handle);
    }

    // C.6.15.5: forwards a message of the device to the local client in the
    // pair; a message of a replaced connection of the device is dropped
    public forwardFromDevice(registry: Registry, ws: WebSocket, data: RawData, isBinary: boolean): void {
        if (!registry.isDeviceConnection(ws)) {
            return;
        }
        registry.getPair()?.ws.send(data, { binary: isBinary });
    }

    // C.6.15.5: forwards a message of a local client to the device, only if
    // the client is the one in the pair
    public forwardFromClient(registry: Registry, ws: WebSocket, data: RawData, isBinary: boolean): void {
        if (registry.getPair()?.ws !== ws) {
            return;
        }
        registry.sendToDevice(data, isBinary);
    }

    // Removes every registration, as removeRegistry does for each one
    public clear(): void {
        for (const handle of [...this.registryByHandle.keys()]) {
            this.removeRegistry(handle);
        }
    }

    public size(): number {
        return this.registryByHandle.size;
    }

    public getRegistryByClass(deviceClass: string): Set<Registry> {
        return this.registryByClass.get(deviceClass) ?? new Set<Registry>();
    }

    public getRegistryByHandle(handle: string): Registry | undefined {
        return this.registryByHandle.get(handle);
    }

    public getEntryPoint(token: string): EntryPoint | undefined {
        return this.entryPointByToken.get(token);
    }

    // Table C.87: sequence number of the class; 0 for a class without events
    public getSequence(deviceClass: string): number {
        return this.sequenceByClass.get(deviceClass) ?? 0;
    }

    public getConnected(deviceClass: string): Set<Registry> {
        const result = new Set<Registry>();
        for (const registry of this.getRegistryByClass(deviceClass)) {
            if (registry.isConnected()) {
                result.add(registry);
            }
        }
        return result;
    }

    // C.6.15.2, Table C.76: removes the registration disconnected for the
    // longest time. Returns false if every registration is connected
    public discardOldestDisconnected(): boolean {
        let oldest: Registry | undefined;
        for (const registry of this.registryByHandle.values()) {
            if (registry.isConnected()) {
                continue;
            }
            if (!oldest || registry.getDisconnectedAt() < oldest.getDisconnectedAt()) {
                oldest = registry;
            }
        }
        if (!oldest) {
            return false;
        }
        this.removeRegistry(oldest.handle);
        return true;
    }

    // Returns the token of the local entry point of the client for the
    // registry, creating it on the first call
    public addLocalEntryPoint(registry: Registry, clientId: string, clientType: ClientType): string {
        const existing = registry.getLocalToken(clientId);
        if (existing) {
            return existing;
        }
        const token = generateToken();
        registry.setLocalToken(clientId, token);
        this.entryPointByToken.set(token, { kind: 'local', registry, clientId, clientType });
        return token;
    }

    // Removes the local entry points of the client for every registry
    public removeClientEntryPoints(clientId: string): void {
        for (const registry of this.registryByHandle.values()) {
            const token = registry.getLocalToken(clientId);
            if (token) {
                registry.deleteLocalToken(clientId);
                this.entryPointByToken.delete(token);
            }
        }
    }

    // Table C.87: increments the sequence number of the class of the
    // registry and delivers the event to the listeners of the remote-device
    // event class, unfiltered or filtered by that class
    protected notify(eventType: EventType, registry: Registry): void {
        const deviceClass = registry.getDeviceClass();
        const sequence = this.getSequence(deviceClass) + 1;
        this.sequenceByClass.set(deviceClass, sequence);

        const event: RemoteDeviceEvent = { eventType, classId: deviceClass, deviceId: registry.deviceId, sequence };
        listeners.publish(REMOTE_DEVICE_EVENT_CLASS, event, (params) => {
            return params.classId === undefined || params.classId === deviceClass;
        });
    }

    // Enqueues the projection in Redis of the registry of the handle, after
    // the change in memory
    protected project(handle: string): void {
        projectRegistry(handle, () => this.registryByHandle.get(handle));
    }

    // C.6.15.5: the device is no longer available; the local client in the
    // pair is told so and its connection closed. The unavailable event
    // stands for the end of the pair, and the device gets no Table C.86
    // message
    protected endPairByUnavailability(registry: Registry): void {
        const pair = registry.getPair();
        if (!pair) {
            return;
        }
        registry.setPair(undefined);
        sendAndClose(pair.ws, { event: 'pairEnded', reason: 'deviceUnavailable' }, CLOSE_DEVICE_UNAVAILABLE);
    }

    protected addToClass(registry: Registry): void {
        const deviceClass = registry.getDeviceClass();
        let classSet = this.registryByClass.get(deviceClass);
        if (!classSet) {
            classSet = new Set<Registry>();
            this.registryByClass.set(deviceClass, classSet);
        }
        classSet.add(registry);
    }

    // Deletes the class entry when its last registry leaves
    protected removeFromClass(registry: Registry): void {
        const deviceClass = registry.getDeviceClass();
        const classSet = this.registryByClass.get(deviceClass);
        if (!classSet) {
            return;
        }
        classSet.delete(registry);
        if (classSet.size === 0) {
            this.registryByClass.delete(deviceClass);
        }
    }
}

// Single instance shared by the API and the entry server
export const registries = new RegistryManager();
