import os from 'os';

// Enderecos em que o tv3ws escuta as portas HTTP e HTTPS (nao as WebSocket
// dos dispositivos remotos, que ficam abertas a rede de proposito). Joel,
// 15/10 ("Porta do tv3ws no dev-host"): desde a D-0510-1 o tv3ws nao confere
// credencial, e quem o alcanca direto escapa de 104, 106, 107 e 108 (condicao
// de validade de Escopo e desenho 6.2). Fora do container, a porta dele so
// pode ser alcancavel da propria maquina, por padrao, sem configuracao do
// usuario; o meio concreto varia com o sistema:
//   - em container, o compose define TV3WS_LISTEN_HOST=0.0.0.0: a borda chega
//     pela ginga_net, e a porta nao e publicada no host;
//   - no host (npm run dev, dev-host), o padrao e o loopback (127.0.0.1). No
//     Docker Desktop (Mac, Windows) e no Colima, o host.docker.internal da
//     borda chega ao loopback do host. No Linux com Docker Engine ele e o IP
//     da docker0 (host-gateway), entao esse IPv4, se existir, entra tambem: a
//     LAN nao alcanca a docker0, e o dev-host continua funcionando.
// Ate 15/10 o listen nao informava host: todas as interfaces.
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
