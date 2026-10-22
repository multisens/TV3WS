import express, { Router } from 'express';
import controller from './controller';
import { RegisterBodySchema } from './schema';
import { validateSchema } from '../../util/validate';
import { identifyLocalClient } from '../../util/client';
const router: Router = express.Router();


// C.6.15.2 - Registering a remote device
router.post('/', validateSchema(RegisterBodySchema), controller.registerDevice);

// C.6.15.2 - Update a remote device registry
router.post('/:handle', validateSchema(RegisterBodySchema), controller.updateDevice);

// C.6.15.3 - Deregistering a remote device
router.delete('/:handle', controller.removeDevice);

// C.6.15.5 - Enabling communication with a remote device
router.get('/devices/:classId', identifyLocalClient, controller.listDevices);

export default router;