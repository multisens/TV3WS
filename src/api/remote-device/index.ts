import express, { Request, Response, Router } from "express";
import controller from "./controller";
const router: Router = express.Router();

// C.6.15.2 Registering a remote device
router.post("/", controller.POSTRemoteDevice);

// C.6.15.3 Deregistering a remote device
router.delete("/:handle", controller.DELETERemoteDevice);

// C.6.15.5 Obtaining the list of registered remote devices
router.get("/devices/:classId", controller.GETRemoteDevices);

// Ativacao por handle (extensao do testbed, fora da norma; so na 100.0)
router.get("/device/:handle", controller.GETRemoteDeviceEntryPoint);

// Desativacao por handle (extensao do testbed, fora da norma; so na 100.0)
router.delete("/device/:handle", controller.DELETERemoteDeviceEntryPoint);

export default router;
