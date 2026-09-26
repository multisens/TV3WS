import { NextFunction, Request, Response } from 'express';

// Catalogo de codigos de erro do Anexo C (tabela C.3.3). Faixas: 100-199
// genericos, 200-299 da API, 300-399 acesso a recurso, 400-499 sinal de
// broadcast. O codigo vai no CORPO da resposta; o status HTTP de falha eh
// SEMPRE 404 (C.3.2, "por simplicidade").
const Errors: Record<number, string> = {
    [100]: 'API not found',
    [101]: 'Illegal argument value',
    [102]: 'Access not authorized by user',
    [103]: 'Unable to ask for user authorization',
    [104]: 'Access not authorized by the broadcaster',
    [105]: 'Missing argument',
    [106]: 'API unavailable for this runtime environment',
    [107]: 'Invalid or outdated access token',
    [108]: 'Invalid or revoked bind token',

    [200]: 'Platform resource unavailable',
    [201]: 'Format not supported',
    [202]: 'Action not supported',
    [203]: 'Parameter not supported',

    [300]: 'No DTV service currently in use',
    [301]: 'Service information cache unavailable',
    [302]: 'No DTV Signal',
    [303]: 'Empty Application Catalog',
    [304]: 'DTV service not found',
    [305]: 'DTV resource not found',

    [400]: 'Network service unavailable',
    [401]: 'Unsupported or invalid state transition',
    [402]: 'Unsupported or invalid priority transition',
    [403]: 'Unhandled URL scheme',
    [404]: 'URL not found',
    [405]: 'Access to viewer profile information not authorized',
}


// Construtor unico de resposta de erro (C.3.2): status fixo 404 + corpo
// JSON com os dois campos mandatorios. O detalhe opcional eh concatenado
// na description ("Missing argument: handle") — o antigo campo extra
// full_description estava fora do formato da norma e ninguem o consumia.
export function returnError(res: Response, code: number, detail?: string) {
    const base = Errors[code] ?? 'Unknown error';
    res.status(404).json({
        error: code,
        description: detail ? `${base}: ${detail}` : base,
    });
}

// Fallback de rota nao mapeada sob /tv3: sem isso o Express devolve o 404
// HTML default, fora do formato C.3.2.
export function apiNotFound(req: Request, res: Response) {
    returnError(res, 100, `${req.method} ${req.originalUrl}`);
}

// Erro de negocio com codigo do catalogo C.3.3: servicos lancam ApiError e
// o errorHandler traduz para o formato C.3.2 — controlador nao escreve
// resposta de erro na mao.
export class ApiError extends Error {
    constructor(public code: number, detail?: string) {
        super(detail ?? Errors[code] ?? 'error');
    }
}

// Ultimo middleware da cadeia: ApiError vira o codigo declarado; qualquer
// outra excecao (ou promise rejeitada em handler async, Express 5) vira
// erro 200 do catalogo — recurso da plataforma indisponivel — em vez de
// stack trace HTML.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) {
        returnError(res, err.code, err.message !== Errors[err.code] ? err.message : undefined);
        return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[error] ${req.method} ${req.originalUrl}: ${msg}`);
    returnError(res, 200, msg);
}