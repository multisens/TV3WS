import express, { NextFunction, Request, Response, Router } from 'express';
const router: Router = express.Router();

export const INTERNAL_VERSION_HEADER = 'X-TV30-API-Version';
const DEFAULT_VERSION = '2.0';

// Returns the X-TV30-API-Version value if it has the X.Y format; otherwise, 2.0
function decidedVersion(req: Request): string {
    const v = req.get(INTERNAL_VERSION_HEADER);
    return v !== undefined && /^\d+\.\d+$/.test(v) ? v : DEFAULT_VERSION;
}

// Includes in the response the Content-Type and the API-Version, and stores
// the version in res.locals.apiVersion
router.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Type', 'application/json');

    const version = decidedVersion(req);
    res.locals.apiVersion = version;
    res.setHeader('API-Version', version);
    next();
});

export default router;
