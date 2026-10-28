import express, { Router } from 'express';
import currentService from './current-service';
import appFiles from './app-files';

// AoP Communication: current service (C.6.3.1) and application files
// (C.6.4.7).
const router: Router = express.Router();

router.use('/current-service/apps', appFiles);
router.use('/', currentService);

export default router;
