// Material TLS do receptor: TV30_TLS_DIR, senao HTTPS_KEY/HTTPS_CERT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadTls } from '../src/tls';

test('TV30_TLS_DIR com key.pem e cert.pem prevalece sobre HTTPS_KEY/HTTPS_CERT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv30-tls-'));
    fs.writeFileSync(path.join(dir, 'key.pem'), 'CHAVE');
    fs.writeFileSync(path.join(dir, 'cert.pem'), 'CERT');
    const t = loadTls({ TV30_TLS_DIR: dir, HTTPS_KEY: Buffer.from('k').toString('base64'), HTTPS_CERT: Buffer.from('c').toString('base64') });
    assert.equal(t?.key.toString(), 'CHAVE');
    assert.equal(t?.cert.toString(), 'CERT');
    assert.match(t!.source, /TV30_TLS_DIR/);
    fs.rmSync(dir, { recursive: true });
});

test('sem o diretorio (ou sem os arquivos), HTTPS_KEY/HTTPS_CERT; sem nada, nenhum', () => {
    const env = { TV30_TLS_DIR: '/nao/existe', HTTPS_KEY: Buffer.from('k').toString('base64'), HTTPS_CERT: Buffer.from('c').toString('base64') };
    const t = loadTls(env);
    assert.equal(t?.key.toString(), 'k');
    assert.equal(t?.source, 'HTTPS_KEY/HTTPS_CERT');
    assert.equal(loadTls({}), undefined);
    assert.equal(loadTls({ HTTPS_KEY: 'x' }), undefined);
});
