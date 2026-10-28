// In-memory Redis double, with only the commands tv3ws uses. Injectable
// failure as ioredis with Redis down: a single command rejects, a pipeline
// resolves [error, null] per entry, MULTI rejects on EXEC. FCALL mimics the
// effect of the tv30 functions without checking the schema; recusar()
// simulates TV30SCHEMA.
type Value = string | Set<string> | Record<string, string>;

export const FAKE_REDIS_ERROR = 'redis indisponivel (duble de teste)';

export function createFakeRedis() {
    const store = new Map<string, Value>();
    let down = false;
    let singleDown = false;
    const recusas = new Map<string, string>();
    const fcalls: string[][] = [];

    const hash = (k: string): Record<string, string> | undefined => {
        const v = store.get(k);
        return v && typeof v === 'object' && !(v instanceof Set) ? v : undefined;
    };
    const set = (k: string): Set<string> | undefined => {
        const v = store.get(k);
        return v instanceof Set ? v : undefined;
    };
    const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

    // Synchronous commands; the async wrapper applies the injected failure.
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
        // Scan in a single pass (cursor '0' back).
        scan: (_cursor: string, _m: string, p: string) => ['0', [...store.keys()].filter(k => glob(p).test(k))] as [string, string[]],
        // Only FCALL <function> 0 ...args (see the functions below).
        call: (cmd: string, nome: string, numkeys: number | string, ...args: string[]) => {
            if (String(cmd).toUpperCase() !== 'FCALL') throw new Error(`call: comando ${cmd} nao suportado pelo duble`);
            if (Number(numkeys) !== 0) throw new Error(`TV30SCHEMA ${nome}: call with numkeys ${numkeys}`);
            fcalls.push([nome, ...args.map(String)]);
            const recusa = recusas.get(nome);
            if (recusa !== undefined) throw new Error(recusa);
            const f = funcoes[nome];
            if (!f) throw new Error('ERR Function not found');
            return f(args.map(String));
        },
    };

    // Field and value pairs from args[i].
    const paresDe = (a: string[], i = 0): Record<string, string> => {
        const h: Record<string, string> = {};
        for (let k = i; k + 1 < a.length; k += 2) h[a[k]] = a[k + 1];
        return h;
    };
    // Effect of the tv30 functions tv3ws calls (infra/redis/functions.lua).
    const funcoes: Record<string, (a: string[]) => unknown> = {
        tv30_session_user: ([v]) => { store.set('session:current-user', v); return 1; },
        tv30_session_service_id: ([v]) => { store.set('session:current-service-id', v); return 1; },
        tv30_session_service: (a) => { store.set('session:current-service', paresDe(a)); return 1; },
        tv30_broadcaster_attributes: ([id, scid, ...a]) => {
            if (!set('users:index')?.has(id)) throw new Error(`TV30SCHEMA tv30_broadcaster_attributes: user:${id}:broadcaster-attrs:${scid} profile "${id}" outside users:index (invariant profile-dependents)`);
            const k = `user:${id}:broadcaster-attrs:${scid}`;
            const h = { ...(hash(k) ?? {}) };
            const pedidos = paresDe(a);
            for (const [f, v] of Object.entries(pedidos)) { if (v === '') delete h[f]; else h[f] = v; }
            if (Object.keys(h).length) store.set(k, h); else store.delete(k);
            return Object.keys(pedidos).length;
        },
        tv30_client_write: ([id, ...a]) => { ops.hset(`client:${id}`, paresDe(a)); return 1; },
        tv30_client_authorize: ([id, ...a]) => {
            ops.hset(`client:${id}`, paresDe(a));
            ops.srem('clients:blocked', id);
            ops.sadd('clients:authorized', id);
            return 1;
        },
        tv30_client_block: ([id]) => { ops.srem('clients:authorized', id); ops.sadd('clients:blocked', id); return 1; },
        tv30_client_add_authorized: ([id]) => {
            if (set('clients:blocked')?.has(id)) return 0;
            if (!hash(`client:${id}`)) throw new Error(`TV30SCHEMA tv30_client_add_authorized: client:${id} absent: only who has the record enters clients:authorized (invariant authorized-has-record)`);
            return ops.sadd('clients:authorized', id);
        },
        tv30_v100_remote_device_write: ([handle, ...a]) => { store.set(`v100.0:remote-device:${handle}`, paresDe(a)); return 1; },
        tv30_v100_remote_device_remove: ([handle]) => ops.del(`v100.0:remote-device:${handle}`),
        tv30_v100_remote_devices_clear: () => ops.del(...ops.keys('v100.0:remote-device:*')),
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
        fcalls,
        setDown(v: boolean, scope: 'all' | 'batches' = 'all') {
            down = v;
            singleDown = v && scope === 'all';
        },
        // message = refusal of the function as Redis sends it; undefined goes
        // back to normal.
        recusar(nome: string, mensagem?: string) {
            if (mensagem === undefined) recusas.delete(nome);
            else recusas.set(nome, mensagem);
        },
    };
}
