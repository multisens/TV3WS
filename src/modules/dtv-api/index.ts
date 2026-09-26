import express, { Router } from 'express';
import controller from './controller';
const router: Router = express.Router();

/*
    C.6.3.1 Obtaining the current DTV service

    (As rotas C.6.1.2/C.6.1.3 de autorizacao e token pertencem a apis/access —
    a copia de teste que existia aqui sobrepunha a implementacao real.)
*/
router.get('/current-service', controller.GETCurrentService);


export default router;