import express, { Router } from 'express';
import controller from './controller';
const router: Router = express.Router();

// Agrupamento Broadcaster security (C.6.8), montado em /tv3/bind-context.
//
// PENDENTE (Joel): ONDE fica esta API (aqui no tv3ws ou no plugin da borda)
// nao foi decidido na reuniao de 28/09 — foi escolha da especificacao da
// semana. Na mesma reuniao o Joel rejeitou um bind-token.ts no tv3ws (a
// validacao vai para o plugin); aqui ele so serve ao GET /tv3/bind-context
// (C.6.8.3), cuja logica e validar o token. Enquanto isso, os dois leitores
// de chave (bind-token.ts e infra/edgegateway/plugin/keys.go) sao mantidos
// iguais por um teste cruzado (test/fixtures/keyformats.json).

/*
    C.6.8.2 Registering a DTV service context for use by TV 3.0 WebServices APIs
*/
router.post('/', controller.POSTBindContext);

/*
    C.6.8.3 Accessing a previously bound DTV service context
*/
router.get('/', controller.GETBindContext);

/*
    C.6.8.4 Revoking tokens for using TV 3.0 WebServices APIs
*/
router.delete('/', controller.DELETEBindContext);

export default router;
