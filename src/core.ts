import * as dotenv from "dotenv";
import os from 'os';
import logger from './logger';
import mqttClient, { TOPICS, client } from "./mqtt-client";
import { AppNode } from "./modules/remotedevice-manager/remote-device";
import { associateAppNodes, disassociateAppNodes } from "./modules/remotedevice-manager/manager";
import * as funcoes from './redis-funcoes';
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
  services: {
    serviceId: number;
    serviceName: string;
    serviceIcon: string;
    initialMediaURL: string;
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
    serviceContextId: "c08b2c72-fd14-4095-adaf-2e5810850c57",
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

// Correcao de 12/10 (spec-1210-defeitos3, item 1): trocar de aplicacao (ou
// encerrar a corrente) zera core.app.url, o diretorio de onde a C.6.4.7
// (GET /tv3/current-service/apps/<appId>/files) le os arquivos. Antes, a
// nova aplicacao servia o diretorio da anterior ate chegar o
// aop/<sid>/<appId>/path dela, e a mensagem vazia em aop/<sid>/currentApp
// era ignorada (a aplicacao encerrada seguia corrente, com o diretorio
// dela). Sem diretorio conhecido a C.6.4.7 responde 305 (ver o PENDENTE em
// api/aop-communication/app-files/service.ts).
// Encerrar = mensagem vazia em aop/<sid>/currentApp (o que o broker entrega
// quando o retido e apagado). PENDENTE (Joel): nao ha publicador desse topico
// neste repositorio, e o contrato dele (como se sinaliza o fim da aplicacao)
// nao esta escrito; vale a mensagem vazia, como nos outros topicos do testbed
// em que '' e ausencia. Os nos (core.app.nodes) ficam como estavam: fora
// desta correcao.
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

  // o diretorio era o da aplicacao anterior; o da nova chega pelo .../path
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

  if (data.app.sid && data.app.id) {
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
  data.current.serviceId = data.services[Number(sid)]?.serviceId;
  data.current.serviceName = data.services[Number(sid)]?.serviceName;

  // P4 (Luis, 10/10): regravado inteiro pela funcao tv30_sessao_servico, que
  // confere o esquema (infra/redis/esquema.json). serviceId so inteiro em
  // decimal ou vazio (Tabela C.8; mesma regra da resposta da C.6.3.1): antes
  // ia o texto que viesse em aop/services ("-1", "1.5"...).
  const serviceId = integerServiceId(data.current.serviceId);
  funcoes.sessaoServico({
    serviceContextId: data.current.serviceContextId,
    serviceId: serviceId === undefined ? '' : String(serviceId),
    serviceName: data.current.serviceName ?? '',
    transportStreamId: data.current.transportStreamId,
    originalNetworkId: data.current.originalNetworkId,
  }).catch((err: Error) => logger.error(`[Redis] Failed to persist session:current-service: ${err.message}`));
}

mqttClient.addTopicHandler(TOPICS.current_service, currentService);

function loadServiceData(m: string): void {
  if (!m) return;

  data.services = JSON.parse(m);
}

mqttClient.addTopicHandler(TOPICS.services, loadServiceData);

const _t = {
    yesno_popup: 'aop/display/layers/popup/yesno',
    qrcode_popup: 'aop/display/layers/popup/qrcode',
    pin_popup: 'aop/display/layers/popup/pin',
};

type subscribeFunction = (m: string, t: string) => void;
const _topics: Map<string, subscribeFunction> = new Map([
    // [_t.yesno_popup, yesNoPopUpResponse]
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
            // so "true" autoriza: a AoP publica "false" no "Nao" e no timeout do
            // pop-up (aop/public/js/popup.js) e Boolean("false") === true
            // autorizava justamente o cliente recusado pelo espectador.
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

// Fechamento do pop-up de pareamento no fim do pareamento (C.4.3.2,
// C.4.3.3; correcao de 12/10, spec-1210-defeitos item 1 — quem chama e
// api/client-identification/service.ts, endPairing). Contrato com o AoP: no
// MESMO topico do pop-up, {"close":true}; a camada grafica
// (aop/public/js/popup.js) fecha o pop-up aberto daquele tipo e ignora a
// mensagem se o pop-up na tela for de outro tipo ou se nao houver pop-up.
// Abertura e fechamento saem deste cliente no mesmo topico e com a mesma QoS,
// e o MQTT os entrega a quem assina nessa ordem.
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
