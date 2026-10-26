import fs from 'fs';
import path from 'path';

// A path of the client resolved inside a base directory (C.6.4.7, Table
// C.17; C.6.14.6, Table C.75). The leading slash is optional and the path
// always starts at the base (Table C.17). A ".." that leaves the base, a
// backslash (separator on Windows) and NUL are refused; the query arrives
// already decoded, and nothing is decoded again. A symbolic link counts by
// its real target, which must also be in the base; an empty base is a
// refusal. Refusal and nonexistence give undefined; any other file system
// failure is thrown.
export type ResolvedPath = {
    // realpath of the base
    base: string;
    // realpath of the requested path, inside the base
    path: string;
    stat: fs.Stats;
};

// Whether target is inside base (or is base), both already resolved.
export function isInsideDir(base: string, target: string): boolean {
    const rel = path.relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

const NOT_FOUND = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

export function resolveInsideDir(baseDir: string | undefined, requested: unknown): ResolvedPath | undefined {
    if (typeof baseDir !== 'string' || baseDir === '') return undefined;
    // A repeated parameter (?path=a&path=b) arrives as a list: not a path.
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
