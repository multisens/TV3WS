import redis from './redis-client';

// The only write point of tv3ws to session:*, client:*, clients:* and
// user:{id}:broadcaster-attrs:{scid}: FCALL of the tv30 functions, which
// check the schema and write atomically; data outside the schema gives a
// TV30ESQUEMA error and nothing is written. numkeys 0: keys in the
// arguments.

function fcall(nome: string, args: string[]): Promise<unknown> {
    return redis.call('FCALL', nome, 0, ...args);
}

function pares(campos: Record<string, string>): string[] {
    return Object.keys(campos).sort().flatMap(k => [k, campos[k]]);
}

// session:current-user; empty for no current user.
export function sessaoUsuario(id: string): Promise<unknown> {
    return fcall('tv30_sessao_usuario', [id]);
}

// session:current-service-id; empty for no current service.
export function sessaoServicoId(sid: string): Promise<unknown> {
    return fcall('tv30_sessao_servico_id', [sid]);
}

// session:current-service, rewritten whole (the five fields of Table C.8).
export function sessaoServico(campos: Record<string, string>): Promise<unknown> {
    return fcall('tv30_sessao_servico', pares(campos));
}

// C.6.14.5: the value '' removes the attribute; the 20 MB limit is checked
// on the result. Returns the number of fields changed.
export async function atributosEmissora(id: string, scid: string, atributos: Record<string, string>): Promise<number> {
    return Number(await fcall('tv30_atributos_emissora', [id, scid, ...pares(atributos)]));
}

// client:{id}: adds or replaces fields (class, refreshToken, accessToken).
export function clienteGrava(id: string, campos: Record<string, string>): Promise<unknown> {
    return fcall('tv30_cliente_grava', [id, ...pares(campos)]);
}

// client:{id}, leaves clients:blocked and enters clients:authorized.
export function clienteAutoriza(id: string, campos: Record<string, string>): Promise<unknown> {
    return fcall('tv30_cliente_autoriza', [id, ...pares(campos)]);
}

// Leaves clients:authorized and enters clients:blocked (client:{id} stays).
export function clienteBloqueia(id: string): Promise<unknown> {
    return fcall('tv30_cliente_bloqueia', [id]);
}

// Adds to clients:authorized an id that has client:{id} and is not blocked.
// Returns 1 if added, 0 otherwise.
export async function clienteIncluiAutorizado(id: string): Promise<number> {
    return Number(await fcall('tv30_cliente_inclui_autorizado', [id]));
}
