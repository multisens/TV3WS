import fs from 'fs';
import path from 'path';

// A7 (Joel, 15/10): o receptor tem UM certificado X.509 autoassinado (C.4.1.1:
// "it is valid for TV 3.0 WebServices to set up its HTTPS server using a
// certificate self-signed by the platform"), gerado na primeira subida pelo
// servico tls-init do compose e guardado em .tv30/tls, sem acao do usuario. O
// mesmo certificado vai:
//   - na borda, que termina o TLS da 44643 (Server-SecureBaseURL);
//   - no HTTPS deste processo (44653, o backend da 44643);
//   - no serverCert do pareamento (Tabela C.4: o cliente so confia nele);
//   - nos pontos de entrada WebSocket de dispositivo remoto, em wss://
//     (Tabelas C.76 e C.80), com o TLS terminado aqui.
// Fonte: TV30_TLS_DIR (key.pem e cert.pem; o compose monta .tv30/tls em /tls).
// Sem ele, HTTPS_KEY/HTTPS_CERT em base64, como ate 15/10. Sem nenhum dos dois,
// o tv3ws sobe so em HTTP e os pontos de entrada saem em ws://.
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

// serverCert do pareamento: o PEM do certificado em base64 (o formato que o
// HTTPS_CERT ja tinha; a Tabela C.4 so diz "<X.509 cert>").
export function serverCert(): string | undefined {
    const t = tlsMaterial();
    return t ? t.cert.toString('base64') : undefined;
}

// wss:// nos pontos de entrada (A7). TV3WS_WS_TLS=false volta a ws://: um
// navegador nao abre wss:// com certificado autoassinado em que nao confia,
// entao uma demonstracao com app de navegador pode precisar disso.
export function wsTls(env: NodeJS.ProcessEnv = process.env): boolean {
    const off = ['false', '0'].includes((env.TV3WS_WS_TLS ?? '').trim().toLowerCase());
    return !off && tlsMaterial() !== undefined;
}

// so para os testes
export function _resetTlsCache(): void { cached = null; }
