// Pipeline e MULTI do ioredis resolvem com [erro, valor] por comando, sem rejeitar: ler so o valor
// transforma Redis fora do ar em lista vazia. Aqui o primeiro erro rejeita (vira 404 {error:200}).
type ExecResult = [error: Error | null, result: unknown][] | null;

export async function execOrThrow(batch: { exec(): Promise<ExecResult> }): Promise<unknown[]> {
    const results = await batch.exec();
    if (results === null) {
        // so com WATCH, que nao e usado
        throw new Error('redis: transacao abortada');
    }
    return results.map(([err, value]) => {
        if (err) throw err;
        return value;
    });
}
