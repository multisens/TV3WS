import express, { Router } from 'express';
import currentService from './current-service';
import appFiles from './app-files';

// Agrupamento AoP Communication (S1/R3): o indice do agrupamento monta as
// APIs-filhas — consulta do servico corrente (C.6.3.1) e conteudo de
// arquivos de aplicacao (C.6.x). Os caminhos de URL nao mudam.
const router: Router = express.Router();

router.use('/current-service/apps', appFiles);
router.use('/', currentService);

export default router;
