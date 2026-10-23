// GET /manifest (C.3.4) without a real Express: the app and
// client-identification are doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';

type Handler = (req: unknown, res: { setHeader(k: string, v: string): void; sendStatus(s: number): void }) => void;

function stubFile(file: string, exports: object): void {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
const src = (rel: string) => require.resolve(path.join(__dirname, '..', 'src', rel));
stubFile(src('api/client-identification'), { pairingMethods: ['qrcode', 'kex'] });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerManifest } = require(src('manifest')) as typeof import('../src/manifest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveAdvertisedEndpoint } = require(src('ssdp-config')) as typeof import('../src/ssdp-config');

// reqHeaders: the headers of the request (X-TV30-Host from the edge; Host
// from the client). Without any, the boot chain.
function call(env: NodeJS.ProcessEnv, reqHeaders: Record<string, string> = {}): { status: number; headers: Record<string, string> } {
    const routes = new Map<string, Handler>();
    const app = { use(p: string, h: Handler) { routes.set(p, h); } };
    registerManifest(app as any, resolveAdvertisedEndpoint(env, () => '172.18.0.5'), env);
    const headers: Record<string, string> = {};
    let status = 0;
    const lower = Object.fromEntries(Object.entries(reqHeaders).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { get: (k: string) => lower[k.toLowerCase()] };
    routes.get('/manifest')!(req, { setHeader: (k, v) => { headers[k] = v; }, sendStatus: (c) => { status = c; } });
    return { status, headers };
}

test('/manifest aponta para a borda (44642/44643); sem cabecalho de host, a cadeia do boot', () => {
    const { status, headers } = call({ SERVER_URL: '192.168.1.150' });
    assert.equal(status, 200);
    assert.equal(headers['Server-BaseURL'], '192.168.1.150:44642');
    assert.equal(headers['Server-SecureBaseURL'], '192.168.1.150:44643');
    assert.equal(headers['Server-PairingMethods'], 'qrcode,kex');
    assert.equal(headers['Device-BrandName'], 'GenericBrand');
    assert.equal(headers['Device-Model'], 'GenericModel');
    assert.equal(headers['Device-FriendlyName'], 'TV 3.0 Receiver');
});

test('/manifest expoe ao navegador exatamente os cabecalhos Server-* e Device-* que envia', () => {
    const { headers } = call({ SERVER_URL: '192.168.1.150' });
    const exposed = (headers['Access-Control-Expose-Headers'] || '').split(',').map(s => s.trim());
    const sent = Object.keys(headers).filter(k => k !== 'Access-Control-Expose-Headers');
    assert.deepEqual(exposed, ['Server-BaseURL', 'Server-SecureBaseURL', 'Server-PairingMethods',
        'Device-BrandName', 'Device-Model', 'Device-FriendlyName']);
    assert.deepEqual([...sent].sort(), [...exposed].sort(), 'todo cabecalho enviado esta na lista, e so eles');
    assert.ok(sent.every(k => /^(Server|Device)-/.test(k)));
    // No Access-Control-Allow-Origin here: a duplicated one is refused by the
    // browser.
    assert.equal(headers['Access-Control-Allow-Origin'], undefined);
});

test('/manifest usa SSDP_ADVERTISE_HOST, as portas da borda e os metadados do ambiente', () => {
    const { headers } = call({
        SSDP_ADVERTISE_HOST: '10.1.2.3', SERVER_URL: 'localhost', EDGE_HTTP_PORT: '8080', EDGE_HTTPS_PORT: '8443',
        BRAND_NAME: 'Marca', MODEL: 'M1', FRIENDLY_NAME: 'Sala',
    });
    assert.equal(headers['Server-BaseURL'], '10.1.2.3:8080');
    assert.equal(headers['Server-SecureBaseURL'], '10.1.2.3:8443');
    assert.equal(headers['Device-BrandName'], 'Marca');
    assert.equal(headers['Device-Model'], 'M1');
    assert.equal(headers['Device-FriendlyName'], 'Sala');
});

// The host is the one by which the client reached the /manifest, to match
// the LOCATION of the announcer.
test('/manifest com o host da requisicao (X-TV30-Host da borda), e SSDP_ADVERTISE_HOST prevalece', () => {
    let { headers } = call({ SERVER_URL: 'localhost' }, { 'X-TV30-Host': '192.168.0.23:44642', Host: 'tv3ws:44652' });
    assert.equal(headers['Server-BaseURL'], '192.168.0.23:44642');
    assert.equal(headers['Server-SecureBaseURL'], '192.168.0.23:44643');
    // Without the edge (directly on tv3ws): the Host of the request itself.
    ({ headers } = call({ SERVER_URL: 'localhost' }, { Host: '10.0.0.9:44642' }));
    assert.equal(headers['Server-BaseURL'], '10.0.0.9:44642');
    // IPv6 in brackets.
    ({ headers } = call({}, { 'X-TV30-Host': '[fe80::1]:44642' }));
    assert.equal(headers['Server-BaseURL'], '[fe80::1]:44642');
    // Override.
    ({ headers } = call({ SSDP_ADVERTISE_HOST: 'tv.local' }, { 'X-TV30-Host': '192.168.0.23:44642' }));
    assert.equal(headers['Server-BaseURL'], 'tv.local:44642');
});
