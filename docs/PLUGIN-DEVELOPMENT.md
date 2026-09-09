# Desenvolvimento de plugins independentes

Este é o contrato de desenvolvimento de plugins do Nexus Edge. Um plugin no
formato 2 possui frontend, backend, migrations e metadados próprios. Depois que
o Core compatível estiver instalado, criar ou atualizar um plugin **não exige
editar, recompilar ou publicar o Core**.

O Core funciona como host estável: autentica o usuário, filtra permissões,
carrega assets locais verificados, encaminha a API por Service Binding e
provisiona os recursos Cloudflare declarados. Como no WordPress e no Odoo, o
plugin é código confiável escolhido pelo administrador; Shadow DOM evita
conflitos de estilo, mas não é uma sandbox de segurança.

## 1. Começar pelo template

Copie `plugins/template` para um repositório separado:

```bash
cp -R plugins/template inventory
```

Troque os identificadores de modo consistente:

| Contrato              | Exemplo                        |
| --------------------- | ------------------------------ |
| ID do plugin          | `inventory`                    |
| pacote                | `@my-company/plugin-inventory` |
| prefixo de tabelas    | `inventory_`                   |
| permissões            | `inventory.product.read`       |
| rotas de tela         | `/app/p/inventory/*`           |
| API autenticada       | `/api/v1/p/inventory/*`        |
| API pública declarada | `/api/v1/public/p/inventory/*` |
| preferência de tabela | `plugin.inventory.products`    |

IDs publicados, chaves de permissão, route keys, nomes lógicos de recursos,
bindings, migrations, IDs de tabela e chaves de coluna são contratos
persistentes. Não os renomeie em uma atualização comum.

## 2. Conteúdo do pacote 2

```text
manifest.json
backend/worker.mjs
backend/modules/*                 # opcional
frontend/entry.js
frontend/*.css                   # opcional
locales/pt-BR.json               # opcional
locales/en.json                  # opcional
migrations/d1/NNNN_nome.sql
migrations/postgres/NNNN_nome.sql
openapi.json                     # opcional
resources/*                      # opcional
LICENSE                          # opcional
integrity.json
signature.json
```

O ZIP bruto pode ter até 8 MiB, a expansão até 24 MiB, cada arquivo até 6 MiB
e no máximo 25 entradas. Paths duplicados, diferenças apenas de maiúsculas,
symlinks, ZIP64, arquivos extras, source maps e travessia de diretório são
rejeitados. `integrity.json` registra SHA-256, tamanho e MIME de cada payload;
`signature.json` assina sua representação canônica com Ed25519. O marketplace
também assina o ZIP completo.

Nunca inclua tokens, senhas, cookies, IDs da instalação, nomes físicos de
recursos, `.dev.vars`, connection strings ou dados de negócio no pacote.

## 3. Manifesto

O template contém o manifesto mínimo completo. Os campos de plataforma são:

```json
{
  "manifestVersion": 2,
  "packageFormat": 2,
  "id": "inventory",
  "name": "Inventory",
  "publisher": { "id": "my_company", "name": "My Company" },
  "version": "1.0.0",
  "apiVersion": 1,
  "coreMinVersion": "1.1.0",
  "compatibilityDate": "2026-09-08",
  "compatibilityFlags": ["nodejs_compat"],
  "databaseDialects": ["d1", "postgres"],
  "engines": { "hostApi": 1, "coreApi": 1 },
  "tablePrefix": "inventory_",
  "frontend": {
    "entry": "frontend/entry.js",
    "styles": ["frontend/styles.css"],
    "isolation": "shadow",
    "routes": [{ "routeKey": "inventory.products", "path": "/app/p/inventory" }]
  },
  "permissions": ["inventory.product.read"],
  "menu": [
    {
      "title": "Products",
      "routeKey": "inventory.products",
      "path": "/app/p/inventory"
    }
  ]
}
```

Metadados localizados aceitam `pt-BR` e `en`, inclusive nome, descrição,
títulos de menu e labels de permissão. O painel usa esses labels sem adicioná-
los ao catálogo de traduções do Core.

Dependências usam ranges SemVer e são resolvidas antes de instalar. Dependência
obrigatória ausente, versão incompatível ou ciclo bloqueia a operação. Um
plugin requerido por outro não pode ser desinstalado primeiro.

## 4. Frontend dinâmico e SDK

O entrypoint exporta um `PluginModuleV1`, normalmente com `definePlugin`. O host
fornece:

- `host.api()` para a API do próprio plugin;
- `host.coreApi()` para APIs Core autorizadas pelo usuário;
- navegação restrita a `/app/p/<id>`;
- notificações, locale, tema e permissões efetivas;
- preferências de tabela por usuário.

O módulo implementa `mountPage` e devolve `dispose`. Pode também manter uma
sessão em `activate`, montar uma superfície global com `mountSurface` quando o
manifesto define `frontend.persistentSurface: true` e limpar recursos em
`deactivate`. A sessão/superfície sobrevive à navegação interna e é encerrada no
logout ou na troca de release. Remova listeners, timers, streams e requests no
descarte. Deep links e refresh são atendidos pela rota genérica
`p/:pluginId/*`; o Core não conhece o ID do plugin no build.

Para listas de registros, use `mountConfigurableDataTable` do
`@nexus/plugin-sdk`, como demonstra `plugins/template/frontend/entry.ts`. Ele
oferece ordenação de uma coluna, show/hide, drag-to-reorder, resize contínuo e
independente, reset, linhas acessíveis por teclado, coluna fixa **Ações** e
preferências persistidas. Todo `tableId` deve ser
`plugin.<manifest-id>.<recurso>` e nunca deve ser reutilizado para outra tabela.

Os assets são importados somente da cópia autenticada armazenada pelo Core e
endereçada pelo hash do release. O release atual e o anterior ficam disponíveis
para abas já abertas/recuperação. Use CSS autocontido e teste `light`, `dark`,
`pt-BR` e `en`.

O cabeçalho continua pertencendo ao host. O Core-owned **Back** button resolve
o retorno hierárquico pela rota registrada, inclusive para deep links, sem o
plugin duplicar navegação global.

### Filter layout standard

Telas de plugin que precisam de filtros React devem usar o
shared `SingleLineFilterBar`: controles compactos ficam em uma non-wrapping row com
overflow horizontal em viewports estreitos. Isso preserva o padrão visual sem
reimplementar um toolbar diferente em cada módulo.

## 5. Backend e gateway

O backend é um Module Worker privado. Valide exatamente um dos headers internos
do template:

- `X-Plugin-Context` em chamadas autenticadas;
- `X-Plugin-Public-Context` apenas em rotas públicas declaradas;
- `X-Plugin-Installer-Context` somente no smoke test.

Use `createPluginDatabase` de `@nexus/plugin-sdk/backend` para abrir o binding
`DB` ou `HYPERDRIVE`; o plugin externo não importa pacotes privados do Core.

Cheque a permissão concreta em toda operação. O Core remove cookies,
Authorization, API key e headers internos recebidos antes do encaminhamento.
Bodies e responses continuam como streams, permitindo binário, SSE e upgrade
WebSocket sem conversão obrigatória para JSON.

Mantenha `POST /__installer/smoke`. O Worker não recebe `workers.dev`, preview
URL ou rota pública. O acesso de negócio ocorre exclusivamente pelos gateways
do Core.

## 6. Recursos Cloudflare declarativos

Recursos possuem `name` lógico estável, `binding`, `required`, `retention` e
`capabilityVersion: 1`. Nomes/IDs físicos são gerados ou associados por
instalação e nunca entram no ZIP.

```json
{
  "resources": [
    {
      "name": "documents",
      "type": "r2",
      "binding": "DOCUMENTS",
      "required": true,
      "retention": "preserve",
      "configuration": {}
    },
    {
      "name": "cache",
      "type": "kv",
      "binding": "CACHE",
      "required": false,
      "retention": "preserve",
      "configuration": {}
    },
    {
      "name": "events_dlq",
      "type": "queue",
      "binding": "EVENTS_DLQ",
      "configuration": {}
    },
    {
      "name": "events",
      "type": "queue",
      "binding": "EVENTS",
      "configuration": {
        "consumer": true,
        "deadLetterResource": "events_dlq",
        "settings": { "batch_size": 10, "max_retries": 3 }
      }
    },
    {
      "name": "state",
      "type": "durable_object",
      "binding": "STATE",
      "retention": "preserve",
      "configuration": { "className": "InventoryState", "storage": "sqlite" }
    },
    {
      "name": "hourly",
      "type": "cron",
      "binding": "HOURLY",
      "configuration": { "schedules": ["0 * * * *"] }
    },
    {
      "name": "models",
      "type": "ai",
      "binding": "AI",
      "required": false,
      "configuration": {}
    }
  ]
}
```

O banco da instalação é fornecido como `DB` (D1) ou `HYPERDRIVE`
(PostgreSQL). Um recurso `database` com `mode: installation` pode criar um alias
de binding. R2, KV e Queue usam credencial administrativa temporária por
operação; o Core descarta seu valor. AI, Cron e Durable Objects são associados
durante o upload do Worker. Classes Durable Object novas usam `exports`
declarativos com storage SQLite; remoção ou rename exige procedimento explícito
e não passa como update comum.

Queue consumers e DLQ são reconciliados pelo nome/ID registrado. Cron é
reconciliado como conjunto de expressões UTC. Updates reutilizam todos os
recursos; uninstall preserva dados por padrão, remove triggers/consumers e
mantém o Worker quando isso for necessário para preservar Durable Objects.

## 7. Segredos e APIs públicas

Declare cada segredo com nome, label, obrigatoriedade e permissão de gestão. O
Core grava o valor diretamente como Worker Secret, retorna apenas
`configured: true/false` e o preserva em updates. Não use nomes reservados do
Core.

`publicRoutes` é uma lista de prefixos internos, por exemplo
`["/provider/webhook"]`. O gateway rejeita qualquer outro path. Valide a
assinatura/segredo do provedor antes de processar o body. Se houver
`openapi.json`, todos os paths precisam estar no namespace autenticado ou em um
prefixo público declarado; o Core o publica dinamicamente em
`/api/v1/plugins/<id>/openapi.json`.

## 8. Migrations

Crie pares com o mesmo ID:

```text
migrations/d1/0001_init.sql
migrations/postgres/0001_init.sql
```

São aceitos somente `CREATE TABLE`, `CREATE [UNIQUE] INDEX` e
`ALTER TABLE ... ADD COLUMN`, sempre no `tablePrefix`. Uma migration aplicada
nunca é editada. Uninstall preserva tabelas e hashes.

## 9. Build, assinatura e publicação

Use Node.js 24+, pnpm 11.19.0 e o pipeline do Wrangler:

```bash
pnpm install --frozen-lockfile
pnpm build
PLUGIN_SIGNING_PRIVATE_KEY="<PKCS8-base64url>" \
PLUGIN_SIGNING_KEY_ID="publisher-v1" \
pnpm package
```

O packager usa o output Worker do Wrangler e o bundle ESM do frontend. Não use
um bundle Node cru. A chave privada pertence ao CI/secret manager e jamais é
commitada, impressa ou enviada ao Core.

Publique o `.plugin.zip` como asset imutável de um GitHub Release no
repositório do marketplace e gere o catálogo assinado conforme
`docs/PLUGIN-MARKETPLACE.md`. Pacotes formato 2 não são versionados no
repositório do Core.

## 10. Compatibilidade e testes

Uma atualização pode adicionar código, telas, permissões e recursos, mas não
pode alterar migrations antigas, diminuir versão automaticamente, mudar a
identidade de recurso ou renomear/remover classe Durable Object. Preserve
contratos Host API/Core API já publicados. O Core mantém Service Bindings,
Worker Secrets, assets instalados, tabelas e recursos quando ele próprio é
atualizado.

Antes de publicar, execute typecheck, testes de backend/UI, matriz D1/PostgreSQL,
build Wrangler, verificação do bundle e validação do pacote. Teste instalação,
update, reinstall, uninstall conservador, dois usuários com preferências
distintas, permissões reduzidas, deep link, marketplace offline e falha de cada
recurso solicitado.

Os quatro plugins históricos continuam no monorepo durante a versão ponte. O
registry e os pacotes formato 1 existem apenas para manter instalações antigas;
plugins novos usam exclusivamente o host dinâmico e não devem ser adicionados a
allowlists, registries, traduções ou TypeScript references do Core.
