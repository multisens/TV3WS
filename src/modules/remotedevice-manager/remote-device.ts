import { RawData, WebSocket, WebSocketServer } from 'ws';
import core from '../../core';
import logger from '../../logger';
import mqttClient, { TOPICS } from '../../mqtt-client';
import { ReqBody } from '../../api/remote-device/service';
import {
    Action,
    CapabilitiesMetadata,
    ControlMetadata,
    DeviceCapabilities,
    EffectType,
    EventType,
    type ActionMetadata,
    type NodeMetadata,
    type TransitionMetadata,
} from './types';
import { removeRemoteDevice } from './manager';
import { closeEntryPoint, entryPointUrl } from './entry-point';

enum InterfaceType {
    area = 'area',
    property = 'property',
    port = 'port',
}

enum NodeType {
    media = 'media',
    context = 'context',
    switch = 'switch',
}

type PropertiesType = { name: string; value: string }[];

export type AppNode = {
    id: string;
    type: NodeType;
    mimeType: string;
    device: string;
};

export type NodeInterface = {
    id: string;
    type: InterfaceType;
};

// Property of the node that carries its source, sent apart from the others.
const SRC_PROPERTY = 'src';

export default class RemoteDevice {
    // Client that made the registration (C.4.4)
    public readonly registeredBy: string;

    protected handle: string;
    protected deviceClass: string;
    protected supportedTypes: string[];
    protected capabilities: DeviceCapabilities[];

    protected ws?: WebSocket;
    protected wss: WebSocketServer;
    protected lws?: WebSocket;
    protected lwss?: WebSocketServer;

    protected subscribed: boolean;
    protected bridge: boolean;
    protected topicPrefix?: string;
    protected node?: AppNode;
    protected interfaceIds?: string[];
    protected properties: Map<string, string>;

    constructor(body: ReqBody, handle: string, wss: WebSocketServer, registeredBy: string) {
        this.registeredBy = registeredBy;
        this.deviceClass = body.deviceClass;
        this.supportedTypes = body.supportedTypes;
        this.handle = handle;
        this.wss = wss;
        this.capabilities = capabilitiesOf(this.supportedTypes);
        this.subscribed = false;
        this.bridge = false;
        this.properties = new Map<string, string>();

        logger.info(`Remote device created with handle ${this.handle}`);
        wss.on('connection', (ws) => this.onWebSocketConnection(ws));
    }

    // C.6.15.2: replaces the class and the supported types; the handle and the
    // connections are kept.
    public update(body: ReqBody): void {
        this.deviceClass = body.deviceClass;
        this.supportedTypes = body.supportedTypes;
        this.capabilities = capabilitiesOf(this.supportedTypes);
    }

    public getClass(): string {
        return this.deviceClass;
    }

    public getHandle(): string {
        return this.handle;
    }

    public getSupportedTypes(): string[] {
        return this.supportedTypes;
    }

    // url of Table C.76: wss:// when the entry point of the device has TLS.
    public getUrl(): string {
        return entryPointUrl(this.wss, core.server.url);
    }

    // url of Table C.80: ws://; empty while there is no local entry point.
    public getLocalEntryPointUrl(): string {
        if (!this.lwss) {
            return '';
        }
        return entryPointUrl(this.lwss, core.server.url);
    }

    public getCapabilities(): DeviceCapabilities[] {
        return this.capabilities;
    }

    public controlDevice(command: ControlMetadata): void {
        logger.debug(`[remote-device] control message to ${this.handle} at ${Date.now()}`);
        this.sendWebSocketMessage(command);
    }

    public support(type: string): boolean {
        return this.supportedTypes.includes(type);
    }

    // Subscribes the preparation and presentation events of the node of the
    // application, which the device presents.
    public setNode(node: AppNode): void {
        logger.info(`Associating node ${node.id} to device ${this.handle}.`);
        this.node = node;

        const docTopic = mqttClient.parseTopic(TOPICS.app_doc, {
            serviceId: core.app.sid,
            appId: core.app.id,
        });
        const ids = node.id.split('.');
        this.topicPrefix = `${docTopic}/${ids.join('/')}`;

        mqttClient.addTopicHandler(`${this.topicPrefix}/interfaces`, this.setNodeInterfaces.bind(this));
        mqttClient.addTopicHandler(`${this.topicPrefix}/preparationEvent/actionNotification`, this.onMqttMessage.bind(this));
        mqttClient.addTopicHandler(`${this.topicPrefix}/presentationEvent/actionNotification`, this.onMqttMessage.bind(this));
        this.subscribed = true;
    }

    public removeNode(): void {
        logger.info(`Disassociating node ${this.node?.id} from device ${this.handle}.`);

        mqttClient.removeTopicHandler(`${this.topicPrefix}/interfaces`, this.setNodeInterfaces.bind(this));
        mqttClient.removeTopicHandler(`${this.topicPrefix}/preparationEvent/actionNotification`, this.onMqttMessage.bind(this));
        mqttClient.removeTopicHandler(`${this.topicPrefix}/presentationEvent/actionNotification`, this.onMqttMessage.bind(this));

        this.subscribed = false;
        this.node = undefined;
        this.topicPrefix = '';
    }

    public addLocalEntryPoint(lwss: WebSocketServer): void {
        if (this.lwss && this.lwss !== lwss) {
            closeEntryPoint(this.lwss);
        }
        this.lwss = lwss;
        lwss.on('connection', (ws) => this.onLocalClientConnection(ws));
    }

    // Closes the local client and the local entry point; nothing else is
    // passed on to a local client.
    public removeLocalEntryPoint(): void {
        this.lws?.close();
        if (this.lwss) {
            closeEntryPoint(this.lwss);
        }
        this.lws = undefined;
        this.lwss = undefined;
        this.bridge = false;
    }

    public terminate(): void {
        this.ws?.close();
        closeEntryPoint(this.wss);
        if (this.subscribed) {
            this.removeNode();
        }
        this.removeLocalEntryPoint();
    }

    protected onWebSocketConnection(ws: WebSocket): void {
        logger.info(`${this.handle} connected.`);
        this.ws = ws;

        ws.on('close', () => {
            logger.info(`${this.handle} disconnected.`);
            // Without an API to answer, a storage failure goes to the log.
            removeRemoteDevice(this.handle).catch((err: Error) => {
                logger.error(`[remote-devices] removal of ${this.handle} after the disconnection failed: ${err?.message}`);
            });
        });

        ws.on('message', (message) => this.onWebSocketMessage(message));
    }

    // With a local client, passes the message on to it; otherwise, handles a
    // transition or a capabilities message.
    protected onWebSocketMessage(message: RawData): void {
        const msg = message.toString();
        logger.debug(`Device ${this.handle} sent message ${msg}`);

        if (this.bridge) {
            this.sendLocalClientMessage(msg);
            return;
        }

        if (msg.includes('transition')) {
            const data: TransitionMetadata = JSON.parse(msg);
            this.publishTransitionMetadata(data);
        } else if (msg.includes('capabilities')) {
            this.onCapabilitiesMessage(msg);
        } else {
            logger.error('Message does not have the expected format.');
        }
    }

    protected sendWebSocketMessage(data: NodeMetadata | ActionMetadata | ControlMetadata): void {
        if (!this.ws) {
            return;
        }
        logger.debug(`Sending message to device ${this.handle}: ${JSON.stringify(data)}`);
        this.ws.send(JSON.stringify(data));
    }

    // Replaces the capability of the effect type with the one received.
    protected onCapabilitiesMessage(msg: string): void {
        const data: CapabilitiesMetadata = JSON.parse(msg);

        const known = this.capabilities.find((c) => c.effectType === data.type);
        const newCapability: DeviceCapabilities = known || {
            effectType: data.type as EffectType,
            state: 'stopped',
        };

        for (const capability of data.capabilities) {
            switch (capability.name) {
                case 'state':
                    newCapability.state = capability.value;
                    break;
                case 'location':
                    // Table A.45
                    newCapability.location = capability.value;
                    break;
                case 'preparationTime':
                    newCapability.preparationTime = capability.value;
                    break;
                default:
                    break;
            }
        }

        this.capabilities = this.capabilities.filter((c) => c.effectType !== newCapability.effectType);
        this.capabilities.push(newCapability);
        logger.debug(`Received capabilities for ${this.deviceClass}: ${JSON.stringify(this.capabilities)}`);
    }

    // Preparation start of the node: sends the node metadata; any other
    // action: sends the action metadata.
    protected onMqttMessage(m: string, t?: string): void {
        if (!t) {
            return;
        }
        const topic = t.replace(`${this.topicPrefix}/`, '');

        try {
            const parsed = this.parseTopic(m, topic);
            if (parsed.eventType === EventType.preparation && m === Action.start) {
                this.sendWebSocketMessage(this.nodeMetadata());
                return;
            }
            const data: ActionMetadata = {
                nodeId: this.node?.id ?? '',
                appId: core.app.id,
                eventType: parsed.eventType as EventType,
                action: parsed.action as Action,
            };
            if (parsed.label) {
                data.label = parsed.label;
            }
            this.sendWebSocketMessage(data);
        } catch (err) {
            logger.error(err);
        }
    }

    protected nodeMetadata(): NodeMetadata {
        const data: NodeMetadata = {
            nodeId: this.node?.id ?? '',
            appId: core.app.id,
            type: this.node?.mimeType ?? '',
        };
        if (this.properties.has(SRC_PROPERTY)) {
            data.nodeSrc = this.properties.get(SRC_PROPERTY);
        }
        const props = this.parseProperties();
        if (props.length > 0) {
            data.properties = props;
        }
        return data;
    }

    protected publishTransitionMetadata(data: TransitionMetadata): void {
        if (!this.subscribed) {
            logger.error(`No MQTT topic prefix defined for device ${this.handle}`);
            return;
        }

        let topic = this.topicPrefix;
        if (data.label) {
            topic += `/${data.label}`;
        }
        topic += `/${data.eventType}Event`;
        if (data.eventType === EventType.selection) {
            topic += '/OK';
        }

        mqttClient.publish(`${topic}/eventNotification`, data.transition, false);
        if (data.user && data.eventType === EventType.selection) {
            mqttClient.publish(`${topic}/user`, data.user);
        }
        if (data.value && data.eventType === EventType.attribution) {
            mqttClient.publish(`${topic}/value`, data.value);
        }
    }

    // [:ifaceId/](presentation|preparation|selection|attribution)Event/[:key/]actionNotification
    protected parseTopic(m: string, t: string): Record<string, string> {
        const parts = t.split('/');
        if (parts.length < 2 || !t.includes('/actionNotification')) {
            throw new Error('Topic does not match expected structure');
        }

        const result: Record<string, string> = {};
        if (parts[0].includes('Event')) {
            this.parseEvent(parts, m, result);
        } else {
            this.parseInterface(parts, m, result);
        }
        return result;
    }

    protected parseInterface(parts: string[], m: string, result: Record<string, string>): void {
        const part = parts.shift() ?? '';
        if (!this.interfaceIds?.includes(part)) {
            throw new Error(`Unexpected interface id: ${part}`);
        }
        result['label'] = part;
        this.parseEvent(parts, m, result);
    }

    protected parseEvent(parts: string[], m: string, result: Record<string, string>): void {
        const part = parts.shift() ?? '';
        if (!part.includes('Event')) {
            throw new Error(`Should be an event, got ${part} instead`);
        }

        const eventType = part.replace('Event', '');
        if (!Object.values(EventType).includes(eventType as EventType)) {
            throw new Error(`Event ${eventType} does not match expected event types`);
        }
        result['eventType'] = eventType;

        if (eventType === EventType.selection) {
            this.parseKey(parts, m, result);
        } else {
            this.parseAction(parts, m, result);
        }
    }

    protected parseKey(parts: string[], m: string, result: Record<string, string>): void {
        result['key'] = parts.shift() ?? '';
        this.parseAction(parts, m, result);
    }

    protected parseAction(parts: string[], m: string, result: Record<string, string>): void {
        const part = parts.shift() ?? '';
        if (!part.match('actionNotification')) {
            throw new Error(`Expecting actionNotification, got ${parts[0]} instead`);
        }
        if (!Object.values(Action).includes(m as Action)) {
            throw new Error(`Action ${m} does not match expected actions`);
        }
        result['action'] = m;
    }

    // Keeps the interface ids of the node and subscribes the value of each
    // property.
    protected setNodeInterfaces(interfaces: string): void {
        const ifaces: NodeInterface[] = JSON.parse(interfaces);
        mqttClient.removeTopicHandler(`${this.topicPrefix}/interfaces`, this.setNodeInterfaces.bind(this));

        this.interfaceIds = [];
        this.properties.clear();
        for (const iface of ifaces) {
            this.interfaceIds.push(iface.id);
            if (iface.type === InterfaceType.property) {
                mqttClient.addTopicHandler(`${this.topicPrefix}/${iface.id}/attributionEvent/value`, this.setPropertyValue.bind(this));
            }
        }
    }

    protected setPropertyValue(m: string, t?: string): void {
        if (!t) {
            return;
        }
        const ifaceId = t.replace(`${this.topicPrefix}/`, '').replace('/attributionEvent/value', '');
        this.properties.set(ifaceId, m);
        mqttClient.removeTopicHandler(t, this.setPropertyValue.bind(this));
    }

    // Properties of the node, without the source.
    protected parseProperties(): PropertiesType {
        const props: PropertiesType = [];
        this.properties.forEach((value, key) => {
            if (key !== SRC_PROPERTY) {
                props.push({ name: key, value });
            }
        });
        return props;
    }

    protected onLocalClientConnection(lws: WebSocket): void {
        logger.info(`Local client connected to device ${this.handle}.`);
        this.lws = lws;
        lws.on('close', () => {
            logger.info(`Local client disconnected from device ${this.handle}.`);
        });
        lws.on('message', (message) => this.onLocalClientMessage(message));
        this.bridge = true;
    }

    protected onLocalClientMessage(message: RawData): void {
        const msg = message.toString();
        logger.debug(`Local client sent message ${msg} to device ${this.handle}.`);
        this.ws?.send(msg);
    }

    protected sendLocalClientMessage(msg: string): void {
        this.lws?.send(msg);
    }
}

// One stopped capability per supported type.
function capabilitiesOf(supportedTypes: string[]): DeviceCapabilities[] {
    return supportedTypes.map((sType) => ({
        effectType: sType as EffectType,
        state: 'stopped',
    }));
}
