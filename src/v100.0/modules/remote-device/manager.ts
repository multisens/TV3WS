import { generateToken } from '../../util/token';
import { ClientType } from '../../util/client';
import Registry from './registry';
import { WebSocket } from 'ws';

// Entry point identified by a token in the URL path: the one of the device
// (C.6.15.2) or the local one of a local client for the device (C.6.15.5)
export type EntryPoint =
    | { kind: 'device'; registry: Registry }
    | { kind: 'local'; registry: Registry; clientId: string; clientType: ClientType };

export enum EventType {
    AVAILABLE = 'available',
    UNAVAILABLE = 'unavailable',
    PAIR_FORMED = 'pairFormed',
    PAIR_ENDED = 'pairEnded'
};

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
            this.notify(EventType.UNAVAILABLE, registry);
        }
        this.removeFromClass(registry);
        registry.update(deviceClass, supportedTypes);
        this.addToClass(registry);
        if (classChanged && registry.isConnected()) {
            this.notify(EventType.AVAILABLE, registry);
        }
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
            this.notify(EventType.UNAVAILABLE, registry);
        }
        this.registryByHandle.delete(handle);
        this.entryPointByToken.delete(registry.token);
        for (const token of registry.getLocalTokens()) {
            this.entryPointByToken.delete(token);
        }
        this.removeFromClass(registry);
        registry.close();
        return true;
    }

    // Figure C.7: the device connects to its entry point; a connection that
    // replaces another keeps the device available
    public connect(registry: Registry, ws: WebSocket): void {
        const becameAvailable = registry.connect(ws);
        if (becameAvailable) {
            this.notify(EventType.AVAILABLE, registry);
        }
    }

    // Figure C.7: the connection of the device closed. Ignores a replaced
    // connection and a removed registry, whose event removeRegistry emitted
    public disconnect(registry: Registry, ws: WebSocket): void {
        const wasCurrent = registry.disconnect(ws);
        const isRegistered = this.registryByHandle.get(registry.handle) === registry;
        if (wasCurrent && isRegistered) {
            this.notify(EventType.UNAVAILABLE, registry);
        }
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
    // registry at each event of the class
    // TODO: deliver the event to the listeners of the remote-device event
    // class (C.6.15.6, C.6.2)
    protected notify(eventType: EventType, registry: Registry): void {
        const deviceClass = registry.getDeviceClass();
        const sequence = this.getSequence(deviceClass) + 1;
        this.sequenceByClass.set(deviceClass, sequence);
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
