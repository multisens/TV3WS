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

// C3 (Joel, 15/10): nomes de propriedade validos no comando da C.6.16.3. A
// Tabela C.83 remete ao Anexo A ("The specification of the possible sensory
// effect properties can be found in Annex A"): as propriedades da Tabela A.30
// e os atributos de posicao do efeito da A.3.19 (no NCL, atributos de
// <region> sao valores possiveis de propriedade do no <effect>). Nome fora
// dos dois conjuntos da 101 ("If any of the fields in the message body has
// an invalid value"). Ate 15/10 o nome era repassado sem conferencia.
const EFFECT_PROPERTIES = new Set([
  // Tabela A.30
  "intensityValue", "color", "scent", "frequency",
  // A.3.19, posicao do efeito
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
