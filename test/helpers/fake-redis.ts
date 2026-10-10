// Duble de Redis em memoria para os testes de unidade (sem servidor). Cobre
// so os comandos que o tv3ws usa. Falha injetavel imitando o ioredis com o
// Redis fora do ar: comando avulso REJEITA; pipeline RESOLVE com [erro, null]
// em cada entrada; MULTI rejeita no EXEC. setDown(true, 'batches') derruba so
// pipeline/MULTI (para exercitar o tratamento do resultado por entrada).
type Value = string | Set<string> | Record<string, string>;

export const FAKE_REDIS_ERROR = 'redis indisponivel (duble de teste)';

export function createFakeRedis() {
    const store = new Map<string, Value>();
    let down = false;
    let singleDown = false;

    const hash = (k: string): Record<string, string> | undefined => {
        const v = store.get(k);
        return v && typeof v === 'object' && !(v instanceof Set) ? v : undefined;
    };
    const set = (k: string): Set<string> | undefined => {
        const v = store.get(k);
        return v instanceof Set ? v : undefined;
    };
    const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

    // comandos sincronos; o wrapper async aplica a falha injetada
    const ops = {
        get: (k: string) => (typeof store.get(k) === 'string' ? store.get(k) as string : null),
        set: (k: string, v: string) => { store.set(k, v); return 'OK'; },
        hget: (k: string, f: string) => hash(k)?.[f] ?? null,
        hset: (k: string, a: Record<string, string> | string, b?: string) => {
            const fields = typeof a === 'string' ? { [a]: String(b) } : a;
            store.set(k, { ...(hash(k) ?? {}), ...fields });
            return Object.keys(fields).length;
        },
        hgetall: (k: string) => ({ ...(hash(k) ?? {}) }),
        hdel: (k: string, ...fs: string[]) => {
            const h = hash(k); if (!h) return 0;
            let n = 0; fs.forEach(f => { if (f in h) { delete h[f]; n++; } });
            return n;
        },
        del: (...ks: string[]) => ks.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0),
        exists: (k: string) => (store.has(k) ? 1 : 0),
        sismember: (k: string, m: string) => (set(k)?.has(m) ? 1 : 0),
        sadd: (k: string, ...ms: string[]) => {
            const s = set(k) ?? new Set<string>();
            let n = 0; ms.forEach(m => { if (!s.has(m)) { s.add(m); n++; } });
            store.set(k, s);
            return n;
        },
        srem: (k: string, ...ms: string[]) => {
            const s = set(k); if (!s) return 0;
            let n = 0; ms.forEach(m => { if (s.delete(m)) n++; });
            if (s.size === 0) store.delete(k);
            return n;
        },
        smembers: (k: string) => [...(set(k) ?? [])],
        scard: (k: string) => set(k)?.size ?? 0,
        keys: (p: string) => [...store.keys()].filter(k => glob(p).test(k)),
        // varredura numa passada so (cursor '0' de volta)
        scan: (_cursor: string, _m: string, p: string) => ['0', [...store.keys()].filter(k => glob(p).test(k))] as [string, string[]],
        // so o script ADD_UNLESS_BLOCKED do auth-manager
        eval: (script: string, _n: number, k1: string, k2: string, member: string) => {
            if (!/SISMEMBER[\s\S]*SADD/.test(script)) throw new Error('eval: script nao suportado pelo duble');
            return ops.sismember(k2, member) === 0 ? ops.sadd(k1, member) : 0;
        },
    };
    type OpName = keyof typeof ops;

    function batch(kind: 'pipeline' | 'multi') {
        const queued: [OpName, unknown[]][] = [];
        const chain: Record<string, unknown> = {};
        (Object.keys(ops) as OpName[]).forEach(name => {
            chain[name] = (...args: unknown[]) => { queued.push([name, args]); return chain; };
        });
        chain.exec = async () => {
            if (down && kind === 'multi') throw new Error(FAKE_REDIS_ERROR);
            return queued.map(([name, args]) => {
                if (down) return [new Error(FAKE_REDIS_ERROR), null];
                try { return [null, (ops[name] as (...a: unknown[]) => unknown)(...args)]; }
                catch (e) { return [e as Error, null]; }
            });
        };
        return chain as any;
    }

    const client: Record<string, unknown> = {};
    (Object.keys(ops) as OpName[]).forEach(name => {
        client[name] = async (...args: unknown[]) => {
            if (singleDown) throw new Error(FAKE_REDIS_ERROR);
            return (ops[name] as (...a: unknown[]) => unknown)(...args);
        };
    });
    client.pipeline = () => batch('pipeline');
    client.multi = () => batch('multi');

    return {
        redis: client as any,
        store,
        setDown(v: boolean, scope: 'all' | 'batches' = 'all') {
            down = v;
            singleDown = v && scope === 'all';
        },
    };
}
