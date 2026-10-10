// D-0510-6 (reuniao 05/10 com o Joel): falha de Redis nao pode ser
// silenciosa. Pipeline e MULTI do ioredis RESOLVEM com um par [erro, valor]
// por comando: erro de conexao ou de comando nao rejeita a promessa, e o
// codigo que so le o valor (r?.[1] ?? []) transforma Redis fora do ar em
// lista vazia. execOrThrow rejeita no primeiro erro (o errorHandler da
// camada C.3.2 traduz para 404 {error:200}) e devolve so os valores.
type ExecResult = [error: Error | null, result: unknown][] | null;

export async function execOrThrow(batch: { exec(): Promise<ExecResult> }): Promise<unknown[]> {
    const results = await batch.exec();
    if (results === null) {
        // so acontece com WATCH (transacao abortada); nao usado hoje
        throw new Error('redis: transacao abortada');
    }
    return results.map(([err, value]) => {
        if (err) throw err;
        return value;
    });
}
