import redis from '../../redis-client';
import logger from '../../logger';
import core from '../../core';
import { ApiError } from '../../util';
import {
    BindAlg, BindKeyEntry, decodeBindToken, evaluateBindToken, parseStoredEntry, sameKey, sameRegisteredKey,
} from './bind-token';

// Armazenamento das chaves de bind (C.6.8). Uma LIST por servico:
//   bind-context:{serviceId} -> JSON {"alg","key","registeredAt"}
// serviceId = valor de session:current-service-id (URN gravado pelo tv3ws a
// partir do MQTT aop/currentService) no momento do registro. A borda
// (plugin tv30-auth do edgegateway) le as mesmas listas para validar o
// bind-token das demais APIs; aqui so as tres rotas da C.6.8.

const KEY_CURRENT_SERVICE_ID = 'session:current-service-id';
const KEY_CURRENT_SERVICE = 'session:current-service';
const PREFIX = 'bind-context:';

export const bindContextKey = (serviceId: string): string => `${PREFIX}${serviceId}`;

// Item de boundServices no formato da resposta da C.6.3.1 (Tabela C.8:
// "serviceId": integer). session:current-service guarda o serviceId em
// texto (core.ts); aqui ele volta a numero quando e numerico. O GET
// /tv3/current-service deste testbed ainda o devolve em texto (anterior a
// esta API, nao mexido).
export type BoundService = {
    serviceContextId: string;
    serviceName?: string;
    serviceId?: number;
};

async function currentServiceId(): Promise<string> {
    return (await redis.get(KEY_CURRENT_SERVICE_ID)) ?? '';
}

// Sem servico sintonizado nao ha a que vincular a chave. A norma nao lista
// erro para isso na C.47 (silente); 300 e o codigo do catalogo para "No DTV
// service currently in use". So o registro usa: a revogacao sem servico
// corrente responde sucesso (C.49: sucesso se a chave nao existe).
async function requireCurrentServiceId(): Promise<string> {
    const serviceId = await currentServiceId();
    if (!serviceId) throw new ApiError(300, 'no DTV service selected for the bind context');
    return serviceId;
}

// C.6.8.2: grava (alg, key) na lista do servico corrente. Mesmo par ja
// registrado nao entra de novo (sem duplicata).
export async function registerKey(alg: BindAlg, key: string): Promise<{ serviceId: string; added: boolean }> {
    const serviceId = await requireCurrentServiceId();
    const listKey = bindContextKey(serviceId);

    const existing = await redis.lrange(listKey, 0, -1);
    const duplicate = existing
        .map(parseStoredEntry)
        .some(e => e !== null && e.alg === alg && sameRegisteredKey(alg, e.key, key));
    if (duplicate) {
        logger.info(`[bind-context] ${alg} ja registrada para ${serviceId}; nada a fazer`);
        return { serviceId, added: false };
    }

    const entry: BindKeyEntry = { alg, key, registeredAt: Date.now() };
    await redis.rpush(listKey, JSON.stringify(entry));
    logger.info(`[bind-context] ${alg} registrada para ${serviceId}`);
    return { serviceId, added: true };
}

// C.6.8.4: remove a chave da lista do servico corrente; sucesso mesmo se
// ela nao existir (Tabela C.49) — inclusive sem servico corrente, quando nao
// ha lista de que remover. O cabecalho "key" nao traz alg: sai toda entrada
// com a mesma chave.
// PENDENTE (Joel): ao revogar, a C.4.4 manda liberar os recursos
// compartilhados que a aplicacao usava — nao implementado (L7).
export async function revokeKey(key: string): Promise<{ serviceId: string; removed: number }> {
    const serviceId = await currentServiceId();
    if (!serviceId) {
        logger.info('[bind-context] revogacao sem servico corrente: nada a remover');
        return { serviceId, removed: 0 };
    }
    const listKey = bindContextKey(serviceId);

    const raws = new Set(await redis.lrange(listKey, 0, -1));
    let removed = 0;
    for (const raw of raws) {
        const entry = parseStoredEntry(raw);
        if (entry && sameKey(entry.key, key)) {
            removed += await redis.lrem(listKey, 0, raw);
        }
    }
    logger.info(`[bind-context] revogacao em ${serviceId}: ${removed} entrada(s) removida(s)`);
    return { serviceId, removed };
}

// Todas as listas bind-context:* (SCAN, nao KEYS). Entrada malformada ou
// chave de outro tipo e ignorada com log — nao derruba a consulta.
async function readAllBindContexts(): Promise<Map<string, BindKeyEntry[]>> {
    const keys = new Set<string>();
    let cursor = '0';
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 100);
        cursor = next;
        batch.forEach(k => keys.add(k));
    } while (cursor !== '0');

    const contexts = new Map<string, BindKeyEntry[]>();
    for (const listKey of keys) {
        let raws: string[];
        try {
            raws = await redis.lrange(listKey, 0, -1);
        } catch (err) {
            logger.error(`[bind-context] ${listKey} ilegivel, ignorada: ${(err as Error).message}`);
            continue;
        }
        const entries = raws.map(parseStoredEntry).filter((e): e is BindKeyEntry => e !== null);
        if (entries.length < raws.length) {
            logger.error(`[bind-context] ${listKey}: ${raws.length - entries.length} entrada(s) malformada(s) ignorada(s)`);
        }
        if (entries.length > 0) contexts.set(listKey.slice(PREFIX.length), entries);
    }
    return contexts;
}

// C.6.8.3: servicos cujas chaves validam o bind-token. Codigos da Tabela
// C.48: 108 se nao e JWT valido, 101 se a assinatura nao confere com
// nenhuma chave registrada. Token com assinatura valida mas fora do prazo
// (nbf/exp/iat): a C.48 e silente; usamos 108 (Tabela C.1: "invalid").
export async function boundServices(token: string): Promise<BoundService[]> {
    if (!decodeBindToken(token)) throw new ApiError(108, 'bind-token is not a valid JWT');

    const contexts = await readAllBindContexts();
    const verdict = evaluateBindToken(token, contexts, Math.floor(Date.now() / 1000));
    if (verdict.kind === 'malformed') throw new ApiError(108, 'bind-token is not a valid JWT');
    if (verdict.kind === 'bad-signature') {
        throw new ApiError(101, 'signature not validated by any registered key, bind-token');
    }
    if (verdict.kind === 'bad-time') throw new ApiError(108, verdict.detail);

    // Nome/id so se conhecem para o servico corrente (session:current-service);
    // para os demais nao ha fonte no testbed e os campos sao omitidos (C.3.2.2).
    // PENDENTE (Joel): serviceContextId e a constante do core, igual para todo
    // servico (L2) — itens de servicos diferentes saem indistinguiveis. A
    // C.6.3.1 define serviceContextId como o @globalServiceId (URN), que e o
    // que session:current-service-id guarda.
    const currentId = await currentServiceId();
    const current = currentId && verdict.services.includes(currentId)
        ? await redis.hgetall(KEY_CURRENT_SERVICE)
        : {};

    return verdict.services.map(serviceId => {
        const item: BoundService = { serviceContextId: core.current.serviceContextId };
        if (serviceId === currentId) {
            if (current.serviceName) item.serviceName = current.serviceName;
            if (current.serviceId && /^[0-9]+$/.test(current.serviceId)) item.serviceId = Number(current.serviceId);
        }
        return item;
    });
}

export default { registerKey, revokeKey, boundServices };
