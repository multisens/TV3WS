import * as dotenv from 'dotenv';
import mqtt, { MqttClient } from 'mqtt';
import logger from './logger';

// The MQTT client of tv3ws: handlers by exact topic, the subscription made
// with the first handler and undone with the last.

type TopicHandler = {
    (m: string, t?: string): void | Promise<void>;
};

export const TOPICS = {
    current_user: 'aop/currentUser',
    app_doc: 'aop/:serviceId/:appId/doc',
    devices: 'aop/devices',
    tuned: 'tlm/tuned',
    bald: 'tlm/sls/:serviceId/bald',
    stsid: 'tlm/sls/:serviceId/stsid',
};

const CLIENT_ID = 'tv3ws-client';
const CONNECT_TIMEOUT_MS = 4000;
const PROTOCOL_VERSION = 5;
const DEFAULT_BROKER_HOST = 'localhost';
const SUBSCRIBE_OPTIONS = { qos: 1, nl: true } as const;

dotenv.config();

const brokerHost = process.env.MQTT_HOST || DEFAULT_BROKER_HOST;
export const client: MqttClient = mqtt.connect(`mqtt://${brokerHost}`, {
    clientId: CLIENT_ID,
    clean: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    protocolVersion: PROTOCOL_VERSION,
});
const topicHandlers = new Map<string, TopicHandler[]>();

function addTopicHandler(t: string, f: TopicHandler): void {
    const handlers = topicHandlers.get(t);
    if (handlers !== undefined) {
        handlers.push(f);
        logger.debug(`Added handler to topic ${t}`);
        return;
    }
    topicHandlers.set(t, [f]);
    client.subscribe(t, SUBSCRIBE_OPTIONS);
    logger.debug(`Subscribed handler to topic ${t}`);
}

// The handler is found by its source text, so that a new bind of the same
// method removes the one added before.
function removeTopicHandler(t: string, f: TopicHandler): void {
    const handlers = topicHandlers.get(t);
    if (handlers === undefined) {
        logger.debug(`Topic ${t} not found in handlers`);
        return;
    }
    const index = handlers.findIndex((handler) => handler.toString() === f.toString());
    if (index === -1) {
        logger.debug(`Handler not found for topic ${t}`);
        return;
    }
    handlers.splice(index, 1);
    if (handlers.length > 0) {
        logger.debug(`Handler removed from topic ${t}, ${handlers.length} remaining`);
        return;
    }
    topicHandlers.delete(t);
    client.unsubscribe(t);
    logger.debug(`Unsubscribed from topic ${t} (no more handlers)`);
}

function publish(t: string, m: string, r: boolean = true): void {
    client.publish(t, m, { retain: r });
}

// Replaces each :name level by params[name], when present.
function parseTopic(topic: string, params: Record<string, string>): string {
    const levels = topic.split('/').map((level) => {
        const key = level.startsWith(':') ? level.substring(1) : undefined;
        if (key !== undefined && key in params) {
            return params[key];
        }
        return level;
    });
    return levels.join('/');
}

// A rejection of an async handler is logged: loose, it would bring the
// process down (unhandled rejection).
function onMessage(topic: string, message: Buffer): void {
    logger.debug(`Message received in ${topic}: ${message.toString()}`);
    const handlers = topicHandlers.get(topic);
    if (handlers === undefined) {
        logger.debug(`No handler for topic ${topic}`);
        return;
    }
    for (const handler of handlers) {
        const pending = handler(message.toString(), topic);
        if (pending instanceof Promise) {
            pending.catch((err: Error) => logger.error(`[mqtt] handler of ${topic} failed: ${err?.message}`));
        }
    }
}

client.on('connect', () => logger.info('Connected to MQTT broker'));
client.on('message', onMessage);

export default { addTopicHandler, removeTopicHandler, publish, parseTopic };
