// D-0510-6 (reuniao 05/10 com o Joel): cliente Redis que falha rapido e de
// forma explicita. Usa o ioredis REAL contra uma porta fechada e contra um
// servidor TCP que aceita e nao responde (Redis congelado); sem Redis de
// verdade. O singleton do modulo e preguicoso (lazyConnect): importar nao
// abre socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net, { AddressInfo } from 'net';
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import redis, { FAIL_FAST_OPTIONS, redisOptions, logRedisEvents } from '../src/redis-client';
import { execOrThrow } from '../src/util/redis-result';

async function closedPort(): Promise<number> {
    const s = net.createServer().listen(0, '127.0.0.1');
    await new Promise(r => s.once('listening', r));
    const p = (s.address() as AddressInfo).port;
    await new Promise(r => s.close(r));
    return p;
}

async function elapsed(p: Promise<unknown>): Promise<{ ms: number; err?: Error }> {
    const t0 = Date.now();
    try { await p; return { ms: Date.now() - t0 }; }
    catch (err) { return { ms: Date.now() - t0, err: err as Error }; }
}

test('opcoes: limite por comando abaixo dos 2 s da borda, poucas tentativas, fila offline ligada', () => {
    const o = redisOptions();
    assert.equal(o.lazyConnect, true);
    assert.ok((o.commandTimeout ?? Infinity) < 2000);
    assert.equal(o.maxRetriesPerRequest, 1);
    assert.equal(o.enableOfflineQueue, true);
    assert.ok((o.connectTimeout ?? Infinity) <= 2000);
    assert.equal(redisOptions({ port: 1 }).port, 1);
    assert.equal(redis.status, 'wait', 'importar o modulo nao conecta');
    assert.deepEqual(Object.keys(FAIL_FAST_OPTIONS).sort(),
        ['commandTimeout', 'connectTimeout', 'enableOfflineQueue', 'maxRetriesPerRequest', 'retryStrategy']);
});

test('Redis fora do ar (porta fechada): o comando rejeita em menos de 1,5 s', async () => {
    const c = new Redis(redisOptions({ host: '127.0.0.1', port: await closedPort() }));
    c.on('error', () => undefined);
    try {
        const r = await elapsed(c.get('x'));
        assert.ok(r.err, 'esperava rejeicao');
        assert.ok(r.ms < 1500, `levou ${r.ms} ms`);
    } finally { c.disconnect(); }
});

test('Redis congelado (aceita e nao responde): o comando rejeita no commandTimeout', async () => {
    const accepted: net.Socket[] = [];
    const silent = net.createServer(s => { accepted.push(s); }).listen(0, '127.0.0.1');
    await new Promise(r => silent.once('listening', r));
    const port = (silent.address() as AddressInfo).port;
    const c = new Redis(redisOptions({ host: '127.0.0.1', port, enableReadyCheck: false }));
    c.on('error', () => undefined);
    try {
        const r = await elapsed(c.get('x'));
        assert.match(r.err?.message ?? '', /timed out/i);
        assert.ok(r.ms >= 1400 && r.ms < 2000, `levou ${r.ms} ms`);
    } finally {
        c.disconnect();
        accepted.forEach(s => s.destroy());
        await new Promise<void>(r => silent.close(() => r()));
    }
});

test('log de eventos: primeira falha de cada sequencia, perda de conexao e recuperacao', () => {
    const ev = new EventEmitter();
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (m: string) => { lines.push(`LOG ${m}`); };
    try {
        logRedisEvents(ev as unknown as Redis, 'h:1', m => lines.push(m));
        ev.emit('error', new Error('connect ECONNREFUSED'));
        ev.emit('error', new Error('connect ECONNREFUSED'));   // repetida: nao loga de novo
        ev.emit('ready');
        ev.emit('close');
        ev.emit('end');
    } finally { console.log = realLog; }
    assert.deepEqual(lines, [
        '[redis] ERRO em h:1: connect ECONNREFUSED',
        'LOG [redis] pronto em h:1 (restabelecido apos 2 falha(s))',
        '[redis] conexao com h:1 perdida; comandos falham com erro ate reconectar',
        '[redis] cliente de h:1 encerrado; sem novas tentativas',
    ]);
});

test('execOrThrow: devolve os valores; rejeita no primeiro erro de entrada', async () => {
    const ok = { exec: async () => [[null, 1], [null, 'a']] as [Error | null, unknown][] };
    assert.deepEqual(await execOrThrow(ok), [1, 'a']);
    const bad = { exec: async () => [[null, 1], [new Error('conexao perdida'), null]] as [Error | null, unknown][] };
    await assert.rejects(execOrThrow(bad), /conexao perdida/);
    await assert.rejects(execOrThrow({ exec: async () => null }), /abortada/);
});
