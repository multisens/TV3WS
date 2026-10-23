import express, { Request, Response, Router } from "express";
import controller from "./controller";
const router: Router = express.Router();

// C.6.15.2 Registering a remote device
router.post("/", controller.POSTRemoteDevice);

// C.6.15.3 Deregistering a remote device
router.delete("/:handle", controller.DELETERemoteDevice);

// C.6.15.5 Obtaining the list of registered remote devices
router.get("/devices/:classId", controller.GETRemoteDevices);

export default router;

// Versao 100.0 (extensao do testbed): a borda repassa em /v100.0/tv3/remote-device.
export const routerV100: Router = express.Router();

// C.6.15.5 so com os handles; a url vem pela ativacao por handle
routerV100.get("/devices/:classId", controller.GETRemoteDeviceHandles);

// Ativacao por handle (fora da norma)
routerV100.get("/device/:handle", controller.GETRemoteDeviceEntryPoint);

// Desativacao por handle (fora da norma)
routerV100.delete("/device/:handle", controller.DELETERemoteDeviceEntryPoint);
