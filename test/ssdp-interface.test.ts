// Teste de unidade da escolha da interface do anuncio SSDP (sem rede):
// SSDP_INTERFACE > interface com o IPv4 do host > rota padrao > todas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'os';
import {
    chooseInterface, parseDefaultRoute, readDefaultRouteInterface, externalIPv4,
} from '../src/ssdp-interface';

const v4 = (address: string, internal = false) =>
    ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;
const v6 = (address: string) =>
    ({ address, family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: null, scopeid: 0 }) as NetworkInterfaceInfo;

// rede do host num Linux com docker (o arranjo do teste 7)
const ifaces = {
    lo: [v4('127.0.0.1', true)],
    eth0: [v4('192.168.0.12'), v6('fe80::1')],
    docker0: [v4('172.17.0.1')],
    'br-8db76461e4d3': [v4('172.20.0.1')],
    wlan0: [v4('10.0.0.5')],
    tun0: [v6('fd00::5')],
};
const route = (name?: string) => () => name;

// /proc/net/route real (cabecalho + rotas), com duas rotas padrao
const PROC = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'wlan0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0',
    'eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    '',
].join('\n');

test('parseDefaultRoute: rota 0/0 ativa de menor metrica', () => {
    assert.equal(parseDefaultRoute(PROC), 'eth0');
    // so rotas de rede, sem padrao
    assert.equal(parseDefaultRoute(PROC.split('\n').filter(l => !l.includes('\t00000000\t0100')).join('\n')), undefined);
    // rota padrao sem RTF_UP nao conta
    assert.equal(parseDefaultRoute('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n'
        + 'eth0\t00000000\t0100A8C0\t0002\t0\t0\t100\t00000000\n'), undefined);
    assert.equal(parseDefaultRoute(''), undefined);
});

test('readDefaultRouteInterface: arquivo ausente (fora do Linux) => undefined', () => {
    assert.equal(readDefaultRouteInterface(() => { throw new Error('ENOENT'); }), undefined);
    assert.equal(readDefaultRouteInterface(() => PROC), 'eth0');
});

test('externalIPv4 ignora loopback e IPv6', () => {
    assert.deepEqual(externalIPv4(ifaces.lo), []);
    assert.deepEqual(externalIPv4(ifaces.eth0), ['192.168.0.12']);
    assert.deepEqual(externalIPv4(undefined), []);
});

test('host e IP local => a interface que tem esse IP, sem aviso', () => {
    const a = chooseInterface('192.168.0.12', {}, ifaces, route('wlan0'));
    assert.deepEqual(a, { name: 'eth0', addresses: ['192.168.0.12'], source: 'host-ip', warnings: [] });
    const b = chooseInterface('172.17.0.1', {}, ifaces, route('eth0'));
    assert.equal(b.name, 'docker0');
});

test('host nao local (nome, IPv4 alheio, loopback, IPv6) => rota padrao, com aviso', () => {
    for (const host of ['tv.local', '8.8.8.8', 'localhost', '127.0.0.1', '[fe80::1]']) {
        const c = chooseInterface(host, {}, ifaces, route('eth0'));
        assert.equal(c.name, 'eth0', host);
        assert.equal(c.source, 'default-route', host);
        assert.equal(c.warnings.length, 1, host);
        assert.ok(c.warnings[0].includes('rota padrao eth0') && c.warnings[0].includes('SSDP_INTERFACE'), c.warnings[0]);
    }
    assert.ok(chooseInterface('8.8.8.8', {}, ifaces, route('eth0')).warnings[0].includes('nao esta em nenhuma interface'));
});

test('SSDP_INTERFACE forca a escolha (com aviso se o host esta em outra interface)', () => {
    const a = chooseInterface('192.168.0.12', { SSDP_INTERFACE: ' wlan0 ' }, ifaces, route('eth0'));
    assert.equal(a.name, 'wlan0');
    assert.equal(a.source, 'SSDP_INTERFACE');
    assert.ok(a.warnings[0].includes('esta na interface eth0'), a.warnings.join('\n'));

    const b = chooseInterface('tv.local', { SSDP_INTERFACE: 'eth0' }, ifaces, route(undefined));
    assert.deepEqual(b, { name: 'eth0', addresses: ['192.168.0.12'], source: 'SSDP_INTERFACE', warnings: [] });

    // vazio = nao definido
    assert.equal(chooseInterface('192.168.0.12', { SSDP_INTERFACE: '  ' }, ifaces, route()).source, 'host-ip');
});

test('SSDP_INTERFACE inexistente, so loopback ou so IPv6 => Error com a lista das interfaces', () => {
    for (const name of ['eth9', 'lo', 'tun0']) {
        assert.throws(() => chooseInterface('192.168.0.12', { SSDP_INTERFACE: name }, ifaces, route('eth0')),
            (e: Error) => e.message.includes(`SSDP_INTERFACE='${name}'`) && e.message.includes('eth0 (192.168.0.12)'));
    }
});

test('sem rota padrao (ou rota por interface sem IPv4) => todas as interfaces, com aviso de duplicata', () => {
    for (const r of [route(undefined), route('tun0')]) {
        const c = chooseInterface('tv.local', {}, ifaces, r);
        assert.equal(c.name, undefined);
        assert.equal(c.source, 'all');
        assert.deepEqual(c.addresses, ['192.168.0.12', '172.17.0.1', '172.20.0.1', '10.0.0.5']);
        assert.ok(c.warnings[0].includes('todas as interfaces') && c.warnings[0].includes('duplicadas'), c.warnings[0]);
    }
    // uma interface so: sem duplicata, sem falar nela
    const one = chooseInterface('tv.local', {}, { lo: ifaces.lo, eth0: ifaces.eth0 }, route(undefined));
    assert.ok(!one.warnings[0].includes('duplicadas'), one.warnings[0]);
});

test('interface com dois IPv4 => aviso (a biblioteca abre um socket por endereco)', () => {
    const two = { eth0: [v4('192.168.0.12'), v4('192.168.0.13')] };
    const c = chooseInterface('192.168.0.13', {}, two, route('eth0'));
    assert.equal(c.name, 'eth0');
    assert.ok(c.warnings.some(w => w.includes('2 enderecos IPv4')), c.warnings.join('\n'));
});
