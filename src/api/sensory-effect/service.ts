import {
  getDeviceByHandle,
  getDevicesByClass,
} from "../../modules/remotedevice-manager/manager";
import { ControlMetadata } from "../../modules/remotedevice-manager/types";

function getRenderersMetadata() {
  const sensoryDevices = getDevicesByClass("sensory-effect");
  const renderers = sensoryDevices.map((device) => {
    return {
      id: device.getHandle(),
      supportedTypes: device.getSupportedTypes(),
      capabilities: device.getCapabilities(),
    };
  });

  return renderers;
}

function getRendererMetadata(rendererId: string) {
  const renderer = getDeviceByHandle(rendererId);

  if (!renderer || renderer.getClass() !== "sensory-effect") {
    return undefined;
  }

  return {
    id: renderer.getHandle(),
    supportedTypes: renderer.getSupportedTypes(),
    capabilities: renderer.getCapabilities(),
  };
}

// Valid properties in the C.6.16.3 command: Table C.83 refers to Annex A
// (Table A.30 and the effect position of A.3.19, attributes of <region> in
// NCL). Any other name gives 101.
const EFFECT_PROPERTIES = new Set([
  // Table A.30
  "intensityValue", "color", "scent", "frequency",
  // A.3.19, effect position
  "azimuthal", "polar", "width", "height", "direction", "location",
]);

function controlRenderer(rendererId: string, body: ControlMetadata) {
  const renderer = getDeviceByHandle(rendererId);
  if (!renderer || renderer.getClass() !== "sensory-effect") {
    throw new Error("Invalid renderer-id, renderer not found");
  }

  if (!body || !body.effectType || !body.action) {
    throw new Error("Invalid body, effectType and action are required");
  }

  if (!renderer.support(body.effectType)) {
    throw new Error(
      `Renderer does not support effect type: ${body.effectType}`
    );
  }

  const action = body.action;
  const properties = body.properties || [];
  for (const prop of properties) {
    const name = prop && typeof prop === "object" ? prop.name : undefined;
    if (typeof name !== "string" || !EFFECT_PROPERTIES.has(name)) {
      throw new Error(
        `Invalid sensory effect property '${String(name)}' (Table A.30 and A.3.19: ${[...EFFECT_PROPERTIES].join(", ")})`
      );
    }
  }

  renderer.controlDevice({
    effectType: body.effectType,
    action: action,
    properties: properties.map((prop) => ({
      name: prop.name,
      value: prop.value,
    })),
  });
}

export default {
  getRenderersMetadata,
  getRendererMetadata,
  controlRenderer,
};
