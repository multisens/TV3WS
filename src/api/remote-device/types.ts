export type Device = {
  handle: string;
  supportedTypes: string[];
  // so na versao 2.0 (C.6.15.5); na 100.0 a url vem por handle
  url?: string;
};
