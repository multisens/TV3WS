import { Request, Response } from "express";
import service from "./service";
import { returnError } from "../../util";

function GETRenderers(req: Request, res: Response): void {
  const renderers = service.getRenderersMetadata();
  if (!renderers || renderers.length === 0) {
    res.status(200).json({
      renderers: [],
    });
    return;
  }

  res.status(200).json({
    renderers,
  });
}

function GETRenderer(req: Request, res: Response): void {
  const rendererId = req.params["rendererId"];
  if (!rendererId) {
    returnError(res, 105, "renderer-id");
    return;
  }

  const renderer = service.getRendererMetadata(rendererId);
  if (!renderer) {
    returnError(res, 101, `renderer ${rendererId} not found`);
    return;
  }

  res.status(200).json({
    renderer,
  });
}

function POSTControlRenderer(req: Request, res: Response): void {
  console.log("[POSTControlRenderer] Action received at ", Date.now());

  const rendererId = req.params["rendererId"];
  if (!rendererId) {
    returnError(res, 105, "renderer-id");
    return;
  }
  const body = req.body;
  if (!body || !body.effectType || !body.action) {
    returnError(res, 105, "effectType and/or action");
    return;
  }

  const renderer = service.getRendererMetadata(rendererId);
  if (!renderer) {
    returnError(res, 101, `renderer ${rendererId} not found`);
    return;
  }

  try {
    service.controlRenderer(rendererId, body);
    res.status(204).json({});
  } catch (error) {
    returnError(res, 101, error instanceof Error ? error.message : String(error));
  }
}

export default { GETRenderers, GETRenderer, POSTControlRenderer };
