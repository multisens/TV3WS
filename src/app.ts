import express, { Application, Request, Response, NextFunction } from "express";

import basic from './middleware/basic';
import { apiNotFound, errorHandler } from './util';

import clientIdentificationAPI from './api/client-identification';
import aopCommunicationAPI from './api/aop-communication';
import userAPI from './api/user';
import remoteDeviceAPI, { routerV100 as remoteDeviceV100API } from './api/remote-device';
import sensoryEffectAPI from './api/sensory-effect';

// Testbed extension (version 100 on): the edge passes it on under the path
// /v<X.Y> followed by the public path.
const V100 = '/v100.0/tv3';

// No credential is checked here; client-identification only issues them.
// basic comes before the body parsers, so that the 101 of a malformed JSON
// carries API-Version (C.3.6.6).
const app: Application = express();
app.use('/tv3', basic);
app.use(V100, basic);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    message: "tv3ws is running",
  });
});
app.use("/tv3/current-service/users", userAPI);
// Attributes by service context (C.6.14.2, C.6.14.5).
app.use("/tv3/:serviceContextId/users", userAPI);
app.use("/tv3/remote-device", remoteDeviceAPI);
app.use(`${V100}/remote-device`, remoteDeviceV100API);
app.use("/tv3/sensory-effect-renderers", sensoryEffectAPI);
// C.6.8 (/tv3/bind-context) is not served here.
app.use("/tv3", aopCommunicationAPI);
app.use("/tv3", clientIdentificationAPI);

// Common error layer (C.3.2): an unmapped /tv3 route gives error 100 in the
// format of the standard; an unhandled exception gives error 200, never
// HTML.
app.use("/tv3", apiNotFound);
app.use(V100, apiNotFound);
app.use(errorHandler);

export default app;
