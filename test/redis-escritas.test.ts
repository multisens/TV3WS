// P4 (decisao do Luis em 10/10, "Funcoes + auditoria"): teste ESTATICO — o
// tv3ws so grava nas familias do alcance (session:*, client:*, clients:*,
// user:{id}:broadcaster-attrs:*) pelo adaptador src/redis-funcoes.ts, que
// chama as funcoes do Redis. Falha se outro arquivo de src/ chamar comando de
// escrita no cliente Redis (set, hset, sadd, del, eval, multi, call...). A
// unica escrita direta permitida e o espelho remote-devices:* /
// remote-device:* (fora do alcance), e esse arquivo nao pode citar chave do
// alcance.
//
// As regras e a lista de familias vem de infra/redis (verificador
// infra/redis/test/escritas.js e esquema infra/redis/esquema.json): o teste
// precisa do TV30 com os submodulos (tv3ws/ ao lado de infra/).
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
