# Nexus Cloudflare

An API-first SaaS application for Cloudflare Workers with a Core Worker, React SPA, and plugins isolated through Service Bindings. The implementation follows the v11 functional specification and includes Better Auth authentication, CASL authorization, D1/PostgreSQL support, CRM, API keys, signed webhooks, auditing, and a plugin Installer.

## Included features

- Core Worker with cookie, Bearer token, and personal API-key authentication;
- first-administrator bootstrap without public sign-up;
- direct user creation and complete editing with name, email, password, status, and groups, plus optional invitations and independent read/create/update/delete permissions;
- user-friendly, area-grouped permission labels in every supported language, with plugin permissions exposed only while that plugin is installed;
- explicit D1 or PostgreSQL/Hyperdrive database-provider selection;
- CRM in a separate Worker, accessible only through the Core gateway;
- webhooks with an outbox, Queue delivery, HMAC signatures, retries, and SSRF protection;
- first-party Installer with additive migrations, a global lock, persisted states, and dynamic bindings;
- responsive SPA. Every CRUD screen has search, an add button, one compact table row per record, click-to-open behavior, and edit/delete actions;
- Portuguese and English UI with typed catalogs, browser detection, persisted preference, and locale-aware date formatting;
- equivalent migrations, tests, CI, OpenAPI, and safe deployment scripts.

## Local development

Requirements: Node.js 24+, pnpm 11.19+, and a Cloudflare account for testing real bindings.

```bash
pnpm install
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

Follow [DEPLOY-CODEX.md](./DEPLOY-CODEX.md) to publish. The file is written so another Codex session can deploy without rediscovering the architecture.

Follow [docs/INTERNATIONALIZATION.md](./docs/INTERNATIONALIZATION.md) to add languages.

The initial D1 environment is documented in `docs/DEPLOYMENT-STATUS.md`. `pnpm deploy:direct` is an official-API alternative when a Wrangler subprocess is unavailable. It reads deployment credentials from environment variables and preserves existing application secrets, installer credentials, and `PLUGIN_*` bindings when replacement values are omitted; the deployment token is never copied into the Worker automatically.

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
