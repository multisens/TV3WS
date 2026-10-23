// Static test: in src/, only redis-funcoes.ts writes to the Redis families;
// the exception is the remote-device* mirror. The rules come from
// infra/redis/test/escritas.js: needs TV30 with the submodules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const VERIFICADOR = path.join(__dirname, '..', '..', 'infra', 'redis', 'test', 'escritas.js');

test('tv3ws: escrita nas familias do alcance do Redis so pelo adaptador das funcoes', () => {
    assert.ok(fs.existsSync(VERIFICADOR), `verificador ${VERIFICADOR} nao encontrado: rode no TV30 com os submodulos (git submodule update --init)`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { verificaModuloJs, modulosTv30 } = require(VERIFICADOR);
    const cfg = modulosTv30(path.join(__dirname, '..', '..')).tv3ws;
    const r = verificaModuloJs({ ...cfg, raiz: path.join(__dirname, '..') });
    assert.deepEqual(r.violacoes, [], r.violacoes.join('\n'));
    assert.ok(r.adaptadorFuncoes.length >= 8, `funcoes chamadas pelo adaptador: ${r.adaptadorFuncoes.join(', ')}`);
});
