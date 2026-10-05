// O processo do tv3ws-ssdp (src/ssdp-announcer.ts) so anuncia: sem Express,
// sem Redis, sem MQTT, sem porta TCP. A biblioteca SSDP e trocada por duble
// (nenhum pacote UDP e enviado); o resto e o modulo real. O node --test roda
// cada arquivo num processo proprio, entao o require.cache e so deste teste.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { EventEmitter } from 'events';

class FakeServer {
    static created: any[] = [];
    sockets: Record<string, EventEmitter> = {};
    constructor(opts: any) { FakeServer.created.push(opts); }
    addUSN() { /* nada */ }
    start() { return Promise.resolve(); }
    advertise() { /* nada */ }
}
const ssdpLib = require.resolve('@lvcabral/node-ssdp');
const m = new Module(ssdpLib);
m.filename = ssdpLib;
m.loaded = true;
m.exports = { __esModule: true, Server: FakeServer };
require.cache[ssdpLib] = m;

const exits: number[] = [];
const errors: string[] = [];
const realExit = process.exit;
const realConsoleError = console.error;
(process as any).exit = (code: number) => { exits.push(code); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
const sigtermBefore = process.listeners('SIGTERM');
const sigintBefore = process.listeners('SIGINT');
after(() => {
    (process as any).exit = realExit;
    console.error = realConsoleError;
    process.listeners('SIGTERM').filter(l => !sigtermBefore.includes(l)).forEach(l => process.removeListener('SIGTERM', l));
    process.listeners('SIGINT').filter(l => !sigintBefore.includes(l)).forEach(l => process.removeListener('SIGINT', l));
});

test('ssdp-announcer anuncia sem carregar Express, Redis, MQTT nem o app do tv3ws', async () => {
    for (const k of ['SSDP_ADVERTISE_HOST', 'SERVER_URL', 'EDGE_HTTP_PORT', 'EDGE_HTTPS_PORT', 'SSDP_INTERFACE']) delete process.env[k];
    process.env.SSDP_ADVERTISE_HOST = '192.168.1.150';
    process.env.SSDP_ENABLED = 'false';   // chega pelo env_file comum; aqui e ignorado

    require(path.join(__dirname, '..', 'src', 'ssdp-announcer'));
    await new Promise(r => setTimeout(r, 0));

    assert.deepEqual(exits, []);
    assert.equal(FakeServer.created.length, 1);
    assert.equal(FakeServer.created[0].location, 'http://192.168.1.150:44642/manifest');
    assert.ok(errors.some(e => e.includes('SSDP_ENABLED=false ignorado')), errors.join('\n'));

    const loaded = Object.keys(require.cache).map(f => f.replace(/\\/g, '/'));
    for (const banned of ['/node_modules/express/', '/node_modules/ioredis/', '/node_modules/mqtt/',
        '/src/app.', '/src/redis-client.', '/src/mqtt-client.', '/src/server.', '/src/api/']) {
        assert.ok(!loaded.some(f => f.includes(banned)), `${banned} carregado: ${loaded.filter(f => f.includes(banned)).join(', ')}`);
    }
    // nenhum servidor TCP aberto pelo processo
    const resources = (process as any).getActiveResourcesInfo?.() as string[] | undefined;
    if (resources) assert.ok(!resources.includes('TCPServerWrap'), resources.join(','));
});
