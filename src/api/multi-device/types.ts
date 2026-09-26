export type Device = {
  handle: string;
  supportedTypes: string[];
  // Ponto de entrada local (C.6.15.5, versao 2.0): a norma entrega a URL na
  // propria listagem por classe. Ausente na versao 2.1 (fluxo por handle).
  url?: string;
};
