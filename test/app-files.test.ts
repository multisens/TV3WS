// GET /tv3/current-service/apps/<appId>/files (C.6.4.7, Tabela C.17) pelo app.ts inteiro, com o core real e
// Redis e MQTT por dubles. O diretorio da aplicacao e uma arvore temporaria, com um arquivo e um diretorio
// de fora ao lado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import http, { Server } from 'http';
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../src/app').default;

// --- arvore de teste ---------------------------------------------------------
const SEGREDO = 'SEGREDO-FORA-DA-APLICACAO';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv3ws-appfiles-'));
const appDir = path.join(root, 'app');
const fora = path.join(root, 'fora');
fs.mkdirSync(path.join(appDir, 'sub', 'deep'), { recursive: true });
fs.mkdirSync(fora);
fs.writeFileSync(path.join(root, 'segredo.txt'), SEGREDO);
fs.writeFileSync(path.join(fora, 'segredo2.txt'), SEGREDO + '-2');
fs.writeFileSync(path.join(appDir, 'a.txt'), 'conteudo a');
fs.writeFileSync(path.join(appDir, 'index.html'), '<html></html>');
fs.writeFileSync(path.join(appDir, '.oculto'), 'x');
// nome que comeca com ".." e esta DENTRO (nao e o diretorio de cima)
fs.writeFileSync(path.join(appDir, '..dados.txt'), 'dados');
fs.writeFileSync(path.join(appDir, 'video.mp4'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
fs.writeFileSync(path.join(appDir, 'sub', 'b.txt'), 'conteudo b');
fs.writeFileSync(path.join(appDir, 'sub', 'deep', 'c.txt'), 'c');
// link de diretorio para fora e para dentro ('junction' no Windows dispensa
// privilegio; no Linux o tipo e ignorado)
fs.symlinkSync(fora, path.join(appDir, 'link-fora'), 'junction');
fs.symlinkSync(path.join(appDir, 'sub'), path.join(appDir, 'link-dentro'), 'junction');
// link de arquivo para fora: no Windows exige privilegio (ou modo de
// desenvolvedor); sem ele, o caso e pulado
let fileLink = true;
try { fs.symlinkSync(path.join(root, 'segredo.txt'), path.join(appDir, 'arq-fora.txt'), 'file'); } catch { fileLink = false; }

const SID = '1';
const APP = 'app1';

let server: Server;
let base = '';
before(async () => {
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tv3/current-service/apps`;
    await mqtt.deliver(TOPICS.current_service, SID);
    await mqtt.deliver(`aop/${SID}/currentApp`, APP);
    await mqtt.deliver(`aop/${SID}/${APP}/path`, appDir);
});
after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
});

// GET com a query escrita a mao (codificacoes, barra invertida, NUL...)
async function files(rawQuery?: string, appId = APP, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/${appId}/files${rawQuery === undefined ? '' : `?${rawQuery}`}`, { headers });
    const type = res.headers.get('content-type') ?? '';
    const raw = Buffer.from(await res.arrayBuffer());
    const text = raw.toString('utf8');
    return { status: res.status, type, raw, text, json: /json/.test(type) ? JSON.parse(text) : undefined };
}
const expect305 = (r: Awaited<ReturnType<typeof files>>, what: string) => {
    assert.equal(r.status, 404, `${what}: ${r.status} ${r.text.slice(0, 120)}`);
    assert.match(r.type, /application\/json/, what);
    assert.equal(r.json.error, 305, `${what}: ${r.text}`);
    assert.ok(!r.text.includes(SEGREDO), `${what}: conteudo de fora na resposta`);
};

// --- casos -------------------------------------------------------------------
test('path que sai do diretorio da aplicacao (.., codificado, barra invertida, NUL, absoluto): 305 sem o conteudo de fora', async () => {
    const abs = path.join(root, 'segredo.txt').replace(/\\/g, '/');
    // absoluto em outro disco no Windows (o tv3ws esta em D:, o temporario em
    // C:): path.relative devolve caminho absoluto; no Linux vira relativo a base
    const otherDrive = path.join(process.cwd(), 'package.json').replace(/\\/g, '/');
    const cases = [
        'path=../segredo.txt',
        'path=..%2fsegredo.txt',
        'path=%2e%2e%2fsegredo.txt',
        'path=%2E%2E/segredo.txt',
        'path=/../segredo.txt',
        'path=sub/../../segredo.txt',
        'path=sub/deep/../../../segredo.txt',
        'path=../app/../segredo.txt',
        'path=../fora/segredo2.txt',
        'path=..%5csegredo.txt',                  // barra invertida
        'path=sub%5c..%5c..%5csegredo.txt',
        `path=${encodeURIComponent(otherDrive)}`,
        'path=sub%5cb.txt',                       // barra invertida nao separa, nem dentro (no Windows separaria)
        'path=a.txt%00',                          // NUL
        'path=%00../segredo.txt',
        `path=${encodeURIComponent(abs)}`,        // absoluto: e lido a partir da base
        'path=%252e%252e%252fsegredo.txt',        // codificado duas vezes: nome literal "%2e%2e%2f..."
        'path=..',                                // diretorio de cima
        'path=../fora',
        'path=a.txt&path=../segredo.txt',         // parametro repetido (lista)
    ];
    for (const q of cases) expect305(await files(q), q);
});

test('link simbolico: vale o destino, e o destino fora do diretorio da aplicacao da 305', async (t) => {
    expect305(await files('path=link-fora/segredo2.txt'), 'link-fora/segredo2.txt');
    expect305(await files('path=link-fora'), 'link-fora (listagem)');
    const ok = await files('path=link-dentro/b.txt');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.text, 'conteudo b');
    if (fileLink) expect305(await files('path=arq-fora.txt'), 'arq-fora.txt');
    else t.diagnostic('link simbolico de arquivo nao criado (sem privilegio no Windows): caso arq-fora.txt pulado');
});

test('arquivo dentro do diretorio da aplicacao: 200 com o conteudo e o MIME da extensao; barra inicial opcional', async () => {
    for (const q of ['path=a.txt', 'path=/a.txt', 'path=//a.txt', 'path=sub/../a.txt', 'path=%61.txt']) {
        const r = await files(q);
        assert.equal(r.status, 200, `${q}: ${r.text}`);
        assert.match(r.type, /^text\/plain/, q);
        assert.equal(r.text, 'conteudo a', q);
    }
    const b = await files('path=sub/b.txt');
    assert.equal(b.status, 200);
    assert.equal(b.text, 'conteudo b');
    // nome comecando com "..", dentro do diretorio
    const d = await files('path=..dados.txt');
    assert.equal(d.status, 200, d.text);
    assert.equal(d.text, 'dados');
    // sem MIME conhecido: application/octet-stream (Tabela C.17)
    const h = await files('path=index.html');
    assert.equal(h.status, 200);
    assert.match(h.type, /^application\/octet-stream/);
});

test('arquivo inexistente: 305', async () => {
    expect305(await files('path=nao-existe.txt'), 'nao-existe.txt');
    expect305(await files('path=sub/nao-existe/x.txt'), 'sub/nao-existe/x.txt');
    expect305(await files('path=a.txt/x'), 'a.txt/x');   // ENOTDIR
});

test('path omitido, vazio ou "/": listagem do primeiro nivel da aplicacao no formato da Tabela C.17', async () => {
    // arq-fora.txt e link-fora (destino fora) nao entram; link-dentro entra
    // pelo destino
    const expected = {
        files: [
            { name: '..dados.txt', size: 5 },
            { name: '.oculto', size: 1 },
            { name: 'a.txt', size: 10 },
            { name: 'index.html', size: 13 },
            { name: 'video.mp4', size: 10 },
        ],
        dirs: [{ name: 'link-dentro' }, { name: 'sub' }],
    };
    for (const q of [undefined, 'path=', 'path=/', 'path=.', 'path=sub/..']) {
        const r = await files(q);
        assert.equal(r.status, 200, `${q}: ${r.text}`);
        assert.match(r.type, /application\/json/, String(q));
        assert.deepEqual(r.json, expected, String(q));
    }
});

test('path de diretorio: listagem dele (arquivos com tamanho, diretorios so com nome)', async () => {
    for (const q of ['path=sub', 'path=sub/', 'path=/sub', 'path=link-dentro']) {
        const r = await files(q);
        assert.equal(r.status, 200, `${q}: ${r.text}`);
        assert.deepEqual(r.json, { files: [{ name: 'b.txt', size: 10 }], dirs: [{ name: 'deep' }] }, q);
    }
});

// GET pelo modulo http, com o caminho da URL tal como escrito: o fetch
// normaliza ".." e "%2e%2e" (segmentos de ponto) antes de mandar
function rawGet(urlPath: string): Promise<{ status: number; text: string; json: any }> {
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json: any;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode ?? 0, text, json });
            });
        }).on('error', reject);
    });
}

test('appId que nao e o da aplicacao corrente: 305; o appId nao entra no caminho', async () => {
    for (const id of ['outra', '..', '%2e%2e', '..%2F..', '..%2Fapp', '%2e%2e%2f%2e%2e']) {
        for (const q of ['?path=a.txt', '']) {
            const r = await rawGet(`/tv3/current-service/apps/${id}/files${q}`);
            assert.equal(r.status, 404, `appId ${id}${q}: ${r.text}`);
            assert.equal(r.json?.error, 305, `appId ${id}${q}: ${r.text}`);
        }
    }
});

test('Range em video dentro do diretorio: 206 com o trecho', async () => {
    const r = await files('path=video.mp4', APP, { Range: 'bytes=2-5' });
    assert.equal(r.status, 206);
    assert.equal(r.type, 'video/mp4');
    assert.deepEqual([...r.raw], [2, 3, 4, 5]);
});

test('troca de aplicacao: a nova nao serve o diretorio da anterior antes do .../path dela; encerrar zera o diretorio', async () => {
    const outraDir = path.join(root, 'outra-app');
    fs.mkdirSync(outraDir);
    fs.writeFileSync(path.join(outraDir, 'b2.txt'), 'conteudo da outra');
    try {
        await mqtt.deliver(`aop/${SID}/currentApp`, 'app1b');
        expect305(await files('path=a.txt', 'app1b'), 'a.txt da anterior, pela nova');
        expect305(await files(undefined, 'app1b'), 'listagem da anterior, pela nova');
        expect305(await files('path=a.txt'), 'app1 nao e mais a corrente');
        // chega o diretorio da nova
        await mqtt.deliver(`aop/${SID}/app1b/path`, outraDir);
        const b2 = await files('path=b2.txt', 'app1b');
        assert.equal(b2.status, 200, b2.text);
        assert.equal(b2.text, 'conteudo da outra');
        expect305(await files('path=a.txt', 'app1b'), 'a.txt nao e da nova');
        // .../path atrasado da anterior nao vale para a nova
        await mqtt.deliver(`aop/${SID}/${APP}/path`, appDir);
        expect305(await files('path=a.txt', 'app1b'), '.../path atrasado da anterior');

        // encerrar: mensagem vazia em currentApp
        await mqtt.deliver(`aop/${SID}/currentApp`, '');
        expect305(await files('path=b2.txt', 'app1b'), 'b2.txt depois de encerrar');
        expect305(await files(undefined, 'app1b'), 'listagem depois de encerrar');
        // o .../path da encerrada nao volta a valer
        await mqtt.deliver(`aop/${SID}/app1b/path`, outraDir);
        expect305(await files('path=b2.txt', 'app1b'), '.../path da encerrada');
        // a aplicacao anterior de volta: diretorio de novo so pelo .../path dela
        await mqtt.deliver(`aop/${SID}/currentApp`, APP);
        expect305(await files('path=a.txt'), 'app1 de volta, antes do .../path');
        // e o .../path da encerrada nao vira o diretorio dela (o tratador
        // saiu no encerramento)
        await mqtt.deliver(`aop/${SID}/app1b/path`, outraDir);
        expect305(await files('path=b2.txt'), '.../path da encerrada com a app1 corrente');
    } finally {
        // estado dos casos seguintes: app1 corrente, com o diretorio dela
        await mqtt.deliver(`aop/${SID}/currentApp`, APP);
        await mqtt.deliver(`aop/${SID}/${APP}/path`, appDir);
    }
    const ok = await files('path=a.txt');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.text, 'conteudo a');
});

// por ultimo: troca o servico, e o diretorio da nova aplicacao ainda nao veio
test('sem diretorio da aplicacao conhecido (core.app.url vazio): 305, sem ler relativo ao diretorio corrente do tv3ws', async () => {
    await mqtt.deliver(TOPICS.current_service, '2');
    await mqtt.deliver('aop/2/currentApp', 'app2');
    // o cwd do npm test e o tv3ws, que tem package.json
    assert.ok(fs.existsSync(path.join(process.cwd(), 'package.json')));
    const r = await files('path=package.json', 'app2');
    expect305(r, 'package.json sem base');
    assert.ok(!r.text.includes('"name"'), r.text);
    expect305(await files(undefined, 'app2'), 'listagem sem base');
});
