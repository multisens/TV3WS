import { ApiError } from '../../../util';
import { listeners } from '../../modules/notifications/listeners';
import { isNotificationServerListening, listenerUrl } from '../../modules/notifications/server';

// C.6.2.2, Table C.5
export type RegisterListenerResponse = {
    handle: string;
    url: string;
};

// C.6.2.2: registers the client as a listener of the event class
function registerListener(className: string, clientId: string, params: Record<string, string>): RegisterListenerResponse {
    if (!listeners.isEventClass(className)) {
        throw new ApiError(101, `event class ${className}`);
    }
    if (!isNotificationServerListening()) {
        throw new ApiError(200, 'notification server is not listening');
    }
    const listener = listeners.addListener(className, clientId, params);
    return { handle: listener.handle, url: listenerUrl(listener.token) };
}

// C.6.2.3: removes the listener of the handle
function removeListener(handle: string): void {
    const removed = listeners.removeListener(handle);
    if (!removed) {
        throw new ApiError(305, `handle ${handle}`);
    }
}

export default { registerListener, removeListener };
