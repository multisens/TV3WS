import os from 'os';
import { Socket } from 'dgram';
import { Server } from '@lvcabral/node-ssdp';
import logger from './logger';
import {
  SSDP_ST, AdvertisedEndpoint, resolveAdvertisedEndpoint, locationURL, advertiseWarnings,
} from './ssdp-config';
import {
  Interfaces, InterfaceChoice, chooseInterface, readDefaultRouteInterface,
} from './ssdp-interface';

// Anuncio SSDP (C.3.4): modulo reutilizavel, sem Express, Redis nem MQTT.
// L6 decidida = opcao B (informado pelo Luis em 04/10). Dois chamadores:
//  - src/ssdp-announcer.ts: processo que so anuncia (container tv3ws-ssdp do
//    compose, em rede do host); a falha dele derruba so ele;
//  - src/server.ts: o tv3ws rodando sozinho no host (cenario dev-host 1),
//    quando SSDP_ENABLED nao e false/0; a falha derruba o tv3ws inteiro.
// O /manifest, para onde aponta o LOCATION, fica no tv3ws (src/manifest.ts).

const DEFAULT_UDN = 'uuid:TV30-1234-5678-9012-345678901234';

// Tempo para o ssdp:byebye sair antes de encerrar (o envio UDP e assincrono).
const BYEBYE_GRACE_MS = 300;

// D9 (morre-inteiro): o SSDP nao pode morrer em silencio com o resto do
// processo de pe. Em falha, log claro e exit 1 — o container tem restart.
export function fatal(what: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[ssdp] FALHA em ${what}: ${msg} — encerrando o processo (descoberta SSDP e parte do servico)`);
  process.exit(1);
}

// Liga/desliga o anuncio dentro do tv3ws: desligado so com false/0. Ausente
// liga (tv3ws sozinho no host); o compose poe "false" no tv3ws da bridge.
export function ssdpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SSDP_ENABLED ?? '').trim().toLowerCase();
  return v !== 'false' && v !== '0';
}

// Resolvido uma vez no boot: LOCATION, Server-BaseURL e Server-SecureBaseURL
// saem do mesmo valor. Porta da borda invalida derruba o processo (D9).
export function loadAdvertisedEndpoint(env: NodeJS.ProcessEnv = process.env): AdvertisedEndpoint {
  let endpoint: AdvertisedEndpoint;
  try {
    endpoint = resolveAdvertisedEndpoint(env);
  } catch (err) {
    return fatal('configuracao do anuncio (EDGE_HTTP_PORT/EDGE_HTTPS_PORT)', err);
  }
  // logger.error: o nivel padrao (LOG_LEVEL=ERROR) esconderia info/debug.
  for (const warning of advertiseWarnings(endpoint)) {
    logger.error(`[ssdp] AVISO ${warning}`);
  }
  return endpoint;
}

// Leitura do sistema, trocada por dubles nos testes.
export type NetInfo = {
  interfaces(): Interfaces;
  defaultRoute(): string | undefined;
};
const systemNet: NetInfo = {
  interfaces: () => os.networkInterfaces(),
  defaultRoute: () => readDefaultRouteInterface(),
};

function describeChoice(c: InterfaceChoice): string {
  return c.name
    ? `pela interface ${c.name} (${c.addresses.join(', ')}, via ${c.source})`
    : `por todas as interfaces IPv4 (${c.addresses.join(', ') || 'nenhuma'})`;
}

export function startSSDP(
  endpoint: AdvertisedEndpoint,
  env: NodeJS.ProcessEnv = process.env,
  netInfo: NetInfo = systemNet,
): Server {
  let choice: InterfaceChoice;
  try {
    choice = chooseInterface(endpoint.host, env, netInfo.interfaces(), netInfo.defaultRoute);
  } catch (err) {
    return fatal('escolha da interface do anuncio (SSDP_INTERFACE)', err);
  }
  for (const warning of choice.warnings) {
    logger.error(`[ssdp] AVISO ${warning}`);
  }

  const ssdpServer = new Server({
    location: locationURL(endpoint),
    udn: env.UDN || DEFAULT_UDN,
    ssdpPort: 1900,
    reuseAddr: true,
    adInterval: 10000,
    ttl: 4,
    // um socket so por interface escolhida (sem duplicatas); ausente = todas
    ...(choice.name ? { interfaces: [choice.name] } : {}),
  });
  ssdpServer.addUSN(SSDP_ST);

  // Falhas da biblioteca que antes passavam em silencio:
  //  - sem interface IPv4 externa ("No sockets available"): a promessa de
  //    start() rejeita (bluebird so imprimia "Unhandled rejection");
  //  - erro de socket (ex.: bind da 1900 recusado): a biblioteca so loga em
  //    debug e o anuncio nunca comeca.
  // A falha de addMembership ja derrubava o processo (excecao nao tratada
  // dentro da biblioteca), entao nao e silenciosa.
  //
  // Com interface escolhida, o NOTIFY multicast sai por ela: a biblioteca so
  // entra no grupo pela interface (addMembership) e deixa a saida para a
  // tabela de rotas, que levaria o NOTIFY pela rota padrao.
  function watchSockets(): void {
    const sockets = (ssdpServer as unknown as { sockets?: Record<string, Socket> }).sockets ?? {};
    for (const [address, socket] of Object.entries(sockets)) {
      socket.on('error', (err) => fatal(`socket UDP 1900 (${address})`, err));
      if (choice.name) {
        socket.once('listening', () => {
          try {
            socket.setMulticastInterface(address);
          } catch (err) {
            fatal(`interface de saida do multicast (${address})`, err);
          }
        });
      }
    }
  }

  // Depois do byebye nao pode sair ssdp:alive (max-age=1800) na folga ate o
  // exit. O laco da biblioteca (setInterval de adInterval) e o primeiro
  // anuncio (setTimeout de 3 s apos o bind) chamam advertise() desta
  // instancia, entao a guarda fica nela e cobre os dois. stop() nao serve:
  // fecha os sockets na hora e pode descartar o byebye.
  let stopping = false;
  const libAdvertise = ssdpServer.advertise.bind(ssdpServer);
  ssdpServer.advertise = (alive?: boolean): void => {
    if (stopping && alive !== false) return;
    libAdvertise(alive);
  };

  function sendByeAndExit(signal: NodeJS.Signals, code: number): void {
    if (stopping) return;
    stopping = true;
    // logger.error: a parada tem de aparecer no nivel padrao (LOG_LEVEL=ERROR).
    logger.error(`[ssdp] ${signal}: enviando ssdp:byebye`);
    try {
      ssdpServer.advertise(false);
    } catch (err) {
      logger.error(`[ssdp] byebye nao enviado: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => process.exit(code), BYEBYE_GRACE_MS);
  }

  let started: void | Promise<void>;
  try {
    started = ssdpServer.start();
  } catch (err) {
    return fatal('inicio do anunciante', err);
  }
  watchSockets();

  // logger.error: o estado do anuncio tem de aparecer no nivel padrao.
  Promise.resolve(started).then(
    () => logger.error(`[ssdp] anunciando ${SSDP_ST} em UDP 1900 ${describeChoice(choice)}; `
      + `LOCATION ${locationURL(endpoint)} (host via ${endpoint.source})`),
    (err) => fatal('inicio do anunciante (bind UDP 1900)', err),
  );

  process.once('SIGTERM', () => sendByeAndExit('SIGTERM', 143));
  process.once('SIGINT', () => sendByeAndExit('SIGINT', 130));

  return ssdpServer;
}
