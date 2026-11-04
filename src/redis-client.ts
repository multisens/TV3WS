import Redis, { RedisOptions } from 'ioredis';
import * as dotenv from 'dotenv';
dotenv.config();

// ioredis options so that a Redis failure fails fast: connection and command
// timeouts, one retry per request; the offline queue lets the commands of the
// boot and of a short reconnection wait for the connection.
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
        // The connection opens at boot (connectRedis) or on the first command:
        // importing the module opens no socket.
        lazyConnect: true,
        ...FAIL_FAST_OPTIONS,
        ...overrides,
    };
}

// Logs the connection events: ready, loss, failures (the first of each
// sequence, and the total on recovery) and end.
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

// Opens the connection at boot. A failure of the first attempt is logged
// ('error') and ioredis keeps trying; the rejection is ignored.
export function connectRedis(): void {
    if (redis.status === 'wait') redis.connect().catch(() => undefined);
}

// Runs a boot task that needs Redis (mirror cleanup, migration) once, on the
// first 'ready'. A failure is logged with the name of the task.
export function whenRedisReady(name: string, task: () => Promise<unknown>): void {
    const run = () => {
        task().catch((err: Error) => console.error(`[redis] FALHA na tarefa de boot "${name}": ${err?.message}`));
    };
    if (redis.status === 'ready') run();
    else redis.once('ready', run);
}

export default redis;
