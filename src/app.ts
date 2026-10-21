import express, { Application, Request, Response, NextFunction } from "express";

import basic from './middleware/basic';
import { apiNotFound, errorHandler } from './util';

import clientIdentificationAPI from './api/client-identification';
import aopCommunicationAPI from './api/aop-communication';
import userAPI from './api/user';
import remoteDeviceAPI from './api/remote-device';
import sensoryEffectAPI from './api/sensory-effect';

// A credencial e conferida na borda (edgegateway); aqui so se emite (client-identification).
// O basic vem antes dos leitores de corpo para o 101 de JSON malformado levar API-Version (C.3.6.6).
const app: Application = express();
app.use('/tv3', basic);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    message: "tv3ws is running",
  });
});
app.use("/tv3/current-service/users", userAPI);
app.use("/tv3/:serviceContextId/users", userAPI);   // atributos por contexto de serviço (C.6.14.2/C.6.14.5)
app.use("/tv3/remote-device", remoteDeviceAPI);
app.use("/tv3/sensory-effect-renderers", sensoryEffectAPI);
// C.6.8 (/tv3/bind-context) e respondida pela borda.
app.use("/tv3", aopCommunicationAPI);
app.use("/tv3", clientIdentificationAPI);

// camada comum de erro (C.3.2): rota /tv3 nao mapeada -> erro 100 no
// formato da norma; excecao nao tratada -> erro 200, nunca HTML.
app.use("/tv3", apiNotFound);
app.use(errorHandler);

export default app;
