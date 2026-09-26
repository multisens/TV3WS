import { Request } from 'express';
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

function findIPinReq(req: Request): string {
    // Se o peer TCP eh localhost, a requisicao chegou via nosso relay/gateway
    // local — confiar no socket addr e ignorar X-Forwarded-For (que pode
    // conter IP do client original, fazendo isLocalClient retornar false
    // mesmo o caminho sendo trusted).
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (peer && (peer === '127.0.0.1' || peer === '::1')) {
        return peer;
    }

    var aux = req.get('x-forwarded-for');
    if (aux) {
        var ips = (aux as string).split(',');
        return ips[0].trim();
    }

    aux = req.get('x-real-ip');
    if (aux) {
        return aux as string;
    }

    return req.socket.remoteAddress || req.ip || '0.0.0.0';
}

export function getClientIP(req: Request): string {
    return findIPinReq(req).replace(/^::ffff:/, '');
}

// isLocalClient (teste de faixa RFC1918) foi REMOVIDO: classe de cliente e
// decidida na autorizacao e lida da credencial (P1) — em conteineres, o
// proprio equipamento e a rede domestica chegam com o mesmo endereco, entao
// endereco de origem nao classifica nada. Ver auth-manager/manager.ts
// (getRequestClass) e apis/access/controller.ts (classifyClient).