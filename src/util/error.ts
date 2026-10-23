import { NextFunction, Request, Response } from 'express';

// Error codes of Annex C (C.3.3). The code goes in the body; the HTTP
// status of a failure is always 404 (C.3.2).
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

// C.3.2: only the error and description fields; the detail is appended
// ("Missing argument: handle").
export function returnError(res: Response, code: number, detail?: string) {
    const base = Errors[code] ?? 'Unknown error';
    res.status(404).json({
        error: code,
        description: detail ? `${base}: ${detail}` : base,
    });
}

// Answers 100 in the format of C.3.2 to a route not found.
export function apiNotFound(req: Request, res: Response) {
    returnError(res, 100, `${req.method} ${req.originalUrl}`);
}

export class ApiError extends Error {
    constructor(public code: number, detail?: string) {
        super(detail ?? Errors[code] ?? 'error');
    }
}

// Any exception that is not an ApiError (a rejected promise included,
// Express 5) becomes 200.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) {
        returnError(res, err.code, err.message !== Errors[err.code] ? err.message : undefined);
        return;
    }
    // Malformed JSON is an illegal argument of the client (101).
    if ((err as { type?: unknown })?.type === 'entity.parse.failed') {
        returnError(res, 101, 'message body is not valid JSON, body');
        return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[error] ${req.method} ${req.originalUrl}: ${msg}`);
    returnError(res, 200, msg);
}