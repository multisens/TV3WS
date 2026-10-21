import express, { Router, Request, Response, NextFunction } from 'express';
import { returnError } from '../util';
import remoteDevApi from './api/remote-device';
const router: Router = express.Router();

// Includes in the response the Content-Type and the API-Version
router.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('API-Version', '100.0');
    next();
});
router.use(express.json());

// Includes the routes for APIs

// Responds error 100 with the path as sent by the client, without the
// version prefix
router.use((req: Request, res: Response) => {
    returnError(res, 100, `${req.method} ${req.url}`);
});

export default router;
