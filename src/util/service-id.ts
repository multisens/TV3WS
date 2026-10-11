// "serviceId" e inteiro na Tabela C.8 (@serviceId do <Service> da SLT).
// Inteiro nao negativo, em numero ou em texto so de digitos (o JSON de
// aop/services nao tem esquema); qualquer outra coisa (o -1 inicial,
// undefined, null) -> sem valor.
// Usado na resposta da C.6.3.1 (api/aop-communication/current-service) e no
// hash session:current-service (core.ts), que o esquema do Redis (P4,
// infra/redis/esquema.json) aceita so com inteiro em decimal ou vazio.
export function integerServiceId(raw: unknown): number | undefined {
    if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
    return undefined;
}
