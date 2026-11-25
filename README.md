# tv3ws

Os TV 3.0 WebServices do testbed de Codificação de Aplicações da TV 3.0: as APIs do Anexo C da
ABNT NBR 25608, menos o contexto de vínculo do bind-token (C.6.8) e a descrição das APIs (C.6.7.8 e
C.6.7.9), que a borda responde sozinha. As APIs chegam ao `tv3ws` só pela borda.

Este repositório é submódulo do [TV30](https://github.com/multisens/TV30) e sobe pelo
`docker-compose.yml` da raiz dele.

**Documentação:** <https://multisens.com.br/TV30/tv3ws/>

## Desenvolver e testar

- Rodar fora do Docker, com `npm run dev`:
  [Desenvolvimento com serviço no host](https://multisens.com.br/TV30/dev-local/#tv3ws-no-host).
- Testes: `npm test` e `npx tsc --noEmit`; as suítes com a stack de pé estão em
  [Como testar](https://multisens.com.br/TV30/como-testar/).

## Licença

Apache-2.0; veja o `LICENSE`.
