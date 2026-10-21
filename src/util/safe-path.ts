import fs from 'fs';
import path from 'path';

// Caminho do cliente resolvido dentro de um diretorio-base (C.6.4.7, Tabela C.17; C.6.14.6, Tabela C.75).
// A barra inicial e opcional e o caminho e sempre a partir da base (Tabela C.17). ".." que sai da base,
// barra invertida (separador no Windows) e NUL sao recusados; a query ja chega decodificada, e nada se
// decodifica de novo. Link simbolico vale pelo destino real, que tambem tem de estar na base; base vazia
// e recusa. Recusa e inexistencia devolvem undefined; outra falha do sistema de arquivos sobe.
export type ResolvedPath = {
    base: string;   // realpath da base
    path: string;   // realpath do caminho pedido, dentro da base
    stat: fs.Stats;
};

// target dentro de base (ou a propria base), os dois ja resolvidos
export function isInsideDir(base: string, target: string): boolean {
    const rel = path.relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

const NOT_FOUND = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

export function resolveInsideDir(baseDir: string | undefined, requested: unknown): ResolvedPath | undefined {
    if (typeof baseDir !== 'string' || baseDir === '') return undefined;
    // parametro repetido (?path=a&path=b) chega como lista: nao e um caminho
    if (typeof requested !== 'string') return undefined;
    if (requested.includes('\0') || requested.includes('\\')) return undefined;
    try {
        const base = fs.realpathSync(path.resolve(baseDir));
        const lexical = path.resolve(base, requested.replace(/^\/+/, ''));
        if (!isInsideDir(base, lexical)) return undefined;
        const real = fs.realpathSync(lexical);
        if (!isInsideDir(base, real)) return undefined;
        return { base, path: real, stat: fs.statSync(real) };
    } catch (err) {
        if (NOT_FOUND.has((err as NodeJS.ErrnoException)?.code ?? '')) return undefined;
        throw err;
    }
}
