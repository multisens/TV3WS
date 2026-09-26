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

  // C.6.16.2 (Tabela C.80): o objeto do renderer vai na RAIZ da resposta —
  // o embrulho {"renderer": ...} era desvio de contrato (item 24).
  res.status(200).json(renderer);
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
    // C.6.16.3 (Tabela C.81): a resposta e o objeto da Tabela C.80
    // refletindo o estado corrente do renderer apos a operacao — o 204
    // vazio era o desvio (item 24; o KNOWN-ISSUES antigo dizia o oposto).
    res.status(200).json(service.getRendererMetadata(rendererId));
  } catch (error) {
    returnError(res, 101, error instanceof Error ? error.message : String(error));
  }
}

export default { GETRenderers, GETRenderer, POSTControlRenderer };
