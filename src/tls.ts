import fs from 'fs';
import path from 'path';

// Self-signed certificate of the receiver: HTTPS, serverCert of the pairing
// (Table C.4) and wss:// of the entry point of the remote device (Table
// C.76). Source: TV30_TLS_DIR (key.pem, cert.pem), otherwise HTTPS_KEY and
// HTTPS_CERT in base64; without any, only HTTP and ws://.
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
        } catch {
            // Falls back to the variables.
        }
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

// PEM in base64 (Table C.4: "<X.509 cert>").
export function serverCert(): string | undefined {
    const t = tlsMaterial();
    return t ? t.cert.toString('base64') : undefined;
}

// TLS of the entry point of the remote device. TV3WS_WS_TLS=false opens it
// as ws://. The local entry point is always ws://.
export function wsTls(env: NodeJS.ProcessEnv = process.env): boolean {
    const off = ['false', '0'].includes((env.TV3WS_WS_TLS ?? '').trim().toLowerCase());
    return !off && tlsMaterial() !== undefined;
}

export function _resetTlsCache(): void { cached = null; }
