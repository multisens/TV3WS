import redis from './redis-client';

// Unico ponto de escrita do tv3ws em session:*, client:*, clients:* e user:{id}:broadcaster-attrs:{scid}
// (test/redis-escritas.test.ts confere): FCALL as funcoes de infra/redis/funcoes.lua, que conferem o esquema
// e gravam atomicamente; esquema invalido = erro TV30ESQUEMA e nada gravado. numkeys 0: chaves nos argumentos.

function fcall(nome: string, args: string[]): Promise<unknown> {
    return redis.call('FCALL', nome, 0, ...args);
}

function pares(campos: Record<string, string>): string[] {
    return Object.keys(campos).sort().flatMap(k => [k, campos[k]]);
}

// session:current-user; vazio = sem usuario corrente
export function sessaoUsuario(id: string): Promise<unknown> {
    return fcall('tv30_sessao_usuario', [id]);
}

// session:current-service-id; vazio = sem servico corrente
export function sessaoServicoId(sid: string): Promise<unknown> {
    return fcall('tv30_sessao_servico_id', [sid]);
}

// session:current-service, regravado inteiro (os cinco campos da Tabela C.8)
export function sessaoServico(campos: Record<string, string>): Promise<unknown> {
    return fcall('tv30_sessao_servico', pares(campos));
}

// C.6.14.5: valor '' remove o atributo; o teto de 20 MB e conferido no resultado.
// Devolve o numero de campos alterados.
export async function atributosEmissora(id: string, scid: string, atributos: Record<string, string>): Promise<number> {
    return Number(await fcall('tv30_atributos_emissora', [id, scid, ...pares(atributos)]));
}

// client:{id}: acrescenta ou troca campos (class, refreshToken, accessToken)
export function clienteGrava(id: string, campos: Record<string, string>): Promise<unknown> {
    return fcall('tv30_cliente_grava', [id, ...pares(campos)]);
}

// client:{id} + sai de clients:blocked + entra em clients:authorized
export function clienteAutoriza(id: string, campos: Record<string, string>): Promise<unknown> {
    return fcall('tv30_cliente_autoriza', [id, ...pares(campos)]);
}

// sai de clients:authorized + entra em clients:blocked (client:{id} fica)
export function clienteBloqueia(id: string): Promise<unknown> {
    return fcall('tv30_cliente_bloqueia', [id]);
}

// boot: inclui em clients:authorized quem tem client:{id} e nao esta
// bloqueado. Devolve 1 se incluiu, 0 se nao.
export async function clienteIncluiAutorizado(id: string): Promise<number> {
    return Number(await fcall('tv30_cliente_inclui_autorizado', [id]));
}
