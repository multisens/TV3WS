import express, { Router } from 'express';
import currentService from './current-service';
import appFiles from './app-files';

// AoP Communication: servico corrente (C.6.3.1) e arquivos de aplicacao (C.6.4.7)
const router: Router = express.Router();

router.use('/current-service/apps', appFiles);
router.use('/', currentService);

export default router;
