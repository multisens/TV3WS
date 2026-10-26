import { ApiError, positiveIntFromEnv } from '../../../util';
import { entryPointUrl, isEntryServerListening, localEntryPointUrl } from '../../modules/remote-device/entry-server';
import { registries } from '../../modules/remote-device/manager';
import { LocalClient } from '../../util/client';
import { RegisterBody } from './schema';

// C.6.15.2, Table C.76: url only in the response of a new registration
export type RegisterResponse = {
    handle: string;
    url?: string;
};

// C.6.15.5, Table C.80
export type DeviceInfo = {
    deviceId: string;
    supportedTypes: string[];
    paired: boolean;
    url: string;
};

export type DeviceListResponse = {
    sequence: number;
    devices?: DeviceInfo[];
};

// Receiver limit on devices to register
const MAX_REGISTRATIONS = positiveIntFromEnv('MAX_REGISTRATIONS');

// C.6.15.2: creates the registration and returns its handle and the URL of
// its entry point
function registerDevice(body: RegisterBody): RegisterResponse {
    if (!isEntryServerListening()) {
        throw new ApiError(200, 'entry server is not listening');
    }

    if (registries.size() >= MAX_REGISTRATIONS) {
        const discarded = registries.discardOldestDisconnected();

        if (!discarded) {
            throw new ApiError(200, 'maximum number of registries exceeded');
        }
    }
    const registry = registries.addRegistry(body.deviceClass, body.supportedTypes);
    const url = entryPointUrl(registry.token);
    return { handle: registry.handle, url };
}

// C.6.15.2: updates the registration of the handle
function updateDevice(handle: string, body: RegisterBody): RegisterResponse {
    const updated = registries.updateRegistry(handle, body.deviceClass, body.supportedTypes);
    if (!updated) {
        throw new ApiError(305, `handle ${handle}`);
    }
    return { handle };
}

// C.6.15.3: removes the registration of the handle
function removeDevice(handle: string): void {
    const removed = registries.removeRegistry(handle);
    if (!removed) {
        throw new ApiError(305, `handle ${handle}`);
    }
}

// C.6.15.5: list connected devices registered in a class
function listDevices(deviceClass: string, client: LocalClient): DeviceListResponse {
    const sequence = registries.getSequence(deviceClass);
    const connected = registries.getConnected(deviceClass);

    const devices: DeviceInfo[] = [];
    for (const registry of connected) {
        const token = registries.addLocalEntryPoint(registry, client.clientId, client.clientType);
        devices.push({
            deviceId: registry.deviceId,
            supportedTypes: registry.getSupportedTypes(),
            paired: registry.isPaired(),
            url: localEntryPointUrl(token),
        });
    }

    if (devices.length > 0) {
        return {
            sequence: sequence,
            devices: devices,
        };
    }
    return {
        sequence: sequence,
    };
}

export default { registerDevice, updateDevice, removeDevice, listDevices };
