import { generateToken } from '../../util/token';
import Registry from './registry';

export type ClientType = 'associated' | 'standAlone';

// Entry point identified by a token in the URL path: the one of the device
// (C.6.15.2) or the local one of a local client for the device (C.6.15.5)
export type EntryPoint =
    | { kind: 'device'; registry: Registry }
    | { kind: 'local'; registry: Registry; clientId: string; clientType: ClientType };


class RegistryManager {
    protected registryByHandle = new Map<string, Registry>();
    protected entryPointByToken = new Map<string, EntryPoint>();
    protected registryByClass = new Map<string, Set<Registry>>();

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
        this.removeFromClass(registry);
        registry.update(deviceClass, supportedTypes);
        this.addToClass(registry);
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
        this.registryByHandle.delete(handle);
        this.entryPointByToken.delete(registry.token);
        for (const token of registry.getLocalTokens()) {
            this.entryPointByToken.delete(token);
        }
        this.removeFromClass(registry);
        registry.close();
        return true;
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
