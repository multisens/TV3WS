// Teste de unidade do endereco divulgado pela descoberta SSDP (C.3.4, D10):
// host = SSDP_ADVERTISE_HOST > SERVER_URL > IP local; portas da borda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    locationURL, baseURL, secureBaseURL, normalizeHost, resolveAdvertisedEndpoint,
    advertiseWarnings, isLoopbackHost,
} from '../src/ssdp-config';

const ip = () => '172.18.0.5';

test('normalizeHost tira esquema, caminho e porta; IPv6 entre colchetes', () => {
    assert.equal(normalizeHost('192.168.1.150'), '192.168.1.150');
    assert.equal(normalizeHost(' tv.local '), 'tv.local');
    assert.equal(normalizeHost('http://192.168.1.150:44642/manifest'), '192.168.1.150');
    assert.equal(normalizeHost('tv.local:8080'), 'tv.local');
    assert.equal(normalizeHost('[fe80::1]:44642'), '[fe80::1]');
    assert.equal(normalizeHost('fe80::1'), '[fe80::1]');
    assert.equal(normalizeHost(''), '');
    assert.equal(normalizeHost(undefined), '');
});

test('precedencia do host e portas padrao da borda (44642/44643)', () => {
    const a = resolveAdvertisedEndpoint({ SSDP_ADVERTISE_HOST: '192.168.1.150', SERVER_URL: 'localhost' }, ip);
    assert.deepEqual(a, { host: '192.168.1.150', source: 'SSDP_ADVERTISE_HOST', httpPort: 44642, httpsPort: 44643 });

    const b = resolveAdvertisedEndpoint({ SERVER_URL: 'localhost', HTTP_PORT: '44652', HTTPS_PORT: '44653' }, ip);
    assert.deepEqual(b, { host: 'localhost', source: 'SERVER_URL', httpPort: 44642, httpsPort: 44643 });

    const c = resolveAdvertisedEndpoint({ SSDP_ADVERTISE_HOST: '  ', SERVER_URL: '' }, ip);
    assert.deepEqual(c, { host: '172.18.0.5', source: 'local-ip', httpPort: 44642, httpsPort: 44643 });
});

test('LOCATION e cabecalhos do /manifest apontam para a borda', () => {
    const e = resolveAdvertisedEndpoint({ SERVER_URL: '192.168.1.150' }, ip);
    assert.equal(locationURL(e), 'http://192.168.1.150:44642/manifest');
    assert.equal(baseURL(e), '192.168.1.150:44642');
    assert.equal(secureBaseURL(e), '192.168.1.150:44643');

    const custom = resolveAdvertisedEndpoint({ SERVER_URL: 'tv.local', EDGE_HTTP_PORT: '8080', EDGE_HTTPS_PORT: '8443' }, ip);
    assert.equal(locationURL(custom), 'http://tv.local:8080/manifest');
    assert.equal(secureBaseURL(custom), 'tv.local:8443');
});

test('avisos: host de loopback, porta fora da 44642 e Server-SecureBaseURL sem TLS (L3)', () => {
    for (const host of ['localhost', 'tv.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
        assert.ok(isLoopbackHost(host), host);
    }
    for (const host of ['192.168.1.150', 'tv.local', '[fe80::1]', '10.127.0.1']) {
        assert.ok(!isLoopbackHost(host), host);
    }
    const loop = advertiseWarnings(resolveAdvertisedEndpoint({ SERVER_URL: 'localhost' }, ip));
    assert.ok(loop.some(w => w.includes('loopback') && w.includes('SERVER_URL')), loop.join('\n'));
    const lan = advertiseWarnings(resolveAdvertisedEndpoint({ SERVER_URL: '192.168.1.150' }, ip));
    assert.ok(!lan.some(w => w.includes('loopback') || w.includes('EDGE_HTTP_PORT')), lan.join('\n'));
    assert.ok(lan.some(w => w.includes('SEM TLS') && w.includes('192.168.1.150:44643')), lan.join('\n'));
    const port = advertiseWarnings(resolveAdvertisedEndpoint({ SERVER_URL: 'tv.local', EDGE_HTTP_PORT: '8080' }, ip));
    assert.ok(port.some(w => w.includes('EDGE_HTTP_PORT=8080') && w.includes('44642')), port.join('\n'));
});

test('porta invalida lanca erro (o boot morre com log, nao anuncia lixo)', () => {
    for (const bad of ['abc', '0', '70000', '44642.5']) {
        assert.throws(() => resolveAdvertisedEndpoint({ EDGE_HTTP_PORT: bad }, ip), /EDGE_HTTP_PORT/);
    }
    assert.throws(() => resolveAdvertisedEndpoint({ EDGE_HTTPS_PORT: '-1' }, ip), /EDGE_HTTPS_PORT/);
});
