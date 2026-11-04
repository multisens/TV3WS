// C.6.16.3: the command accepts the properties of Table A.30 and the
// position of A.3.19; any other name gives 101. The position capability of
// the device is "location" (Table A.45).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';

const sent: unknown[] = [];
const fakeDevice = {
    getClass: () => 'sensory-effect',
    getHandle: () => 'r1',
    getSupportedTypes: () => ['LightType'],
    getCapabilities: () => [],
    support: (t: string) => t === 'LightType',
    controlDevice: (m: unknown) => { sent.push(m); },
};
function stub(rel: string, exports: object): void {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
stub('modules/remotedevice-manager/manager', {
    getDeviceByHandle: (h: string) => (h === 'r1' ? fakeDevice : undefined),
    getDevicesByClass: () => [fakeDevice],
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const service = require('../src/api/sensory-effect/service').default as typeof import('../src/api/sensory-effect/service').default;

const cmd = (properties: { name: string; value: unknown }[]) =>
    ({ effectType: 'LightType', action: 'start', properties }) as never;

test('C.6.16.3: propriedades da Tabela A.30 e posicao da A.3.19 passam ao aparelho', () => {
    sent.length = 0;
    const props = ['intensityValue', 'color', 'scent', 'frequency', 'azimuthal', 'polar', 'width', 'height', 'direction', 'location']
        .map(name => ({ name, value: '1' }));
    service.controlRenderer('r1', cmd(props));
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0] as { properties: unknown[] }).properties, props);
});

test('C.6.16.3: nome fora dos dois conjuntos lanca (o controller responde 101), sem mandar nada', () => {
    for (const name of ['intensity', 'locator', 'Color', '', 'x']) {
        sent.length = 0;
        assert.throws(() => service.controlRenderer('r1', cmd([{ name, value: '1' }])), /Invalid sensory effect property/, name);
        assert.equal(sent.length, 0, name);
    }
    sent.length = 0;
    assert.throws(() => service.controlRenderer('r1', cmd([null as never])), /Invalid sensory effect property/);
    assert.equal(sent.length, 0);
});

test('C.6.16.3: sem propriedades continua valendo', () => {
    sent.length = 0;
    service.controlRenderer('r1', { effectType: 'LightType', action: 'stop' } as never);
    assert.equal(sent.length, 1);
});
