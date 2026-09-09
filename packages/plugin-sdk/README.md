# @nexus/plugin-sdk

Contrato público para frontends de plugins Nexus Edge formato 2.

O pacote exporta os tipos `PluginModuleV1`/`PluginHostV1`, `definePlugin`, a
validação de IDs de tabela e `mountConfigurableDataTable`. A exportação
`@nexus/plugin-sdk/backend` fornece os contextos internos tipados e um adaptador
portátil para o binding D1 ou Hyperdrive. Ele não importa código interno do Core
e pode ser usado por plugins mantidos em outros repositórios.

O binário `nexus-plugin-package` cria o ZIP formato 2 de forma determinística e
assina o inventário com a chave Ed25519 recebida exclusivamente pela variável
`PLUGIN_SIGNING_PRIVATE_KEY`. Assim, um repositório externo pode compilar e
empacotar o plugin sem copiar scripts privados do Core.

Consulte `docs/PLUGIN-DEVELOPMENT.md` e o exemplo em
`plugins/template/frontend/entry.ts` no repositório Nexus Edge.
