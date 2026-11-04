import { z } from 'zod';
import logger from '../../logger';
import mqttClient from '../../mqtt-client';

type EndedListener = (associatedId: string) => void;

// Change of state of an application, published by the Application
// Lifecycle Manager (ABNT NBR 25608, Section 6).
const ApplicationStateSchema = z.object({
    serviceContextId: z.string().min(1),
    appId: z.string(),
    origin: z.string().min(1),
    state: z.enum(['started', 'ended']),
});
type ApplicationState = z.infer<typeof ApplicationStateSchema>;

const APPLICATION_STATE_TOPIC = 'aop/application-lifecycle-manager/application-state';

// Identity of the running associated application, or undefined when none
// is running
let currentId: string | undefined;
const endedListeners: EndedListener[] = [];

// Identity of the associated local client: the running application, as
// serviceContextId/appId; undefined when no application is running.
export function currentAssociatedId(): string | undefined {
    return currentId;
}

// Registers a function called with the identity of each application that
// ends.
export function onAssociatedEnded(listener: EndedListener): void {
    endedListeners.push(listener);
}

// Keeps the identity of the application that starts; on the end, forgets it
// and calls the ended listeners. An invalid message is logged and ignored.
function onApplicationState(message: string): void {
    let state: ApplicationState;
    try {
        state = ApplicationStateSchema.parse(JSON.parse(message));
    } catch (err) {
        logger.error(`[associated-app] invalid message in ${APPLICATION_STATE_TOPIC}: ${(err as Error).message}`);
        return;
    }
    const id = associatedIdOf(state);
    switch (state.state) {
        case 'started':
            currentId = id;
            break;
        case 'ended':
            if (currentId === id) {
                currentId = undefined;
            }
            for (const listener of endedListeners) {
                listener(id);
            }
            break;
        default:
            break;
    }
}

function associatedIdOf(state: ApplicationState): string {
    return `${state.serviceContextId}/${state.appId}`;
}

mqttClient.addTopicHandler(APPLICATION_STATE_TOPIC, onApplicationState);
