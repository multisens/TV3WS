import crypto from 'crypto';
import http from 'http';
import { stringFromEnv } from '../../util';

// Reads a file of an application through the object proxy, at the origin of
// its Application Context ID.

export type ProxyResponse = {
    status: number;
    contentType: string;
    body: Buffer;
};

// The label of the origin of a context: ctx- and the first 16 hexadecimal
// digits of the SHA-256 of the appContextId in UTF-8.
const CONTEXT_LABEL_PREFIX = 'ctx-';
const CONTEXT_HASH_DIGITS = 16;

// GET <app:{appContextId}>/{location}, with the Host of the origin of the
// context; rejects only when the object proxy cannot be reached.
// OBJECT_PROXY_URL and APPS_DOMAIN are checked at startup (boot-env.ts).
export function getApplicationFile(appContextId: string, location: string): Promise<ProxyResponse> {
    const proxyUrl = new URL(stringFromEnv('OBJECT_PROXY_URL'));
    const path = '/' + location.split('/').map(encodeURIComponent).join('/');
    const host = `${contextLabel(appContextId)}.${stringFromEnv('APPS_DOMAIN')}`;
    return new Promise((resolve, reject) => {
        const request = http.get({
            hostname: proxyUrl.hostname,
            port: proxyUrl.port,
            path,
            headers: { Host: host },
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode ?? 0,
                contentType: response.headers['content-type'] ?? '',
                body: Buffer.concat(chunks),
            }));
            response.on('error', reject);
        });
        request.on('error', reject);
    });
}

function contextLabel(appContextId: string): string {
    const digest = crypto.createHash('sha256').update(appContextId, 'utf8').digest('hex');
    return CONTEXT_LABEL_PREFIX + digest.slice(0, CONTEXT_HASH_DIGITS);
}
