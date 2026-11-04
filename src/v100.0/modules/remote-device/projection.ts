import logger from '../../../logger';
import { clearRemoteDevicesV100, removeRemoteDeviceV100, writeRemoteDeviceV100 } from '../../../redis-functions';
import Registry from './registry';

// Pending writes of each handle; a write starts after the previous one of
// the same handle
const queueByHandle = new Map<string, Promise<void>>();

// Resolved by startProjection, after the boot cleanup; the first write of
// each handle waits for it
let resolveCleared: () => void = () => undefined;
const cleared = new Promise<void>((resolve) => {
    resolveCleared = resolve;
});

// Boot: removes the projection left by a previous run and lets the writes
// start
export async function startProjection(): Promise<void> {
    await clearRemoteDevicesV100();
    resolveCleared();
}

// Enqueues the projection of the registry of the handle as it is when the
// write runs: current() gives the registry, or undefined once it is
// removed. A failure is logged; the next write of the handle rewrites the
// whole record
export function projectRegistry(handle: string, current: () => Registry | undefined): void {
    const previous = queueByHandle.get(handle) ?? cleared;
    const next = previous
        .then(() => writeProjection(handle, current()))
        .catch((err: Error) => {
            logger.error(`[v100.0 remote-device] projection of ${handle} not written: ${err.message}`);
        });
    queueByHandle.set(handle, next);
    void next.then(() => {
        if (queueByHandle.get(handle) === next) {
            queueByHandle.delete(handle);
        }
    });
}

async function writeProjection(handle: string, registry: Registry | undefined): Promise<void> {
    if (registry === undefined) {
        await removeRemoteDeviceV100(handle);
        return;
    }
    await writeRemoteDeviceV100(handle, projectionOf(registry));
}

// Fields of v100.0:remote-device:{handle}; neither the token of the entry
// point nor the connections
function projectionOf(registry: Registry): Record<string, string> {
    return {
        deviceId: registry.deviceId,
        deviceClass: registry.getDeviceClass(),
        supportedTypes: JSON.stringify(registry.getSupportedTypes()),
        state: registry.isConnected() ? 'connected' : 'registered',
        paired: String(registry.isPaired()),
        disconnectedAt: String(registry.getDisconnectedAt()),
        registeredBy: registry.registeredBy,
    };
}
