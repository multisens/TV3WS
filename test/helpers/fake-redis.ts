// Duble de Redis em memoria para os testes de unidade (sem servidor). Cobre
// so os comandos que o tv3ws usa. Falha injetavel imitando o ioredis com o
// Redis fora do ar: comando avulso REJEITA; pipeline RESOLVE com [erro, null]
// em cada entrada; MULTI rejeita no EXEC. setDown(true, 'batches') derruba so
// pipeline/MULTI (para exercitar o tratamento do resultado por entrada).
//
// P4 (Luis, 10/10): as escritas do tv3ws nas familias do alcance sao
// call('FCALL', <funcao tv30>, 0, ...args) (src/redis-funcoes.ts). O duble
// imita o EFEITO de cada funcao usada pelo tv3ws, sem conferir o esquema — a
// conferencia e testada no Redis real (infra/redis/test/funcoes.test.js) e
// o contrato adaptador x funcao em infra/redis/test/contrato.test.js.
// recusar(funcao, mensagem) faz a funcao responder como o Redis responde a
// dado fora do esquema (erro TV30ESQUEMA), para testar o caminho de falha;
// fcalls guarda cada chamada [funcao, ...args].
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
        // so FCALL <funcao> 0 ...args (ver funcoes abaixo)
        call: (cmd: string, nome: string, numkeys: number | string, ...args: string[]) => {
            if (String(cmd).toUpperCase() !== 'FCALL') throw new Error(`call: comando ${cmd} nao suportado pelo duble`);
            if (Number(numkeys) !== 0) throw new Error(`TV30ESQUEMA ${nome}: chamada com numkeys ${numkeys}`);
            fcalls.push([nome, ...args.map(String)]);
            const recusa = recusas.get(nome);
            if (recusa !== undefined) throw new Error(recusa);
            const f = funcoes[nome];
            if (!f) throw new Error('ERR Function not found');
            return f(args.map(String));
        },
    };

    // pares campo valor a partir de args[i]
    const paresDe = (a: string[], i = 0): Record<string, string> => {
        const h: Record<string, string> = {};
        for (let k = i; k + 1 < a.length; k += 2) h[a[k]] = a[k + 1];
        return h;
    };
    // efeito das funcoes tv30 que o tv3ws chama (infra/redis/funcoes.lua)
    const funcoes: Record<string, (a: string[]) => unknown> = {
        tv30_sessao_usuario: ([v]) => { store.set('session:current-user', v); return 1; },
        tv30_sessao_servico_id: ([v]) => { store.set('session:current-service-id', v); return 1; },
        tv30_sessao_servico: (a) => { store.set('session:current-service', paresDe(a)); return 1; },
        tv30_atributos_emissora: ([id, scid, ...a]) => {
            if (!set('users:index')?.has(id)) throw new Error(`TV30ESQUEMA tv30_atributos_emissora: user:${id}:broadcaster-attrs:${scid} perfil "${id}" fora de users:index (invariante perfil-dependentes)`);
            const k = `user:${id}:broadcaster-attrs:${scid}`;
            const h = { ...(hash(k) ?? {}) };
            const pedidos = paresDe(a);
            for (const [f, v] of Object.entries(pedidos)) { if (v === '') delete h[f]; else h[f] = v; }
            if (Object.keys(h).length) store.set(k, h); else store.delete(k);
            return Object.keys(pedidos).length;
        },
        tv30_cliente_grava: ([id, ...a]) => { ops.hset(`client:${id}`, paresDe(a)); return 1; },
        tv30_cliente_autoriza: ([id, ...a]) => {
            ops.hset(`client:${id}`, paresDe(a));
            ops.srem('clients:blocked', id);
            ops.sadd('clients:authorized', id);
            return 1;
        },
        tv30_cliente_bloqueia: ([id]) => { ops.srem('clients:authorized', id); ops.sadd('clients:blocked', id); return 1; },
        tv30_cliente_inclui_autorizado: ([id]) => {
            if (set('clients:blocked')?.has(id)) return 0;
            if (!hash(`client:${id}`)) throw new Error(`TV30ESQUEMA tv30_cliente_inclui_autorizado: client:${id} ausente (invariante autorizado-tem-registro)`);
            return ops.sadd('clients:authorized', id);
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
        fcalls,
        setDown(v: boolean, scope: 'all' | 'batches' = 'all') {
            down = v;
            singleDown = v && scope === 'all';
        },
        // mensagem = recusa da funcao como o Redis a manda; undefined = volta ao normal
        recusar(nome: string, mensagem?: string) {
            if (mensagem === undefined) recusas.delete(nome);
            else recusas.set(nome, mensagem);
        },
    };
}
