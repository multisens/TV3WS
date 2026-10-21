import { getLocalIP } from './util/networking';

// Endereco que o /manifest divulga (C.3.4). As portas sao as da borda (44642, fixa pela norma, e 44643),
// nao HTTP_PORT/HTTPS_PORT do tv3ws, que nao sao publicadas. O host daqui so vale como sobreposicao
// (SSDP_ADVERTISE_HOST) ou ultimo recurso; o normal e o da requisicao (src/manifest.ts).

export const SSDP_ST = 'urn:schemas-sbtvd-org:service:TV3.0WebServices:1';

export const DEFAULT_EDGE_HTTP_PORT = 44642;
export const DEFAULT_EDGE_HTTPS_PORT = 44643;

export type AdvertisedEndpoint = {
    host: string;
    source: 'SSDP_ADVERTISE_HOST' | 'SERVER_URL' | 'local-ip';
    httpPort: number;
    httpsPort: number;
};

// Host "puro" a partir do valor configurado: tira esquema, caminho e porta
// ("http://192.168.1.150:44642/x" -> "192.168.1.150"); IPv6 sai entre
// colchetes, como o formato <ip_or_hostname>:<port> exige.
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

// <host> = SSDP_ADVERTISE_HOST, senao SERVER_URL, senao o IP local. Porta invalida lanca Error.
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

// Avisos registrados no boot; nao mudam o que e anunciado.
export function advertiseWarnings(e: AdvertisedEndpoint): string[] {
    const out: string[] = [];
    if (e.source === 'SSDP_ADVERTISE_HOST' && isLoopbackHost(e.host)) {
        // so a sobreposicao fixa o host; sem ela, o host sai da requisicao
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
