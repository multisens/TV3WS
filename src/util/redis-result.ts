// The pipeline and MULTI of ioredis resolve with [error, value] per command,
// without rejecting. Here the first error rejects (becoming 404 {error:200}).
type ExecResult = [error: Error | null, result: unknown][] | null;

export async function execOrThrow(batch: { exec(): Promise<ExecResult> }): Promise<unknown[]> {
    const results = await batch.exec();
    if (results === null) {
        // Only with WATCH, which is not used.
        throw new Error('redis: transacao abortada');
    }
    return results.map(([err, value]) => {
        if (err) throw err;
        return value;
    });
}
