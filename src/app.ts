import express, { Application, Request, Response, NextFunction } from "express";

// import middleware
import basic from './middleware/basic';
import authorization from './middleware/authorization';
import { apiNotFound, errorHandler } from './util';

// import modules routes
import accessAPI from './apis/access';
import dtvAPI from "./modules/dtv-api";
import appfilesAPI from "./modules/appfiles-api";
import userAPI from "./modules/user-api";
import userController from "./modules/user-api/controller";
import remotedevAPI from "./modules/remotedevice-api";
import sensoryEffectRenderersAPI from "./modules/sensory-effect-renderers-api";

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
app.use("/tv3/current-service/apps", appfilesAPI);
app.post("/tv3/users", userController.POSTCreateUser);   // criar user (fora da spec, usado pelo profile-creator do AoP)
app.use("/tv3/current-service/users", userAPI);
app.use("/tv3/:serviceContextId/users", userAPI);   // broadcaster-attrs por contexto de serviço
app.use("/tv3/remote-device", remotedevAPI);
app.use("/tv3/sensory-effect-renderers", sensoryEffectRenderersAPI);
app.use("/tv3", dtvAPI);
app.use("/tv3", accessAPI);

// camada comum de erro (C.3.2): rota /tv3 nao mapeada -> erro 100 no
// formato da norma; excecao nao tratada -> erro 200, nunca HTML.
app.use("/tv3", apiNotFound);
app.use(errorHandler);

export default app;
