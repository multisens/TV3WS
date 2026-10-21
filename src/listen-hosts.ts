import os from 'os';

// HTTP/HTTPS (nao as WebSocket dos dispositivos remotos). O tv3ws nao confere credencial (104, 106-108 sao da
// borda): fora do container, so loopback e o IPv4 da docker0, que no Linux e o host.docker.internal da borda
// e a LAN nao alcanca. No container, o compose define TV3WS_LISTEN_HOST=0.0.0.0.
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
