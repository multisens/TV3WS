import express, { NextFunction, Request, Response, Router } from 'express';
const router: Router = express.Router();

// API version (C.3.6): read from X-TV30-API-Version into res.locals and set
// in the API-Version header of every response, errors included (C.3.6.6).
// Without the header, or with a value outside X.Y, 2.0 (C.3.6.5).
export const INTERNAL_VERSION_HEADER = 'X-TV30-API-Version';
const DEFAULT_VERSION = '2.0';

function decidedVersion(req: Request): string {
    const v = req.get(INTERNAL_VERSION_HEADER);
    return v !== undefined && /^\d+\.\d+$/.test(v) ? v : DEFAULT_VERSION;
}

router.use((req: Request, res: Response, next: NextFunction) => {
    // No CORS header here: a duplicated Access-Control-Allow-Origin is blocked
    // by the browser.

    res.setHeader('Content-Type', 'application/json');

    const version = decidedVersion(req);
    res.locals.apiVersion = version;
    res.setHeader('API-Version', version);
    next();
});

export default router;
