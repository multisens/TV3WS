// The running broadcaster application read from session:current-app, and the
// nodes of its document read from app:doc-nodes:{serviceContextId} when it
// starts; Redis and MQTT by doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import path from 'path';
import { createFakeRedis } from './helpers/fake-redis';
import { createFakeMqtt, TOPICS } from './helpers/fake-mqtt';

const fake = createFakeRedis();
const mqtt = createFakeMqtt();

function stub(rel: string, exports: object): void {
    const file = require.resolve(path.join(__dirname, '..', 'src', rel));
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = { __esModule: true, ...exports };
    require.cache[file] = m;
}
stub('redis-client', { default: fake.redis });
stub('mqtt-client', { default: mqtt.mqttClient, TOPICS, client: mqtt.client });

/* eslint-disable @typescript-eslint/no-var-requires */
const { currentAssociatedId } = require('../src/modules/associated-app');
const core = require('../src/core').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const STATE_TOPIC = 'aop/application-lifecycle-manager/application-state';
const APP = { serviceContextId: 'urn:tv30:service:1002', appId: 'urn:tv30:app:x', origin: 'http://ctx-1.apps.localhost:8081' };
const NODES = [{ id: 'ctx.video', type: 'media', mimeType: 'video/mp4', device: 'handle-1' }];

async function waitFor(condition: () => boolean): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        assert.ok(Date.now() - start < 2000, 'condition not reached in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('the associated identity comes from session:current-app, without any event', async () => {
    assert.equal(await currentAssociatedId(), undefined);
    fake.store.set('session:current-app', { ...APP });
    assert.equal(await currentAssociatedId(), `${APP.serviceContextId}/${APP.appId}`);
    fake.store.delete('session:current-app');
    assert.equal(await currentAssociatedId(), undefined);
});

test('the nodes of the document are read when the application starts and released when it ends', async () => {
    fake.store.set(`app:doc-nodes:${APP.serviceContextId}`, { [APP.appId]: JSON.stringify(NODES) });
    await mqtt.deliver(STATE_TOPIC, JSON.stringify({ ...APP, state: 'started' }));
    await waitFor(() => core.app.nodes.length === 1);
    assert.deepEqual(core.app.nodes, NODES);
    assert.equal(core.app.id, APP.appId);
    await mqtt.deliver(STATE_TOPIC, JSON.stringify({ ...APP, state: 'ended' }));
    await waitFor(() => core.app.nodes.length === 0);
    assert.equal(core.app.id, '');
});
