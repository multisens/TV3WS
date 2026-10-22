import express, { Router } from 'express';
import { identifyLocalClient } from '../../util/client';
import controller from './controller';
const router: Router = express.Router();

// C.6.2.2 - Registering event notifications; in version 100.0, only local
// clients register (the only event class is remote-device)
router.get('/:className', identifyLocalClient, controller.registerListener);

// C.6.2.3 - Deregistering event notifications
router.delete('/:handle', controller.removeListener);

export default router;
