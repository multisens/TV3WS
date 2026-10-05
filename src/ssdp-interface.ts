import fs from 'fs';
import net from 'net';
import os from 'os';

// Interface por onde o anuncio SSDP sai. A C.3.4 nao trata disso: e decisao
// de implementacao deste testbed. Logica pura (a leitura do sistema entra por
// parametro), testada em test/ssdp-interface.test.ts.
//
// Sem a opcao `interfaces`, o @lvcabral/node-ssdp abre um socket por endereco
// IPv4 externo da maquina (lib/index.js, _createSockets), todos na 0.0.0.0:1900,
// e cada um responde a cada M-SEARCH por todos os sockets (_send). Em rede do
// host isso inclui eth0, docker0 e br-*: as respostas saem duplicadas (teste 7
// de docs/ssdp-verificacao.md).
//
// Ordem da escolha:
//  1. SSDP_INTERFACE (nome da interface): forca a escolha;
//  2. a interface que tem o IPv4 do host anunciado, quando ele e um IP local;
//  3. senao (nome, IPv6, IPv4 que nao esta em nenhuma interface), a interface
//     da rota padrao (/proc/net/route, so Linux), com aviso;
//  4. sem rota padrao legivel (fora do Linux, ex.: tv3ws no host em Windows),
//     fica o comportamento antigo da biblioteca (todas as interfaces), com aviso.

export type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export type InterfaceChoice = {
    // ausente = todas as interfaces IPv4 externas (padrao da biblioteca)
    name?: string;
    addresses: string[];
    source: 'SSDP_INTERFACE' | 'host-ip' | 'default-route' | 'all';
    warnings: string[];
};

// Mesmo filtro da biblioteca: IPv4 e nao interno.
export function externalIPv4(list: os.NetworkInterfaceInfo[] | undefined): string[] {
    return (list ?? []).filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
}

// Interface da rota padrao IPv4 a partir do texto de /proc/net/route: destino
// e mascara 00000000, flag RTF_UP (0x1); entre varias, a de menor metrica.
export function parseDefaultRoute(text: string): string | undefined {
    let best: { iface: string; metric: number } | undefined;
    for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 8) continue;
        const [iface, destination, , flags, , , metric, mask] = f;
        if (destination !== '00000000' || mask !== '00000000') continue;
        if ((parseInt(flags, 16) & 0x1) === 0) continue;
        const m = Number(metric);
        if (!best || m < best.metric) best = { iface, metric: m };
    }
    return best?.iface;
}

// undefined quando o arquivo nao existe (fora do Linux) ou nao ha rota padrao.
export function readDefaultRouteInterface(
    read: () => string = () => fs.readFileSync('/proc/net/route', 'utf8'),
): string | undefined {
    try {
        return parseDefaultRoute(read());
    } catch {
        return undefined;
    }
}

function describe(ifaces: Interfaces): string {
    const usable = Object.keys(ifaces).filter(n => externalIPv4(ifaces[n]).length > 0);
    return usable.length ? usable.map(n => `${n} (${externalIPv4(ifaces[n]).join(', ')})`).join(', ') : 'nenhuma';
}

function single(name: string, addresses: string[], source: InterfaceChoice['source'], warnings: string[]): InterfaceChoice {
    if (addresses.length > 1) {
        warnings.push(`a interface ${name} tem ${addresses.length} enderecos IPv4 (${addresses.join(', ')}): `
            + 'a biblioteca abre um socket por endereco e as respostas ao M-SEARCH saem duplicadas.');
    }
    return { name, addresses, source, warnings };
}

// host = o host anunciado ja normalizado (ssdp-config.ts, normalizeHost).
// SSDP_INTERFACE que nao existe ou nao tem IPv4 externo lanca Error: o
// chamador encerra o processo com log (D9), em vez de anunciar por outra.
export function chooseInterface(
    host: string,
    env: NodeJS.ProcessEnv,
    ifaces: Interfaces,
    defaultRoute: () => string | undefined,
): InterfaceChoice {
    const owner = net.isIPv4(host)
        ? Object.keys(ifaces).find(n => externalIPv4(ifaces[n]).includes(host))
        : undefined;

    const forced = (env.SSDP_INTERFACE ?? '').trim();
    if (forced) {
        const addresses = externalIPv4(ifaces[forced]);
        if (addresses.length === 0) {
            throw new Error(`SSDP_INTERFACE='${forced}' nao existe ou nao tem IPv4 externo `
                + `(interfaces com IPv4: ${describe(ifaces)})`);
        }
        const warnings = owner && owner !== forced
            ? [`SSDP_INTERFACE=${forced}, mas o host anunciado ${host} esta na interface ${owner}: `
                + `o anuncio sai pela ${forced} com LOCATION em outro endereco.`]
            : [];
        return single(forced, addresses, 'SSDP_INTERFACE', warnings);
    }

    if (owner) return single(owner, externalIPv4(ifaces[owner]), 'host-ip', []);

    const why = net.isIPv4(host)
        ? `o IPv4 ${host} nao esta em nenhuma interface externa desta maquina`
        : `'${host}' nao e um IPv4 (nome ou IPv6)`;
    const route = defaultRoute();
    const routeAddresses = route ? externalIPv4(ifaces[route]) : [];
    if (route && routeAddresses.length > 0) {
        return single(route, routeAddresses, 'default-route', [
            `host anunciado: ${why}; o anuncio sai pela interface da rota padrao ${route} `
            + `(${routeAddresses.join(', ')}). Defina SSDP_INTERFACE para escolher outra.`,
        ]);
    }

    const all = Object.keys(ifaces).flatMap(n => externalIPv4(ifaces[n]));
    const dup = all.length > 1 ? ' Com mais de uma, as respostas ao M-SEARCH saem duplicadas.' : '';
    return {
        addresses: all,
        source: 'all',
        warnings: [`host anunciado: ${why}, e nao ha rota padrao IPv4 legivel (/proc/net/route, so Linux): `
            + `o anuncio sai por todas as interfaces IPv4 (${describe(ifaces)}).${dup} Defina SSDP_INTERFACE.`],
    };
}
