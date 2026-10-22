import { ApiError } from '../../../util';
import { entryPointUrl, isEntryServerListening } from '../../modules/remote-device/entry-server';
import { registries } from '../../modules/remote-device/manager';
import { RegisterBody } from './schema';

// Receiver limit on devices to register
const MAX_REGISTRATIONS = parseInt(process.env.MAX_REGISTRATIONS || '32');

// C.6.15.2, Table C.76: url only in the response of a new registration
export type RegisterResponse = {
    handle: string;
    url?: string;
};

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

export default { registerDevice, updateDevice, removeDevice };
