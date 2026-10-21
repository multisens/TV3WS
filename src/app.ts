import express, { Application, Request, Response, NextFunction } from "express";

// Middlewares
import basic from './middleware/basic';
import { apiNotFound, errorHandler } from './util';

// APIs
import clientIdentificationAPI from './api/client-identification';
import aopCommunicationAPI from './api/aop-communication';
import userAPI from './api/user';
import multiDeviceAPI from './api/multi-device';
import sensoryEffectAPI from './api/sensory-effect';
import v100 from './v100.0';

const app: Application = express();

// Sets Content-Type and API-Version for /tv3 routes
app.use('/tv3', basic);

// Includes the routes of API version 100.0
app.use('/v100.0', v100);

// Parses the request body
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Health check
app.use("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    message: "tv3ws is running",
  });
});

// Includes the routes for APIs
app.use("/tv3/current-service/users", userAPI);
app.use("/tv3/:serviceContextId/users", userAPI);
app.use("/tv3/remote-device", multiDeviceAPI);
app.use("/tv3/sensory-effect-renderers", sensoryEffectAPI);
app.use("/tv3", aopCommunicationAPI);
app.use("/tv3", clientIdentificationAPI);

// Responds error 100 for unmapped routes and handles uncaught errors
app.use(apiNotFound);
app.use(errorHandler);

export default app;
