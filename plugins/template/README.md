# Template de plugin Nexus — formato 2

Copie este diretório para um repositório próprio. O frontend deste template é
empacotado no plugin e carregado pelo host dinâmico; ele não é compilado nem
registrado no Core.

Leia antes de alterar:

- `docs/PLUGIN-DEVELOPMENT.md`;
- `docs/PLUGIN-MARKETPLACE.md`;
- `docs/DATA-TABLE-STANDARD.md`;
- `docs/INTERNATIONALIZATION.md`;
- `docs/UI-STYLING-STANDARD.md`.

## O que trocar

Substitua `template` no `package.json`, `manifest.json`, migrations, backend e
frontend. Depois de copiar o diretório para fora deste workspace, troque a
referência `workspace:*` do SDK pela versão pública compatível. Preserve os
contratos:

- rotas de tela `/app/p/<id>/*`;
- API via `host.api()` e `/api/v1/p/<id>/*`;
- permissões `<id>.<recurso>.<ação>`;
- tabelas de banco com prefixo `<id>_`;
- preferências `plugin.<id>.<recurso>`;
- pares de migrations D1/PostgreSQL com o mesmo ID.

`frontend/entry.ts` demonstra o lifecycle do módulo, chamada ao backend,
notificação e a tabela configurável oficial do `@nexus/plugin-sdk`. O Core
fornece locale, tema, navegação, permissões e persistência por usuário.

The Core header supplies a **Back** button for the plugin route, so plugin
screens must not render a competing global back control.

## Build e pacote

Use Node.js 24+ e pnpm 11.19.0:

```bash
pnpm install --frozen-lockfile
pnpm build
PLUGIN_SIGNING_PRIVATE_KEY="<PKCS8-base64url>" \
PLUGIN_SIGNING_KEY_ID="publisher-v1" \
pnpm package
```

O build do backend passa pelo Wrangler em dry-run. O frontend é um bundle ESM
autossuficiente. O comando de pacote vem do SDK público, portanto continua
funcionando depois de copiar este template para outro repositório. O pacote resultante fica em
`release/<id>.plugin.zip`; publique-o como asset imutável de um GitHub Release
no marketplace, não no repositório do Core.

Nunca armazene a chave privada, tokens, `.dev.vars`, IDs físicos da instalação
ou dados de negócio no repositório/pacote. Os resources do manifesto possuem
nomes lógicos e são resolvidos pelo Installer.

## Checklist

- backend rejeita contexto ausente/falso e checa cada permissão;
- `POST /__installer/smoke` valida leitura/escrita necessária;
- frontend libera listeners, requests, streams e timers em `dispose`;
- todas as listas usam `mountConfigurableDataTable` com IDs/chaves estáveis;
- CSS funciona em light/dark e textos em `pt-BR`/`en`;
- migrations são aditivas, pareadas e imutáveis;
- pacote e catálogo passam nas verificações de integridade/assinatura;
- install, update, reinstall e uninstall preservam dados e recursos.
