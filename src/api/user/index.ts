import express, { Router } from 'express';
import controller from './controller';

// mergeParams allows /:serviceContextId from parent router to be visible here
const router: Router = express.Router({ mergeParams: true });

/*
    C.6.14.1 Obtaining a list of user ids
*/
router.post('/', controller.POSTUserList);

/*
    C.6.14.3 Obtaining the current user
*/
router.get('/current-user', controller.GETCurrentUser);

/*
    C.6.14.4 Changing the current user
*/
router.post('/current-user', controller.POSTCurrentUser);

/*
    C.6.14.6 Obtaining a user file content
*/
router.get('/files', controller.GETUserFile);

/*
    C.6.14.5 Writing a user attribute value (atributos de emissora)
        POST /tv3/{scid}/users/{user-id} — resposta JSON com os atributos
        alterados; valor '' remove. Substitui o antigo PUT
        .../broadcaster-attrs, fora da Tabela C.2 (item 24). Os atributos
        de emissora sao LIDOS pelo GET do usuario (C.6.14.2), mesclados.
*/
router.post('/:userid', controller.POSTUserAttributes);

/*
    C.6.14.2 Obtaining a set of user attributes
*/
router.get('/:userid', controller.GETUserAttribute);

export default router;
