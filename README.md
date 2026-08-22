# Nexus Edge

Nexus Edge is a lightweight, modular runtime for distributed applications. This implementation currently targets Cloudflare Workers, with a Core Worker, React SPA, and plugins isolated through Service Bindings. It follows the v11 functional specification and includes Better Auth authentication, CASL authorization, D1/PostgreSQL support, CRM, API keys, signed webhooks, auditing, and a plugin Installer.

## Included features

- Core Worker with cookie, Bearer token, and personal API-key authentication;
- first-administrator bootstrap without public sign-up;
- direct user creation and complete editing with name, email, password, status, and groups, plus optional invitations and independent read/create/update/delete permissions;
- user-friendly, area-grouped permission labels in every supported language, with plugin permissions exposed only while that plugin is installed;
- explicit D1 or PostgreSQL/Hyperdrive database-provider selection;
- CRM in a separate Worker, accessible only through the Core gateway;
- webhooks with an outbox, Queue delivery, HMAC signatures, retries, and SSRF protection;
- first-party Installer with additive migrations, a global lock, persisted states, and dynamic bindings;
- responsive SPA. New and migrated CRUD tables use per-user column order, visibility, sorting, live independent resizing, and a fixed actions/settings column;
- Portuguese and English UI with typed catalogs, browser detection, persisted preference, and locale-aware date formatting;
- equivalent migrations, tests, CI, OpenAPI, and safe deployment scripts.

## Local development

Requirements: Node.js 24+, pnpm 11.19+, and a Cloudflare account for testing real bindings.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:matrix
pnpm dev
```

Development uses the Core `wrangler.jsonc` through Cloudflare's official Vite plugin. Apply migrations with Wrangler before testing local D1.

## Structure

```text
frontend/                 React SPA
packages/                 contracts, schemas, and database port
workers/core/             Core, auth, API, gateway, webhooks, and installer
workers/plugin-crm/       isolated CRM backend
workers/plugin-template/  minimal base for new plugins
scripts/                  provisioning, packaging, and safe deployment
tests/                    contracts, security, and migrations
docs/                     architecture, operations, and backup
```

People and automated development tools should start with the open-format
[AGENTS.md](./AGENTS.md) for repository-wide engineering rules and follow
[DEPLOYMENT.md](./DEPLOYMENT.md) before publishing. These documents describe
commands, invariants, and verification criteria without depending on a specific
vendor.

Follow [docs/INTERNATIONALIZATION.md](./docs/INTERNATIONALIZATION.md) to add languages.

Follow [docs/DATA-TABLE-STANDARD.md](./docs/DATA-TABLE-STANDARD.md) whenever
creating a table or changing an existing record-list table. The repository rules
make this configurable, per-user table contract mandatory for every
implementation workflow.

Follow [docs/PLUGIN-DEVELOPMENT.md](./docs/PLUGIN-DEVELOPMENT.md) and then copy
[workers/plugin-template](./workers/plugin-template) when creating a plugin.
The guide defines the required Wrangler build, manifest, paired migrations,
private Service Binding, package layout, frontend registration, retry behavior,
and release checks. Plugin tables use the same component, layout, behavior, and
per-user Core preference storage as Core tables.

## Main commands

| Command                   | Result                                                    |
| ------------------------- | --------------------------------------------------------- |
| `pnpm preflight`          | checks required files and reports placeholders/secrets    |
| `pnpm provision:d1`       | applies migrations and creates `app_settings` in D1       |
| `pnpm provision:postgres` | applies all ordered migrations through `DATABASE_URL`     |
| `pnpm build:frontend`     | builds the production SPA                                 |
| `pnpm build:plugins`      | builds and packages `artifacts/crm.plugin.zip`            |
| `pnpm deploy:core`        | publishes Core + assets and preserves existing `PLUGIN_*` |
| `pnpm openapi:check`      | verifies the minimum API map                              |

## Operational security

Never store secrets in the repository. Use `wrangler secret put`. Webhook URLs are encrypted; the signing secret is shown only on creation/rotation. The Cloudflare API token exists only in the Core and should be dedicated to the environment. Plugins have no public routes and receive only concrete identity/permissions from the Core.
