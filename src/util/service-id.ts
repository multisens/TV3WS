// serviceId e inteiro na Tabela C.8 (@serviceId do <Service> da SLT), que o testbed nao tem. Numero
// ou texto so de digitos vira inteiro; o resto (o -1 de desconhecido, undefined, null) fica sem valor.
export function integerServiceId(raw: unknown): number | undefined {
    if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
    return undefined;
}
