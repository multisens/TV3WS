import redis from './redis-client';

// P4 (decisao do Luis em 10/10, "Funcoes + auditoria"): ADAPTADOR UNICO das
// escritas do tv3ws nas familias do alcance (session:*, client:*,
// clients:authorized, clients:blocked e user:{id}:broadcaster-attrs:{scid}).
// Cada escrita e uma chamada FCALL a uma funcao da biblioteca "tv30" do
// Redis (infra/redis/funcoes.lua), que confere o esquema
// (infra/redis/esquema.json, a fonte de verdade) e grava de forma atomica,
// inclusive as invariantes entre chaves (ex.: clients:authorized e
// clients:blocked disjuntos). Esquema invalido = erro do Redis com prefixo
// TV30ESQUEMA (funcao, chave, campo e motivo) e NADA gravado.
//
// Recusa da funcao e defeito do servico: o erro sobe como qualquer falha do
// Redis — rota HTTP responde 404 {error:200} pelo errorHandler (que loga a
// mensagem, src/util/error.ts); handler MQTT loga (src/mqtt-client.ts).
//
// Fora daqui o tv3ws NAO grava nessas familias: o teste estatico
// (test/redis-escritas.test.ts, regras em infra/redis/test/escritas.js) falha
// se outro arquivo de src/ chamar comando de escrita no cliente Redis. A
// unica escrita direta permitida e o espelho remote-devices:* /
// remote-device:* (fora do alcance; remotedevice-manager/manager.ts).
//
// As funcoes usam numkeys 0 e derivam as chaves dos argumentos (ver o
// README de infra/redis).

function fcall(nome: string, args: string[]): Promise<unknown> {
    return redis.call('FCALL', nome, 0, ...args);
}

// campo, valor, campo, valor... (ordem estavel)
function pares(campos: Record<string, string>): string[] {
    return Object.keys(campos).sort().flatMap(k => [k, campos[k]]);
}

// --- sessao (espelhos de aop/currentUser e aop/currentService) ---

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

// --- atributos de emissora (C.6.14.5) ---

// valor '' remove o atributo; o teto de 20 MB e conferido no resultado.
// Devolve o numero de campos alterados.
export async function atributosEmissora(id: string, scid: string, atributos: Record<string, string>): Promise<number> {
    return Number(await fcall('tv30_atributos_emissora', [id, scid, ...pares(atributos)]));
}

// --- clientes (C.6.1) ---

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
