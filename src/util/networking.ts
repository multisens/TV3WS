import os from 'os';

export function getLocalIP(): string {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      const ifaceList = interfaces[name];
      if (!ifaceList) continue;

      for (const iface of ifaceList) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
}

// Classe de cliente nao se infere de endereco (P1): e decidida na
// autorizacao (client-identification/controller.ts, classifyClient) e
// conferida na borda (D-0510-1, reuniao 05/10 com o Joel). Sairam daqui o
// isLocalClient (faixa RFC1918) e o getClientIP/findIPinReq que so servia a
// ele.