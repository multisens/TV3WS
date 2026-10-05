// Teste do GET /manifest (C.3.4, D10) sem Express real: o app e o
// agrupamento client-identification sao trocados por dubles.
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

function call(env: NodeJS.ProcessEnv): { status: number; headers: Record<string, string> } {
    const routes = new Map<string, Handler>();
    const app = { use(p: string, h: Handler) { routes.set(p, h); } };
    registerManifest(app as any, resolveAdvertisedEndpoint(env, () => '172.18.0.5'), env);
    const headers: Record<string, string> = {};
    let status = 0;
    routes.get('/manifest')!({}, { setHeader: (k, v) => { headers[k] = v; }, sendStatus: (c) => { status = c; } });
    return { status, headers };
}

test('/manifest aponta para a borda (44642/44643) no host configurado', () => {
    const { status, headers } = call({ SERVER_URL: '192.168.1.150' });
    assert.equal(status, 200);
    assert.equal(headers['Server-BaseURL'], '192.168.1.150:44642');
    assert.equal(headers['Server-SecureBaseURL'], '192.168.1.150:44643');
    assert.equal(headers['Server-PairingMethods'], 'qrcode,kex');
    assert.equal(headers['Device-BrandName'], 'GenericBrand');
    assert.equal(headers['Device-Model'], 'GenericModel');
    assert.equal(headers['Device-FriendlyName'], 'TV 3.0 Receiver');
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
