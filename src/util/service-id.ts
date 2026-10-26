// serviceId is an integer in Table C.8 (@serviceId of the <Service> of the
// SLT). A number, or a text of digits only, becomes an integer; anything
// else (the -1 of unknown, undefined, null) gives undefined.
export function integerServiceId(raw: unknown): number | undefined {
    if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
    return undefined;
}
