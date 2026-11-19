import { z } from 'zod';
import logger from '../../logger';
import mqttClient from '../../mqtt-client';
import redis from '../../redis-client';

// The running broadcaster application, read from session:current-app at each
// call, and the changes of its state, published by the Application
// Lifecycle Manager (ABNT NBR 25608, Section 6).

export type Application = {
    serviceContextId: string;
    appId: string;
};

type StartedListener = (application: Application) => void | Promise<void>;
type EndedListener = (associatedId: string) => void | Promise<void>;

const ApplicationStateSchema = z.object({
    serviceContextId: z.string().min(1),
    appId: z.string(),
    origin: z.string().min(1),
    state: z.enum(['started', 'ended']),
});
type ApplicationState = z.infer<typeof ApplicationStateSchema>;

// Hash of aop-application-lifecycle-manager; absent when no broadcaster
// application is running.
const CurrentAppSchema = z.object({
    serviceContextId: z.string().min(1),
    appId: z.string().min(1),
});

const APPLICATION_STATE_TOPIC = 'aop/application-lifecycle-manager/application-state';
const CURRENT_APP_KEY = 'session:current-app';

const startedListeners: StartedListener[] = [];
const endedListeners: EndedListener[] = [];

// Identity of the associated local client: the running application, as
// serviceContextId/appId; undefined when no application is running.
export async function currentAssociatedId(): Promise<string | undefined> {
    const hash = await redis.hgetall(CURRENT_APP_KEY);
    if (Object.keys(hash).length === 0) {
        return undefined;
    }
    return associatedIdOf(CurrentAppSchema.parse(hash));
}

// Registers a function called with each application that starts.
export function onAssociatedStarted(listener: StartedListener): void {
    startedListeners.push(listener);
}

// Registers a function called with the identity of each application that
// ends.
export function onAssociatedEnded(listener: EndedListener): void {
    endedListeners.push(listener);
}

// Calls the listeners of the state; an invalid message is logged and
// ignored.
function onApplicationState(message: string): void {
    let state: ApplicationState;
    try {
        state = ApplicationStateSchema.parse(JSON.parse(message));
    } catch (err) {
        logger.error(`[associated-app] invalid message in ${APPLICATION_STATE_TOPIC}: ${(err as Error).message}`);
        return;
    }
    const application: Application = { serviceContextId: state.serviceContextId, appId: state.appId };
    switch (state.state) {
        case 'started':
            for (const listener of startedListeners) {
                void notify(() => listener(application));
            }
            break;
        case 'ended':
            for (const listener of endedListeners) {
                void notify(() => listener(associatedIdOf(application)));
            }
            break;
        default:
            break;
    }
}

// The failure of a listener is logged and does not stop the others; the
// returned promise never rejects.
async function notify(call: () => void | Promise<void>): Promise<void> {
    try {
        await call();
    } catch (err) {
        logger.error(`[associated-app] listener failed: ${(err as Error).message}`);
    }
}

function associatedIdOf(application: Application): string {
    return `${application.serviceContextId}/${application.appId}`;
}

mqttClient.addTopicHandler(APPLICATION_STATE_TOPIC, onApplicationState);
