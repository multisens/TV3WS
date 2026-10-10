import Redis, { RedisOptions } from 'ioredis';
import * as dotenv from 'dotenv';
dotenv.config();

// D-0510-6 (reuniao 05/10 com o Joel): falha de Redis nao pode ser
// silenciosa nem travar a API. Com o padrao do ioredis (20 tentativas por
// comando, sem limite de tempo) um comando esperava ~10 s com o Redis fora
// do ar e indefinidamente com o Redis congelado (medido em 09/10). Agora:
// - maxRetriesPerRequest 1: o comando enfileirado sem conexao falha apos
//   uma nova tentativa de conexao sem sucesso (~0,2 a 1 s, medido);
// - commandTimeout 1500 ms: limite por comando, inclusive com o Redis
//   aceitando conexao e nao respondendo (docker pause); fica abaixo dos 2 s
//   de espera padrao da borda, entao quem responde o 404 {error:200} e o
//   proprio tv3ws (errorHandler, C.3.2);
// - connectTimeout 2000 ms: tentativa de conexao a host que nao responde;
// - fila offline LIGADA: comandos do boot e de uma reconexao curta esperam a
//   conexao em vez de falhar na hora; o limite acima impede espera longa.
//   (Com a fila desligada, todo comando antes do 'ready' falharia.)
// O cliente continua tentando reconectar (retryStrategy) e volta sozinho.
export const FAIL_FAST_OPTIONS = {
    connectTimeout: 2000,
    commandTimeout: 1500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
} satisfies RedisOptions;

export function redisOptions(overrides: RedisOptions = {}): RedisOptions {
    return {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        // a conexao abre no boot (server.ts, connectRedis) ou no primeiro
        // comando: importar o modulo (testes) nao abre socket
        lazyConnect: true,
        ...FAIL_FAST_OPTIONS,
        ...overrides,
    };
}

// Log explicito de conexao: pronto, perda, falhas (a primeira de cada
// sequencia, e o total ao voltar) e encerramento.
export function logRedisEvents(client: Redis, where: string, log: (msg: string) => void = console.error): void {
    let wasReady = false;
    let failures = 0;
    let lastError = '';
    client.on('ready', () => {
        console.log(`[redis] pronto em ${where}` + (failures ? ` (restabelecido apos ${failures} falha(s))` : ''));
        wasReady = true;
        failures = 0;
        lastError = '';
    });
    client.on('error', (err: Error) => {
        failures++;
        if (err.message !== lastError) log(`[redis] ERRO em ${where}: ${err.message}`);
        lastError = err.message;
    });
    client.on('close', () => {
        if (wasReady) log(`[redis] conexao com ${where} perdida; comandos falham com erro ate reconectar`);
        wasReady = false;
    });
    client.on('end', () => log(`[redis] cliente de ${where} encerrado; sem novas tentativas`));
}

const options = redisOptions();
const redis = new Redis(options);
logRedisEvents(redis, `${options.host}:${options.port}`);

// Abre a conexao no boot. A falha da primeira tentativa ja sai no log
// ('error') e o ioredis segue tentando; nada a fazer com a rejeicao.
export function connectRedis(): void {
    if (redis.status === 'wait') redis.connect().catch(() => undefined);
}

// Tarefa de boot que precisa do Redis (limpeza de espelho, migracao): roda
// UMA vez, no primeiro 'ready'. Falha vai para o log com o nome da tarefa.
export function whenRedisReady(name: string, task: () => Promise<unknown>): void {
    const run = () => {
        task().catch((err: Error) => console.error(`[redis] FALHA na tarefa de boot "${name}": ${err?.message}`));
    };
    if (redis.status === 'ready') run();
    else redis.once('ready', run);
}

export default redis;
