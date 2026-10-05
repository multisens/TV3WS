// Teste do ciclo de vida do anunciante SSDP (D9/D10) sem rede: a biblioteca
// @lvcabral/node-ssdp e as interfaces de rede sao trocadas por dubles;
// process.exit e console.error sao capturados. Nenhum pacote UDP e enviado.
// O /manifest tem teste proprio (test/manifest.test.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { EventEmitter } from 'events';
import type { NetworkInterfaceInfo } from 'os';

// --- dubles ----------------------------------------------------------------
let mode: 'resolve' | 'reject' | 'throw' = 'resolve';

class FakeSocket extends EventEmitter {
    multicastInterface?: string;
    setMulticastInterface(a: string) { this.multicastInterface = a; }
}

class FakeServer {
    static last: FakeServer | undefined;
    opts: any;
    usns: string[] = [];
    sockets: Record<string, FakeSocket> = {};
    advertised: Array<boolean | undefined> = [];
    constructor(opts: any) { this.opts = opts; FakeServer.last = this; }
    addUSN(u: string) { this.usns.push(u); }
    start() {
        this.sockets = { '192.168.1.150': new FakeSocket() };
        if (mode === 'throw') throw new Error('sincrono');
        return mode === 'reject' ? Promise.reject(new Error('No sockets available, cannot start.')) : Promise.resolve();
    }
    advertise(alive?: boolean) { this.advertised.push(alive); }
    stop() { /* nada */ }
}

function stubFile(file: string, exports: object): void {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
stubFile(require.resolve('@lvcabral/node-ssdp'), { Server: FakeServer });

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ssdp = require(path.join(__dirname, '..', 'src', 'ssdp-server')) as typeof import('../src/ssdp-server');

const v4 = (address: string, internal = false) =>
    ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;
// maquina em rede do host com docker: eth0 na LAN, docker0 e uma bridge
const hostNet = {
    interfaces: () => ({ lo: [v4('127.0.0.1', true)], eth0: [v4('192.168.1.150')], docker0: [v4('172.17.0.1')], 'br-1': [v4('172.20.0.1')] }),
    defaultRoute: () => 'eth0',
};
const noRouteNet = { interfaces: hostNet.interfaces, defaultRoute: () => undefined };

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const reset = () => { exits.length = 0; errors.length = 0; mode = 'resolve'; FakeServer.last = undefined; };
const endpoint = (env: NodeJS.ProcessEnv) => ssdp.loadAdvertisedEndpoint(env);

// --- casos -------------------------------------------------------------------

test('anuncio aponta para a borda (44642) e sai so pela interface do host anunciado', async () => {
    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), {}, hostNet);
    const s = FakeServer.last!;
    assert.equal(s.opts.location, 'http://192.168.1.150:44642/manifest');
    assert.deepEqual(s.opts.interfaces, ['eth0']);
    assert.equal(s.opts.udn, 'uuid:TV30-1234-5678-9012-345678901234');
    assert.deepEqual(s.usns, ['urn:schemas-sbtvd-org:service:TV3.0WebServices:1']);
    await tick();
    assert.ok(errors.some(e => e.includes('[ssdp] anunciando') && e.includes('interface eth0')
        && e.includes('http://192.168.1.150:44642/manifest')), errors.join('\n'));
});

test('SSDP_ADVERTISE_HOST tem precedencia sobre SERVER_URL; UDN vem do ambiente', () => {
    reset();
    ssdp.startSSDP(endpoint({ SSDP_ADVERTISE_HOST: '172.17.0.1', SERVER_URL: 'localhost' }), { UDN: 'uuid:outro' }, hostNet);
    assert.equal(FakeServer.last!.opts.location, 'http://172.17.0.1:44642/manifest');
    assert.deepEqual(FakeServer.last!.opts.interfaces, ['docker0']);
    assert.equal(FakeServer.last!.opts.udn, 'uuid:outro');
});

test('host de loopback (padrao do compose) => AVISO de loopback e anuncio pela rota padrao, com aviso', () => {
    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: 'localhost' }), {}, hostNet);
    assert.equal(FakeServer.last!.opts.location, 'http://localhost:44642/manifest');
    assert.deepEqual(FakeServer.last!.opts.interfaces, ['eth0']);
    assert.ok(errors.some(e => e.includes('[ssdp] AVISO') && e.includes('loopback')), errors.join('\n'));
    assert.ok(errors.some(e => e.includes('[ssdp] AVISO') && e.includes('rota padrao eth0')), errors.join('\n'));
    reset();
    endpoint({ SERVER_URL: '192.168.1.150' });
    assert.ok(!errors.some(e => e.includes('loopback')), errors.join('\n'));
});

test('sem rota padrao legivel (fora do Linux) => comportamento antigo (todas as interfaces), com aviso', () => {
    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: 'tv.local' }), {}, noRouteNet);
    assert.equal(FakeServer.last!.opts.interfaces, undefined);
    assert.ok(errors.some(e => e.includes('[ssdp] AVISO') && e.includes('todas as interfaces')), errors.join('\n'));
});

test('SSDP_INTERFACE forca a interface; inexistente => FALHA e exit 1, sem criar o anunciante', () => {
    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), { SSDP_INTERFACE: 'br-1' }, hostNet);
    assert.deepEqual(FakeServer.last!.opts.interfaces, ['br-1']);

    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), { SSDP_INTERFACE: 'eth9' }, hostNet);
    assert.deepEqual(exits.slice(0, 1), [1]);
    assert.ok(errors.some(e => e.includes('[ssdp] FALHA') && e.includes("SSDP_INTERFACE='eth9'")), errors.join('\n'));
    assert.equal(FakeServer.last, undefined);
});

test('com interface escolhida, o multicast sai por ela (setMulticastInterface no listening)', () => {
    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), {}, hostNet);
    const sock = FakeServer.last!.sockets['192.168.1.150'];
    assert.equal(sock.multicastInterface, undefined);
    sock.emit('listening');
    assert.equal(sock.multicastInterface, '192.168.1.150');
});

test('porta da borda invalida => log [ssdp] FALHA e exit 1', () => {
    reset();
    endpoint({ SERVER_URL: 'x', EDGE_HTTP_PORT: 'abc' });
    assert.deepEqual(exits.slice(0, 1), [1]);
    assert.ok(errors.some(e => e.includes('[ssdp] FALHA') && e.includes('EDGE_HTTP_PORT')), errors.join('\n'));
});

test('start() rejeitado (sem interface) => log [ssdp] FALHA e exit 1', async () => {
    reset();
    mode = 'reject';
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), {}, hostNet);
    await tick();
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some(e => e.includes('[ssdp] FALHA') && e.includes('No sockets available')), errors.join('\n'));
    assert.ok(!errors.some(e => e.includes('[ssdp] anunciando')), errors.join('\n'));
});

test('start() lancando de forma sincrona => exit 1', () => {
    reset();
    mode = 'throw';
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), {}, hostNet);
    assert.equal(exits[0], 1);
});

test('erro de socket depois do inicio => exit 1 (nao morre em silencio)', async () => {
    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), {}, hostNet);
    await tick();
    assert.deepEqual(exits, []);
    FakeServer.last!.sockets['192.168.1.150'].emit('error', new Error('bind EADDRINUSE 0.0.0.0:1900'));
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some(e => e.includes('EADDRINUSE')));
});

test('SIGTERM => ssdp:byebye (advertise(false)), log no nivel padrao e exit 143 depois da folga', async () => {
    reset();
    ssdp.startSSDP(endpoint({ SERVER_URL: '192.168.1.150' }), {}, hostNet);
    await tick();
    const s = FakeServer.last!;
    // antes do sinal, o laco de anuncio (advertise() sem argumento) passa
    s.advertise();
    assert.deepEqual(s.advertised, [undefined]);
    // chama so o handler instalado por este startSSDP (sem disparar o sinal no
    // processo do test runner)
    const mine = process.listeners('SIGTERM').filter(l => !sigtermBefore.includes(l));
    (mine[mine.length - 1] as (sig: string) => void)('SIGTERM');
    assert.deepEqual(s.advertised, [undefined, false]);
    assert.ok(errors.some(e => e.includes('[ssdp] SIGTERM: enviando ssdp:byebye')), errors.join('\n'));
    // na folga ate o exit, o laco da biblioteca nao manda mais ssdp:alive
    s.advertise();
    s.advertise(true);
    assert.deepEqual(s.advertised, [undefined, false]);
    await tick(400);
    assert.ok(exits.includes(143), JSON.stringify(exits));
});

test('SSDP_ENABLED: desliga so com false/0', () => {
    for (const v of [undefined, '', 'true', '1', 'yes']) assert.equal(ssdp.ssdpEnabled({ SSDP_ENABLED: v }), true, String(v));
    for (const v of ['false', 'FALSE', ' 0 ', 'False']) assert.equal(ssdp.ssdpEnabled({ SSDP_ENABLED: v }), false, v);
});
