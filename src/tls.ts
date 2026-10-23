import fs from 'fs';
import path from 'path';

// Certificado autoassinado do receptor (C.4.1.1 permite), o mesmo da borda: HTTPS, serverCert do
// pareamento (Tabela C.4) e wss:// do ponto de entrada do dispositivo remoto (Tabela C.76). Fonte:
// TV30_TLS_DIR (key.pem, cert.pem), senao HTTPS_KEY/HTTPS_CERT em base64; sem nenhum, so HTTP e ws://.
export type TlsMaterial = { key: Buffer; cert: Buffer; source: string };

export function loadTls(env: NodeJS.ProcessEnv = process.env): TlsMaterial | undefined {
    const dir = env.TV30_TLS_DIR?.trim();
    if (dir) {
        try {
            return {
                key: fs.readFileSync(path.join(dir, 'key.pem')),
                cert: fs.readFileSync(path.join(dir, 'cert.pem')),
                source: `TV30_TLS_DIR (${dir})`,
            };
        } catch { /* cai para as variaveis */ }
    }
    const key = env.HTTPS_KEY?.trim();
    const cert = env.HTTPS_CERT?.trim();
    if (key && cert) return { key: Buffer.from(key, 'base64'), cert: Buffer.from(cert, 'base64'), source: 'HTTPS_KEY/HTTPS_CERT' };
    return undefined;
}

let cached: TlsMaterial | undefined | null = null;
export function tlsMaterial(): TlsMaterial | undefined {
    if (cached === null) cached = loadTls();
    return cached;
}

// PEM em base64: a Tabela C.4 so diz "<X.509 cert>".
export function serverCert(): string | undefined {
    const t = tlsMaterial();
    return t ? t.cert.toString('base64') : undefined;
}

// TLS do ponto de entrada do dispositivo remoto. TV3WS_WS_TLS=false o abre em ws://, para demonstracao com
// aparelho que nao confia no certificado autoassinado. O ponto de entrada local sai sempre em ws://.
export function wsTls(env: NodeJS.ProcessEnv = process.env): boolean {
    const off = ['false', '0'].includes((env.TV3WS_WS_TLS ?? '').trim().toLowerCase());
    return !off && tlsMaterial() !== undefined;
}

export function _resetTlsCache(): void { cached = null; }
