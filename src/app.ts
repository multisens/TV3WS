import express, { Application, Request, Response, NextFunction } from "express";

// import middleware
import basic from './middleware/basic';
import authorization from './middleware/authorization';
import { apiNotFound, errorHandler } from './util';

// APIs por agrupamento do Anexo C (S1/R3): uma pasta por agrupamento em
// src/api, com o indice do agrupamento montando as APIs-filhas.
import clientIdentificationAPI from './api/client-identification';
import aopCommunicationAPI from './api/aop-communication';
import userAPI from './api/user';
import multiDeviceAPI from './api/multi-device';
import sensoryEffectAPI from './api/sensory-effect';

// middleware configuration
const app: Application = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/tv3', basic);
app.use('/tv3', authorization);

// routes
app.use("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    message: "CCWS is running",
  });
});
// (a antiga rota fora-da-spec POST /tv3/users saiu: criacao de perfil e
// funcao do gestor de perfis da PLATAFORMA — P3/M1 — nao das APIs do Anexo C)
app.use("/tv3/current-service/users", userAPI);
app.use("/tv3/:serviceContextId/users", userAPI);   // atributos por contexto de serviço (C.6.14.2/C.6.14.5)
app.use("/tv3/remote-device", multiDeviceAPI);
app.use("/tv3/sensory-effect-renderers", sensoryEffectAPI);
app.use("/tv3", aopCommunicationAPI);
app.use("/tv3", clientIdentificationAPI);

// camada comum de erro (C.3.2): rota /tv3 nao mapeada -> erro 100 no
// formato da norma; excecao nao tratada -> erro 200, nunca HTML.
app.use("/tv3", apiNotFound);
app.use(errorHandler);

export default app;
