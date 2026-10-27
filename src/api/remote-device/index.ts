import express, { Router } from "express";
import controller from "./controller";
import { RegisterBodySchema } from "./schema";
import { validateSchema } from "../../util";

const router: Router = express.Router();

// C.6.15.2 Registering a remote device
router.post("/", validateSchema(RegisterBodySchema), controller.POSTRemoteDevice);

// C.6.15.2 Updating the registry of a remote device
router.post("/:handle", validateSchema(RegisterBodySchema), controller.POSTRemoteDeviceUpdate);

// C.6.15.3 Deregistering a remote device
router.delete("/:handle", controller.DELETERemoteDevice);

// C.6.15.5 Enabling communication with a remote device
router.get("/devices/:classId", controller.GETRemoteDevices);

export default router;
