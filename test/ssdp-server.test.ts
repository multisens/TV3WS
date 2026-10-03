// Teste do ciclo de vida do anunciante SSDP (D9/D10) sem rede: a biblioteca
// @lvcabral/node-ssdp, o app Express e o agrupamento client-identification
// sao trocados por dubles; process.exit e console.error sao capturados.
// Nenhum pacote UDP e enviado.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { EventEmitter } from 'events';

// --- dubles ----------------------------------------------------------------
let mode: 'resolve' | 'reject' | 'throw' = 'resolve';

class FakeServer {
    static last: FakeServer;
    opts: any;
    usns: string[] = [];
    sockets: Record<string, EventEmitter> = {};
    advertised: Array<boolean | undefined> = [];
    constructor(opts: any) { this.opts = opts; FakeServer.last = this; }
    addUSN(u: string) { this.usns.push(u); }
    start() {
        this.sockets = { '10.0.0.1': new EventEmitter() };
        if (mode === 'throw') throw new Error('sincrono');
        return mode === 'reject' ? Promise.reject(new Error('No sockets available, cannot start.')) : Promise.resolve();
    }
    advertise(alive?: boolean) { this.advertised.push(alive); }
    stop() { /* nada */ }
}

type Handler = (req: unknown, res: { setHeader(k: string, v: string): void; sendStatus(s: number): void }) => void;
const routes = new Map<string, Handler>();
const fakeApp = { use(p: string, h: Handler) { routes.set(p, h); } };

function stubFile(file: string, exports: object): void {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
const src = (rel: string) => require.resolve(path.join(__dirname, '..', 'src', rel));
stubFile(require.resolve('@lvcabral/node-ssdp'), { Server: FakeServer });
stubFile(src('app'), { default: fakeApp });
stubFile(src('api/client-identification'), { pairingMethods: ['qrcode', 'kex'] });

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

function load(env: Record<string, string | undefined>): { startSSDP: () => void } {
    for (const k of ['SSDP_ADVERTISE_HOST', 'SERVER_URL', 'EDGE_HTTP_PORT', 'EDGE_HTTPS_PORT']) delete process.env[k];
    Object.assign(process.env, env);
    const file = src('ssdp-server');
    delete require.cache[file];
    return require(file);
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// --- casos -------------------------------------------------------------------

test('anuncio e /manifest apontam para a borda (44642/44643) no host configurado', () => {
    load({ SERVER_URL: '192.168.1.150' });
    const s = FakeServer.last;
    assert.equal(s.opts.location, 'http://192.168.1.150:44642/manifest');
    assert.deepEqual(s.usns, ['urn:schemas-sbtvd-org:service:TV3.0WebServices:1']);

    const headers: Record<string, string> = {};
    let status = 0;
    routes.get('/manifest')!({}, { setHeader: (k, v) => { headers[k] = v; }, sendStatus: (c) => { status = c; } });
    assert.equal(status, 200);
    assert.equal(headers['Server-BaseURL'], '192.168.1.150:44642');
    assert.equal(headers['Server-SecureBaseURL'], '192.168.1.150:44643');
    assert.equal(headers['Server-PairingMethods'], 'qrcode,kex');
});

test('SSDP_ADVERTISE_HOST tem precedencia sobre SERVER_URL', () => {
    load({ SSDP_ADVERTISE_HOST: '10.1.2.3', SERVER_URL: 'localhost' });
    assert.equal(FakeServer.last.opts.location, 'http://10.1.2.3:44642/manifest');
});

test('host de loopback (padrao do compose) => [ssdp] AVISO no boot, sem mudar o anuncio', () => {
    errors.length = 0;
    load({ SERVER_URL: 'localhost' });
    assert.equal(FakeServer.last.opts.location, 'http://localhost:44642/manifest');
    assert.ok(errors.some(e => e.includes('[ssdp] AVISO') && e.includes('loopback')), errors.join('\n'));
    errors.length = 0;
    load({ SERVER_URL: '192.168.1.150' });
    assert.ok(!errors.some(e => e.includes('loopback')), errors.join('\n'));
});

test('porta da borda invalida => log [ssdp] FALHA e exit 1 no carregamento', () => {
    exits.length = 0; errors.length = 0;
    // com process.exit capturado o modulo segue e quebra adiante; no processo
    // real o exit(1) encerra antes disso
    try { load({ SERVER_URL: 'x', EDGE_HTTP_PORT: 'abc' }); } catch { /* esperado */ }
    assert.deepEqual(exits.slice(0, 1), [1]);
    assert.ok(errors.some(e => e.includes('[ssdp] FALHA') && e.includes('EDGE_HTTP_PORT')), errors.join('\n'));
});

test('start() rejeitado (sem interface) => log [ssdp] FALHA e exit 1', async () => {
    exits.length = 0; errors.length = 0;
    mode = 'reject';
    load({ SERVER_URL: 'x' }).startSSDP();
    await tick();
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some(e => e.includes('[ssdp] FALHA') && e.includes('No sockets available')), errors.join('\n'));
});

test('start() lancando de forma sincrona => exit 1', () => {
    exits.length = 0;
    mode = 'throw';
    load({ SERVER_URL: 'x' }).startSSDP();
    assert.equal(exits[0], 1);
});

test('erro de socket depois do inicio => exit 1 (nao morre em silencio)', async () => {
    exits.length = 0; errors.length = 0;
    mode = 'resolve';
    load({ SERVER_URL: 'x' }).startSSDP();
    await tick();
    assert.deepEqual(exits, []);
    FakeServer.last.sockets['10.0.0.1'].emit('error', new Error('bind EADDRINUSE 0.0.0.0:1900'));
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some(e => e.includes('EADDRINUSE')));
});

test('SIGTERM => ssdp:byebye (advertise(false)) e exit 143 depois da folga', async () => {
    exits.length = 0;
    mode = 'resolve';
    load({ SERVER_URL: 'x' }).startSSDP();
    await tick();
    const s = FakeServer.last;
    // chama so o handler instalado por este startSSDP (sem disparar o sinal no
    // processo do test runner)
    const mine = process.listeners('SIGTERM').filter(l => !sigtermBefore.includes(l));
    (mine[mine.length - 1] as (sig: string) => void)('SIGTERM');
    assert.deepEqual(s.advertised, [false]);
    await tick(400);
    assert.ok(exits.includes(143), JSON.stringify(exits));
});
