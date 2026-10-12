import fs from 'fs';
import path from 'path';

// Correcao de 12/10 (spec-1210-seguranca2, item 1): caminho pedido pelo
// cliente, resolvido DENTRO de um diretorio-base sem poder sair dele. Antes,
// as duas rotas de arquivo do tv3ws faziam path.join(base, <path da query>) e
// liam o que saisse: GET /tv3/current-service/apps/<appId>/files?path=
// ../package.json devolvia o package.json do proprio tv3ws (medido em 12/10
// pela frente "seguranca", scratchpad/seguranca-1210/appfiles-traversal.js).
// Usado por api/aop-communication/app-files (C.6.4.7, Tabela C.17) e por
// api/user (C.6.14.6, Tabela C.73).
//
// Regras:
// - a barra no comeco e opcional e o caminho e sempre a partir da base
//   (Tabela C.17, p. 231; p. 249 do PDF: "The use of the '/' character at
//   the beginning of the path is optional and even with its use, the path
//   from the base directory shall be responded"): "/etc/passwd" e o
//   "etc/passwd" de DENTRO da base;
// - o caminho resolvido tem de continuar dentro da base: ".." que sai dela e
//   recusado, inclusive o que veio codificado na URL (%2e%2e%2f), que a
//   query ja entrega decodificado; nada se decodifica de novo aqui (o
//   %252e%252e vira o nome literal "%2e%2e", dentro da base);
// - barra invertida e NUL sao recusados: o separador e so "/" (no Windows a
//   barra invertida tambem separa, e "..\x" sairia da base);
// - link simbolico vale pelo destino real (realpath), que tambem tem de
//   estar dentro da base; quem le usa o caminho real devolvido aqui, e nao o
//   pedido;
// - base vazia ou ausente (nenhum diretorio conhecido) e recusa; antes,
//   path.join("", p) lia relativo ao diretorio corrente do processo.
// Recusa e inexistencia tem o mesmo retorno (undefined): quem chama responde
// com o codigo de caminho inexistente da sua API. Outras falhas do sistema de
// arquivos (ex.: EACCES) sobem e viram 404 {error:200} (errorHandler).
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
