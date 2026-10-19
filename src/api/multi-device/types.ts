export type Device = {
  handle: string;
  supportedTypes: string[];
  // Ponto de entrada local (C.6.15.5, versao 2.0): a norma entrega a URL na
  // propria listagem por classe. Ausente na versao 100.0 (fluxo por handle; ate 15/10, "2.1").
  url?: string;
};
