// Enderecos de escuta do tv3ws (Joel, 15/10: no dev-host, a porta so pode ser
// alcancavel da propria maquina, por padrao).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'os';
import { listenHosts } from '../src/listen-hosts';

const v4 = (address: string, internal = false) =>
    ({ address, family: 'IPv4', internal, netmask: '255.255.0.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;

test('fora do container: so o loopback; com a docker0 (Linux), o IPv4 dela tambem', () => {
    assert.deepEqual(listenHosts({}, { lo0: [v4('127.0.0.1', true)], en0: [v4('192.168.0.19')] }), ['127.0.0.1']);
    assert.deepEqual(listenHosts({}, { eth0: [v4('192.168.0.19')], docker0: [v4('172.17.0.1')] }), ['127.0.0.1', '172.17.0.1']);
});

test('TV3WS_LISTEN_HOST (o compose poe 0.0.0.0) fixa a lista', () => {
    assert.deepEqual(listenHosts({ TV3WS_LISTEN_HOST: '0.0.0.0' }, { docker0: [v4('172.17.0.1')] }), ['0.0.0.0']);
    assert.deepEqual(listenHosts({ TV3WS_LISTEN_HOST: ' 127.0.0.1, 10.0.0.2 ' }, {}), ['127.0.0.1', '10.0.0.2']);
    assert.deepEqual(listenHosts({ TV3WS_LISTEN_HOST: '' }, {}), ['127.0.0.1']);
});
