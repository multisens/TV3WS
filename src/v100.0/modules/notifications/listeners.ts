import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import { generateToken } from '../../util/token';

// C.6.2.2: listener registered for an event class, with the class-dependent
// query parameters it gave
export type Listener = {
    readonly handle: string;
    readonly token: string;
    readonly className: string;
    readonly clientId: string;
    readonly params: Record<string, string>;
    ws?: WebSocket;
};

class ListenerManager {
    protected eventClasses = new Set<string>();
    protected listenerByHandle = new Map<string, Listener>();
    protected listenerByToken = new Map<string, Listener>();

    // C.6.2.4: makes the event class valid for registration; called by the
    // module that produces its events
    public defineEventClass(className: string): void {
        this.eventClasses.add(className);
    }

    public isEventClass(className: string): boolean {
        return this.eventClasses.has(className);
    }

    public addListener(className: string, clientId: string, params: Record<string, string>): Listener {
        const listener: Listener = { handle: uuidv4(), token: generateToken(), className, clientId, params };
        this.listenerByHandle.set(listener.handle, listener);
        this.listenerByToken.set(listener.token, listener);
        return listener;
    }

    // C.6.2.3: removes the listener and closes its connection. Returns false
    // if there is no listener with the handle
    public removeListener(handle: string): boolean {
        const listener = this.listenerByHandle.get(handle);
        if (!listener) {
            return false;
        }
        this.listenerByHandle.delete(handle);
        this.listenerByToken.delete(listener.token);
        listener.ws?.close();
        return true;
    }

    // Removes every listener of the client, as removeListener does for each
    // one
    public removeClientListeners(clientId: string): void {
        for (const listener of [...this.listenerByHandle.values()]) {
            if (listener.clientId === clientId) {
                this.removeListener(listener.handle);
            }
        }
    }

    public getByToken(token: string): Listener | undefined {
        return this.listenerByToken.get(token);
    }

    // Takes the new connection of the listener and closes the previous one,
    // if any
    public connect(listener: Listener, ws: WebSocket): void {
        const previous = listener.ws;
        listener.ws = ws;
        previous?.close();
    }

    // Called when the socket has closed; the listener stays registered until
    // C.6.2.3. Ignores a socket that is no longer the current one
    public disconnect(listener: Listener, ws: WebSocket): void {
        if (listener.ws === ws) {
            listener.ws = undefined;
        }
    }

    // Sends the event to every connected listener of the class whose query
    // parameters the class accepts
    public publish(className: string, event: object, accepts: (params: Record<string, string>) => boolean): void {
        const message = JSON.stringify(event);
        for (const listener of this.listenerByHandle.values()) {
            if (listener.className !== className || !listener.ws) {
                continue;
            }
            if (accepts(listener.params)) {
                listener.ws.send(message);
            }
        }
    }

    // Removes every listener, as removeListener does for each one
    public clear(): void {
        for (const handle of [...this.listenerByHandle.keys()]) {
            this.removeListener(handle);
        }
    }
}

// Single instance shared by the API, the notification server and the event
// producers
export const listeners = new ListenerManager();
