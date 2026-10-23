import { getLocalIP } from './util/networking';

// Address the /manifest announces (C.3.4). The ports are those of the edge
// (44642, fixed by the standard, and 44643), not HTTP_PORT/HTTPS_PORT of
// tv3ws. The host here is only an override (SSDP_ADVERTISE_HOST) or a last
// resort; normally it comes from the request (src/manifest.ts).

export const SSDP_ST = 'urn:schemas-sbtvd-org:service:TV3.0WebServices:1';

export const DEFAULT_EDGE_HTTP_PORT = 44642;
export const DEFAULT_EDGE_HTTPS_PORT = 44643;

export type AdvertisedEndpoint = {
    host: string;
    source: 'SSDP_ADVERTISE_HOST' | 'SERVER_URL' | 'local-ip';
    httpPort: number;
    httpsPort: number;
};

// Bare host from the configured value: removes scheme, path and port
// ("http://192.168.1.150:44642/x" becomes "192.168.1.150"); an IPv6 address
// comes out in brackets, as the <ip_or_hostname>:<port> format requires.
export function normalizeHost(raw: string | undefined): string {
    let h = (raw ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    h = h.split('/')[0];
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        return end > 0 ? h.slice(0, end + 1) : '';
    }
    const colons = (h.match(/:/g) ?? []).length;
    if (colons === 1) return h.slice(0, h.indexOf(':'));
    if (colons > 1) return `[${h}]`;
    return h;
}

export function parsePort(name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`${name}='${raw}' is not a valid TCP port`);
    }
    return n;
}

// <host> = SSDP_ADVERTISE_HOST, otherwise SERVER_URL, otherwise the local IP.
// An invalid port throws an Error.
export function resolveAdvertisedEndpoint(
    env: NodeJS.ProcessEnv = process.env,
    localIP: () => string = getLocalIP,
): AdvertisedEndpoint {
    const httpPort = parsePort('EDGE_HTTP_PORT', env.EDGE_HTTP_PORT, DEFAULT_EDGE_HTTP_PORT);
    const httpsPort = parsePort('EDGE_HTTPS_PORT', env.EDGE_HTTPS_PORT, DEFAULT_EDGE_HTTPS_PORT);

    const advertise = normalizeHost(env.SSDP_ADVERTISE_HOST);
    if (advertise) return { host: advertise, source: 'SSDP_ADVERTISE_HOST', httpPort, httpsPort };

    const serverUrl = normalizeHost(env.SERVER_URL);
    if (serverUrl) return { host: serverUrl, source: 'SERVER_URL', httpPort, httpsPort };

    return { host: localIP(), source: 'local-ip', httpPort, httpsPort };
}

export const baseURL = (e: AdvertisedEndpoint): string => `${e.host}:${e.httpPort}`;
export const secureBaseURL = (e: AdvertisedEndpoint): string => `${e.host}:${e.httpsPort}`;
export const locationURL = (e: AdvertisedEndpoint): string => `http://${baseURL(e)}/manifest`;

export function isLoopbackHost(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h)
        || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

// Warnings logged at startup; they do not change what is announced.
export function advertiseWarnings(e: AdvertisedEndpoint): string[] {
    const out: string[] = [];
    if (e.source === 'SSDP_ADVERTISE_HOST' && isLoopbackHost(e.host)) {
        // Only the override fixes the host; without it, the host comes from the
        // request.
        out.push(`host anunciado '${e.host}' (via ${e.source}) e de loopback: um cliente em outro `
            + 'equipamento recebe o anuncio mas nao alcanca o LOCATION nem o Server-BaseURL (C.3.4). '
            + 'Defina SSDP_ADVERTISE_HOST com o IP ou nome do equipamento na rede (no compose: .env da raiz '
            + 'ou tv3ws/.env; com npm run dev: tv3ws/.env).');
    }
    if (e.httpPort !== DEFAULT_EDGE_HTTP_PORT) {
        out.push(`EDGE_HTTP_PORT=${e.httpPort}: a C.3.4 fixa ${DEFAULT_EDGE_HTTP_PORT} no Server-BaseURL; `
            + 'o anuncio fica fora da norma (use so para teste).');
    }
    return out;
}
