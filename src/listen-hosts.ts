import os from 'os';

// Addresses the HTTP/HTTPS servers listen on (not the WebSockets of the
// remote devices): TV3WS_LISTEN_HOST, comma-separated, if set; otherwise
// loopback and the IPv4 of docker0.
export function listenHosts(
    env: NodeJS.ProcessEnv = process.env,
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
    const forced = (env.TV3WS_LISTEN_HOST ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (forced.length) return forced;
    const hosts = ['127.0.0.1'];
    for (const a of interfaces.docker0 ?? []) {
        if (a.family === 'IPv4' && !a.internal && !hosts.includes(a.address)) hosts.push(a.address);
    }
    return hosts;
}
