import http from "http";
import https from "https";
import { WebSocketServer } from "ws";
import { ApiError } from "../../util";
import { TlsMaterial, tlsMaterial, wsTls } from "../../tls";

// Ponto de entrada WebSocket: o do dispositivo remoto, aberto no registro (C.6.15.2, "socket server on a
// dynamically assigned port"), e o local, da listagem 2.0 (C.6.15.5) ou da rota por handle (extensao do
// testbed, so na 100.0). Porta ocupada sorteia outra; esgotadas as tentativas, 404 {error:200} (Tabela C.76).
// A porta so e entregue escutando.
export const LISTEN_ATTEMPTS = 10;

export function generateDynamicallyPort(): number {
  const min = parseInt(process.env.WS_PORT_MIN || '1000');
  const max = parseInt(process.env.WS_PORT_MAX || '9999');
  return Math.floor(min + Math.random() * (max - min));
}

function listen(server: http.Server | https.Server, port: number): Promise<void> {
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

// O do dispositivo remoto, com o certificado do receptor quando ha: wss:// (Tabela C.76).
export function openRemoteDeviceEntryPoint(): Promise<WebSocketServer> {
  return openEntryPoint(wsTls() ? tlsMaterial() : undefined);
}

// O local sai sempre em ws://, no esquema do Server-BaseURL (HTTP) que o cliente local ja usa; o wss:// da
// Tabela C.80 nao e seguido.
export function openLocalEntryPoint(): Promise<WebSocketServer> {
  return openEntryPoint(undefined);
}

// esquema pelo servidor que de fato escuta
export function entryPointUrl(wss: WebSocketServer, host: string): string {
  const scheme = wss.options.server instanceof https.Server ? "wss" : "ws";
  return `${scheme}://${host}:${wss.options.port}`;
}

async function openEntryPoint(t: TlsMaterial | undefined): Promise<WebSocketServer> {
  for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt++) {
    const port = generateDynamicallyPort();
    const server = t ? https.createServer({ key: t.key, cert: t.cert }) : http.createServer();
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

// fecha tambem o http.Server: o ws so fecha o servidor que ele mesmo cria
export function closeEntryPoint(wss: WebSocketServer): void {
  const server = wss.options.server;
  for (const client of wss.clients) client.close(1001);
  wss.close();
  if (server?.listening) server.close();
}
