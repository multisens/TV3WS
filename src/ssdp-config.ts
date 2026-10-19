import { getLocalIP } from './util/networking';

// Endereco que o /manifest divulga (C.3.4). Logica pura, sem socket, para ser
// testavel isoladamente (test/ssdp-config.test.ts).
//
// D10: o cliente acessa a BORDA (edgegateway), nao a implementacao interna.
// Por isso Server-BaseURL usa a porta da borda — 44642, fixa pela norma — e
// Server-SecureBaseURL a 44643, e nao HTTP_PORT/HTTPS_PORT do tv3ws
// (44652/44653 no container, nao publicadas). Quem anuncia e o anunciante
// nativo do host (infra/edgegateway/ssdp, ./tv30 up; complemento do Joel de
// 15/10); o anunciante Node que este modulo servia no dev-host saiu nessa
// data. O host de cada resposta do /manifest sai da requisicao
// (src/manifest.ts); a cadeia daqui (SSDP_ADVERTISE_HOST > SERVER_URL > IP
// local) da a sobreposicao e o ultimo recurso.

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

// <host> = SSDP_ADVERTISE_HOST, senao SERVER_URL, senao o IP local (o
// comportamento antigo). Porta invalida lanca Error (o boot morre com log).
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
// A7 (Joel, 15/10): a 44643 da borda tem TLS (certificado autoassinado do
// receptor, tls-init); o /manifest anuncia a 44643 no Server-SecureBaseURL, e
// o cliente monta https:// (C.3.4).
export const secureBaseURL = (e: AdvertisedEndpoint): string => `${e.host}:${e.httpsPort}`;
export const locationURL = (e: AdvertisedEndpoint): string => `http://${baseURL(e)}/manifest`;

// Host de loopback: localhost, *.localhost, 127.0.0.0/8, ::1.
export function isLoopbackHost(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h)
        || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

// Avisos sobre o que vai ser anunciado (D9: nada em silencio). Nao mudam o
// anuncio — a ordem SSDP_ADVERTISE_HOST > SERVER_URL > IP local e a da
// especificacao; o /manifest (src/manifest.ts) so os registra no boot.
export function advertiseWarnings(e: AdvertisedEndpoint): string[] {
    const out: string[] = [];
    if (e.source === 'SSDP_ADVERTISE_HOST' && isLoopbackHost(e.host)) {
        // So a sobreposicao fixa o host do /manifest (src/manifest.ts); sem
        // ela, o host sai da requisicao, e o SERVER_URL=localhost do compose
        // nao chega a ser usado.
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
