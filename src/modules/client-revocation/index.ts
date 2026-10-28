import { z } from 'zod';
import logger from '../../logger';
import mqttClient from '../../mqtt-client';

type BlockedListener = (clientId: string) => void;

// clientid of a client blocked by the viewer in the history of
// authorizations (C.4.2.2), published by the Access Panel after storing the
// block.
const ClientIdSchema = z.string().min(1);

const CLIENT_BLOCKED_TOPIC = 'aop/access-panel/client-blocked';

const blockedListeners: BlockedListener[] = [];

// Registers a function called with the clientid of each blocked client.
export function onClientBlocked(listener: BlockedListener): void {
    blockedListeners.push(listener);
}

// Calls the blocked listeners; an invalid message is logged and ignored.
function onClientBlockedMessage(message: string): void {
    const parsed = ClientIdSchema.safeParse(message);
    if (!parsed.success) {
        logger.error(`[client-revocation] invalid message in ${CLIENT_BLOCKED_TOPIC}`);
        return;
    }
    for (const listener of blockedListeners) {
        listener(parsed.data);
    }
}

mqttClient.addTopicHandler(CLIENT_BLOCKED_TOPIC, onClientBlockedMessage);
