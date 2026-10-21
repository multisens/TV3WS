import express, { Router } from 'express';
import controller from './controller';
const router: Router = express.Router();

// C.6.3.1 Obtaining the current DTV service
router.get('/current-service', controller.GETCurrentService);


export default router;