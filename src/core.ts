import * as dotenv from "dotenv";
import os from 'os';
import logger from './logger';
import mqttClient, { TOPICS, client } from "./mqtt-client";
import { AppNode } from "./modules/remotedevice-manager/remote-device";
import { associateAppNodes, disassociateAppNodes } from "./modules/remotedevice-manager/manager";
import * as redisFunctions from './redis-functions';
import { integerServiceId } from './util/service-id';
dotenv.config();

type CoreData = {
  server: {
    url: string;
    localIP: string;
  };
  app: {
    sid: string;
    id: string;
    url: string;
    nodes: AppNode[];
  };
  // aop/services (infra/mqtt-broker/plugin/config/schemas.json)
  services: {
    serviceContextId: string;
  }[];
  current: {
    serviceName: string;
    serviceId: number;
    serviceContextId: string;
    transportStreamId: string;
    originalNetworkId: string;
  };
};

const data: CoreData = {
  server: {
    url: process.env.SERVER_URL as string,
    localIP: getLocalIP()
  },
  app: {
    sid: "",
    id: "",
    url: "",
    nodes: [],
  },
  services: [],
  current: {
    serviceName: "",
    serviceId: -1,
    // globalServiceId of the current service (Table 6, C.3.5), set in
    // currentService.
    serviceContextId: "",
    transportStreamId: "c08b2c72-fd14-4095-adaf-2e5810850c57",
    originalNetworkId: "09e59a1d-e2e7-467e-85db-2fb5a572e2fc",
  },
};

function getLocalIP(): string {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      const ifaceList = interfaces[name];
      if (!ifaceList) continue;

      for (const iface of ifaceList) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
}

// aop/<sid>/currentApp carries the current appId, retained; an empty message
// is the end of the application. Changing or ending it clears app.url, the
// directory C.6.4.7 reads from, so that the one of the previous application
// is not served; without a directory, 305.
function setAppId(appid: string): void {
  if (data.app.id == appid) return;

  if (data.app.sid && data.app.id) {
    let t = mqttClient.parseTopic(TOPICS.app_path, {
      serviceId: data.app.sid,
      appId: data.app.id,
    });
    mqttClient.removeTopicHandler(t, setAppBaseURL);

    t = mqttClient.parseTopic(TOPICS.app_nodes, {
      serviceId: data.app.sid,
      appId: data.app.id,
    });
    mqttClient.removeTopicHandler(t, setAppNodes);
  }

  data.app.url = "";

  if (appid) {
    let t = mqttClient.parseTopic(TOPICS.app_path, {
      serviceId: data.app.sid,
      appId: appid,
    });
    mqttClient.addTopicHandler(t, setAppBaseURL);

    t = mqttClient.parseTopic(TOPICS.app_nodes, {
      serviceId: data.app.sid,
      appId: appid,
    });
    mqttClient.addTopicHandler(t, setAppNodes);
  }

  data.app.id = appid;
}

function setAppBaseURL(path: string): void {
  if (!path) return;

  data.app.url = path;
}

function setAppNodes(nodes: string) {
  if (nodes) {
    data.app.nodes = JSON.parse(nodes);
    associateAppNodes();
  }
  else {
    disassociateAppNodes();
  }
}

function currentService(sid: string): void {
  if (sid == data.app.sid) return;

  if (data.app.sid) {
    let t = mqttClient.parseTopic(TOPICS.current_app, {
      serviceId: data.app.sid,
    });
    mqttClient.removeTopicHandler(t, setAppId);

    if (data.app.id) {
      let t = mqttClient.parseTopic(TOPICS.app_path, {
        serviceId: data.app.sid,
        appId: data.app.id,
      });
      mqttClient.removeTopicHandler(t, setAppBaseURL);

      t = mqttClient.parseTopic(TOPICS.app_nodes, {
        serviceId: data.app.sid,
        appId: data.app.id,
      });
      mqttClient.removeTopicHandler(t, setAppNodes);
    }
  }
  if (sid) {
    let t = mqttClient.parseTopic(TOPICS.current_app, { serviceId: sid });
    mqttClient.addTopicHandler(t, setAppId);
  }

  data.app.sid = sid;
  data.app.id = "";
  data.app.url = "";
  data.app.nodes = [];
  // Without an SLT there is no serviceId or serviceName: aop/services carries
  // only the serviceContextId.
  data.current.serviceId = -1;
  data.current.serviceName = '';
  data.current.serviceContextId = sid;
  // Without a current service the session hash stays as it was: the schema
  // requires serviceContextId.
  if (!sid) return;

  // tv30_session_service rewrites the whole hash and checks the schema.
  // serviceId: a decimal integer or empty (Table C.8).
  const serviceId = integerServiceId(data.current.serviceId);
  redisFunctions.sessionService({
    serviceContextId: data.current.serviceContextId,
    serviceId: serviceId === undefined ? '' : String(serviceId),
    serviceName: data.current.serviceName ?? '',
    transportStreamId: data.current.transportStreamId,
    originalNetworkId: data.current.originalNetworkId,
  }).catch((err: Error) => logger.error(`[Redis] Failed to persist session:current-service: ${err.message}`));
}

mqttClient.addTopicHandler(TOPICS.current_service, currentService);

// The services announced in the LLS, retained; an empty message deletes the
// retained one: no service.
function loadServiceData(m: string): void {
  let list: unknown = [];
  try {
    if (m) list = JSON.parse(m);
  } catch (err) {
    logger.error(`[MQTT] ${TOPICS.services} ignorado: ${(err as Error).message}`);
    return;
  }
  data.services = Array.isArray(list)
    ? list.filter((s): s is { serviceContextId: string } => typeof s?.serviceContextId === 'string')
    : [];
}

mqttClient.addTopicHandler(TOPICS.services, loadServiceData);

const _t = {
    yesno_popup: 'aop/display/layers/popup/yesno',
    qrcode_popup: 'aop/display/layers/popup/qrcode',
    pin_popup: 'aop/display/layers/popup/pin',
};

type subscribeFunction = (m: string, t: string) => void;
const _topics: Map<string, subscribeFunction> = new Map([
]);

function subscribeToTopicList() {
    _topics.forEach((_, key) => {
        client.subscribe(key, { qos : 1, nl : true });
        logger.debug(`Subscribed to topic ${key} at startup`);
    });
}

function subscribe(topic: string, callback: subscribeFunction): void {
    _topics.set(topic, callback);
    client.subscribe(topic, { qos : 1, nl : true });
    logger.debug(`Subscribed to topic ${topic}`);
}

function unsubscribe(topic: string) {
    _topics.delete(topic);
    client.unsubscribe(topic);
    logger.debug(`Unsubscribed from topic ${topic}`);
}

function mqttTopicMatch(topic: string, filter: string): boolean {
    let filterregex = filter.split('/').map(level => {
        if (level === '+') {
            return '[^/#+]+';
        } else if (level === '#') {
            return '.*';
        } else {
            return level.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }).join('/');

    let regex = new RegExp(`^${filterregex}$`);
    return regex.test(topic);
}

client.on('message', (topic, message) => {
    logger.debug(`Received message ${message.toString()} in topic ${topic}`);
    
    let found = false;
    _topics.forEach((handler, filter) => {
        if (mqttTopicMatch(topic, filter)) {
            handler(message.toString(), topic);
            found = true;
            return;
        }
    });

    if (!found) {
        logger.debug(`No handler for topic ${topic}`);
    }
});

export function showYesNoPopUpAsync(message: string, timeout: number = 1000): Promise<boolean> {
    logger.info(`Calling Yes/No popup with message:\n${message}\nTimeout in ${timeout}ms`);
    const messageTopic = _t.yesno_popup + '/message';
    const responseTopic = _t.yesno_popup + '/response';

    return new Promise((resolve) => {
        const wrapup = (b: boolean) => {
            unsubscribe(responseTopic);
            resolve(b);
        }
        
        const timeoutId = setTimeout(() => {
            logger.debug('Timeout for popup');
            wrapup(false);
        }, timeout);
        
        const callback: subscribeFunction = (m: string, _) => {
            logger.debug(`Received response ${m} for Yes/No popup`);
            clearTimeout(timeoutId);
            // Only "true" authorizes (Boolean("false") is true).
            wrapup(m.trim() === "true");
        };
        subscribe(responseTopic, callback);
        const msg = JSON.stringify({ value: message, timeout: timeout });
        client.publish(messageTopic, msg);
    });
}

export function showQRCodePopUp(code: string, timeout: number) {
    logger.info(`Calling QRCode popup with code:\n${code}\nTimeout in ${timeout}ms`);
    const msg = JSON.stringify({ value: code, timeout: timeout });
    client.publish(_t.qrcode_popup, msg);
}

export function showPINPopUp(pin: string, timeout: number) {
    logger.info(`Calling PIN popup with pin:\n${pin}\nTimeout in ${timeout}ms`);
    const msg = JSON.stringify({ value: pin, timeout: timeout });
    client.publish(_t.pin_popup, msg);
}

// End of the pairing (C.4.3.2, C.4.3.3): {"close":true} on the topic of the
// pop-up. Same client, topic and QoS as the opening, so MQTT keeps the
// order.
const closePopUpMessage = JSON.stringify({ close: true });

export function closeQRCodePopUp() {
    logger.info('Closing QRCode popup');
    client.publish(_t.qrcode_popup, closePopUpMessage);
}

export function closePINPopUp() {
    logger.info('Closing PIN popup');
    client.publish(_t.pin_popup, closePopUpMessage);
}

export default data;
