// Static test: in src/, only redis-functions.ts writes to the Redis families;
// the exception is the remote-device* mirror. The rules come from
// infra/redis/test/writes.js: needs TV30 with the submodules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const CHECKER = path.join(__dirname, '..', '..', 'infra', 'redis', 'test', 'writes.js');

test('tv3ws: escrita nas familias do alcance do Redis so pelo adaptador das funcoes', () => {
    assert.ok(fs.existsSync(CHECKER), `verificador ${CHECKER} nao encontrado: rode no TV30 com os submodulos (git submodule update --init)`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkJsModule, tv30Modules } = require(CHECKER);
    const cfg = tv30Modules(path.join(__dirname, '..', '..')).tv3ws;
    const r = checkJsModule({ ...cfg, root: path.join(__dirname, '..') });
    assert.deepEqual(r.violations, [], r.violations.join('\n'));
    assert.ok(r.adapterFunctions.length >= 8, `funcoes chamadas pelo adaptador: ${r.adapterFunctions.join(', ')}`);
});
