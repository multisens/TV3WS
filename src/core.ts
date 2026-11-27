import * as dotenv from 'dotenv';
import { z } from 'zod';
import logger from './logger';
import { client } from './mqtt-client';
import { Application, onAssociatedEnded, onAssociatedStarted } from './modules/associated-app';
import { associateAppNodes, disassociateAppNodes } from './modules/remotedevice-manager/manager';
import { AppNode } from './modules/remotedevice-manager/remote-device';
import redis from './redis-client';

// Before the globals, which read the environment.
dotenv.config();

// State shared by the modules of tv3ws: the host of the WebSocket entry
// points and the running application with the nodes of its document; and the
// pop-ups of the platform.

type CoreData = {
    server: {
        url: string;
    };
    // The running application, for the nodes of its document.
    app: {
        sid: string;
        id: string;
        nodes: AppNode[];
    };
};

type PopUpResponseHandler = (message: string) => void;

// app:doc-nodes:{serviceContextId}, of the Ginga-NCL formatter: the nodes of
// the document of each application, by appId.
const DOC_NODES_KEY_PREFIX = 'app:doc-nodes:';
const AppNodeListSchema = z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['media', 'context', 'switch']),
    mimeType: z.string().min(1),
    device: z.string().min(1),
}));

const POPUP_TOPICS = {
    yesNo: 'aop/display/layers/popup/yesno',
    qrCode: 'aop/display/layers/popup/qrcode',
    pin: 'aop/display/layers/popup/pin',
};
const YES_NO_RESPONSE_TOPIC = `${POPUP_TOPICS.yesNo}/response`;
const YES_NO_MESSAGE_TOPIC = `${POPUP_TOPICS.yesNo}/message`;
const DEFAULT_YES_NO_TIMEOUT_MS = 1000;

// End of the pairing (ABNT NBR 25608, C.4.3.2 and C.4.3.3): {"close":true}
// on the topic of the pop-up. Same client, topic and QoS as the opening, so
// MQTT keeps the order.
const CLOSE_POPUP_MESSAGE = JSON.stringify({ close: true });

const SUBSCRIBE_OPTIONS = { qos: 1, nl: true } as const;

const data: CoreData = {
    server: {
        url: process.env.SERVER_URL as string,
    },
    app: {
        sid: '',
        id: '',
        nodes: [],
    },
};

// Response handlers of the pop-ups, by topic.
const popUpHandlers = new Map<string, PopUpResponseHandler>();

// Asks the yes or no pop-up; resolves false when the time runs out.
export function showYesNoPopUpAsync(message: string, timeout: number = DEFAULT_YES_NO_TIMEOUT_MS): Promise<boolean> {
    logger.info(`Calling Yes/No popup with message:\n${message}\nTimeout in ${timeout}ms`);
    return new Promise((resolve) => {
        const finish = (answer: boolean): void => {
            unsubscribePopUp(YES_NO_RESPONSE_TOPIC);
            resolve(answer);
        };
        const timeoutId = setTimeout(() => {
            logger.debug('Timeout for popup');
            finish(false);
        }, timeout);
        subscribePopUp(YES_NO_RESPONSE_TOPIC, (response) => {
            logger.debug(`Received response ${response} for Yes/No popup`);
            clearTimeout(timeoutId);
            // Only "true" authorizes (Boolean("false") is true).
            finish(response.trim() === 'true');
        });
        client.publish(YES_NO_MESSAGE_TOPIC, JSON.stringify({ value: message, timeout }));
    });
}

export function showQRCodePopUp(code: string, timeout: number): void {
    logger.info(`Calling QRCode popup with code:\n${code}\nTimeout in ${timeout}ms`);
    client.publish(POPUP_TOPICS.qrCode, JSON.stringify({ value: code, timeout }));
}

export function showPINPopUp(pin: string, timeout: number): void {
    logger.info(`Calling PIN popup with pin:\n${pin}\nTimeout in ${timeout}ms`);
    client.publish(POPUP_TOPICS.pin, JSON.stringify({ value: pin, timeout }));
}

export function closeQRCodePopUp(): void {
    logger.info('Closing QRCode popup');
    client.publish(POPUP_TOPICS.qrCode, CLOSE_POPUP_MESSAGE);
}

export function closePINPopUp(): void {
    logger.info('Closing PIN popup');
    client.publish(POPUP_TOPICS.pin, CLOSE_POPUP_MESSAGE);
}

// The nodes of the document of the application that starts, from
// app:doc-nodes:{serviceContextId}, associated to their devices; without
// nodes, none. The application that ends releases them.
async function onApplicationStarted(application: Application): Promise<void> {
    const raw = await redis.hget(docNodesKey(application.serviceContextId), application.appId);
    const nodes = raw === null ? [] : AppNodeListSchema.parse(JSON.parse(raw));
    disassociateAppNodes();
    data.app.sid = application.serviceContextId;
    data.app.id = application.appId;
    // The values of NodeType, as the schema lists them.
    data.app.nodes = nodes as AppNode[];
    associateAppNodes();
}

function onApplicationEnded(associatedId: string): void {
    if (associatedId !== `${data.app.sid}/${data.app.id}`) {
        return;
    }
    disassociateAppNodes();
    data.app.sid = '';
    data.app.id = '';
    data.app.nodes = [];
}

function onPopUpMessage(topic: string, message: Buffer): void {
    const handler = popUpHandlers.get(topic);
    if (handler === undefined) {
        logger.debug(`No handler for topic ${topic}`);
        return;
    }
    handler(message.toString());
}

function subscribePopUp(topic: string, handler: PopUpResponseHandler): void {
    popUpHandlers.set(topic, handler);
    client.subscribe(topic, SUBSCRIBE_OPTIONS);
    logger.debug(`Subscribed to topic ${topic}`);
}

function unsubscribePopUp(topic: string): void {
    popUpHandlers.delete(topic);
    client.unsubscribe(topic);
    logger.debug(`Unsubscribed from topic ${topic}`);
}

function docNodesKey(serviceContextId: string): string {
    return `${DOC_NODES_KEY_PREFIX}${serviceContextId}`;
}

onAssociatedStarted(onApplicationStarted);
onAssociatedEnded(onApplicationEnded);
client.on('message', onPopUpMessage);

export default data;
