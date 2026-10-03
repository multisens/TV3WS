import { getLocalIP } from './util/networking';

// Endereco que a descoberta SSDP divulga (C.3.4). Logica pura, sem socket,
// para ser testavel isoladamente (test/ssdp-config.test.ts).
//
// D10: o cliente acessa a BORDA (edgegateway), nao a implementacao interna.
// Por isso LOCATION e Server-BaseURL usam a porta da borda — 44642, fixa
// pela norma para o Server-BaseURL — e Server-SecureBaseURL a 44643, e nao
// HTTP_PORT/HTTPS_PORT do tv3ws (44652/44653 no container, nao publicadas).
// O anunciante continua no tv3ws; mover para a borda e lacuna sem decisao (L6).

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
// PENDENTE (Joel): lacuna L3 — a 44643 da borda ainda e HTTP puro (sem TLS),
// mas a C.3.4 preve https://<Server-SecureBaseURL>/tv3/<API>: o /manifest
// anuncia um endpoint seguro que nao existe. Ate a decisao da L3, falta
// escolher o que anunciar aqui (a porta da borda, como hoje, ou o HTTPS do
// proprio tv3ws, que nao e publicado no host).
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
// especificacao; o servidor SSDP so os registra no boot.
export function advertiseWarnings(e: AdvertisedEndpoint): string[] {
    const out: string[] = [];
    if (isLoopbackHost(e.host)) {
        // PENDENTE (Joel): o compose raiz passa SERVER_URL=localhost por padrao,
        // entao o anuncio padrao e de loopback. Falta decidir o padrao (cair no
        // IP local quando SERVER_URL for loopback, ou exigir SSDP_ADVERTISE_HOST).
        out.push(`host anunciado '${e.host}' (via ${e.source}) e de loopback: um cliente em outro `
            + 'equipamento recebe o anuncio mas nao alcanca o LOCATION nem o Server-BaseURL (C.3.4). '
            + 'Defina SSDP_ADVERTISE_HOST (tv3ws/.env) com o IP ou nome do equipamento na rede.');
    }
    if (e.httpPort !== DEFAULT_EDGE_HTTP_PORT) {
        out.push(`EDGE_HTTP_PORT=${e.httpPort}: a C.3.4 fixa ${DEFAULT_EDGE_HTTP_PORT} no Server-BaseURL; `
            + 'o anuncio fica fora da norma (use so para teste).');
    }
    out.push(`Server-SecureBaseURL ${secureBaseURL(e)} aponta para porta SEM TLS (a borda ainda nao tem `
        + 'HTTPS, lacuna L3): cliente que use https:// nesse endereco falha.');
    return out;
}
