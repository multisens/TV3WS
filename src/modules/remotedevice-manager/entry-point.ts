import http from "http";
import { WebSocketServer } from "ws";
import { ApiError } from "../../util";

// Ponto de entrada WebSocket de um remote-device (C.6.15.2: "it opens a
// socket server on a dynamically assigned port") e o ponto de entrada local
// da C.6.15.5 (versao 2.0) e da ativacao por handle (versao 2.1, a "C.6.15.6"
// da proposta do Forum em api/multi-device/index.ts; o PDF da norma vai so ate
// a C.6.15.5): um http.Server proprio numa porta sorteada em
// [WS_PORT_MIN, WS_PORT_MAX), com o WebSocketServer pendurado nele.
//
// - Porta ocupada (EADDRINUSE) nao derruba mais o processo: antes o listen
//   nao tinha tratador de 'error', e a excecao nao capturada matava o tv3ws
//   inteiro. Agora sorteia outra porta, ate LISTEN_ATTEMPTS vezes; esgotadas
//   as tentativas, a API responde 404 {error:200} (Tabela C.74: "If the
//   request exceeds the number of devices that can be registered on the
//   platform"). Outro erro de listen (ex.: EACCES) tambem vira {error:200}.
// - A porta so e entregue escutando: a URL devolvida e gravada e a da porta
//   que de fato abriu.
// - closeEntryPoint fecha tambem o http.Server: o ws so fecha o servidor que
//   ele mesmo cria, e com servidor externo a porta ficava escutando depois do
//   terminate() do dispositivo.
export const LISTEN_ATTEMPTS = 10;

export function generateDynamicallyPort(): number {
  const min = parseInt(process.env.WS_PORT_MIN || '1000');
  const max = parseInt(process.env.WS_PORT_MAX || '9999');
  return Math.floor(min + Math.random() * (max - min));
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

export async function openEntryPoint(): Promise<WebSocketServer> {
  for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt++) {
    const port = generateDynamicallyPort();
    const server = http.createServer();
    try {
      await listen(server, port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`[remote-device] porta ${port} ocupada (EADDRINUSE); sorteando outra (tentativa ${attempt}/${LISTEN_ATTEMPTS})`);
        continue;
      }
      throw err;
    }
    const wsServer = new WebSocketServer({ server });
    wsServer.options.port = port;
    // o ws repassa ao WebSocketServer os erros do http.Server; sem ouvinte,
    // um erro tardio derrubaria o processo
    wsServer.on("error", (err: Error) => console.error(`[remote-device] erro no ponto de entrada da porta ${port}: ${err.message}`));
    console.log(`WebSocket server is running on port ${port}`);
    return wsServer;
  }
  throw new ApiError(200, `no free port for a WebSocket entry point after ${LISTEN_ATTEMPTS} attempts`);
}

export function closeEntryPoint(wss: WebSocketServer): void {
  const server = wss.options.server;
  for (const client of wss.clients) client.close(1001);
  wss.close();
  if (server?.listening) server.close();
}
