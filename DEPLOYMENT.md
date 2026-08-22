# Cloudflare Workers deployment

This is the authoritative deployment runbook. Run all commands from the repository root and stop on any error; never silently switch between D1 and PostgreSQL.

## 1. Prerequisites and decisions

1. Install Node.js 24+ and pnpm 11.19+.
2. Authenticate Wrangler (`pnpm exec wrangler login`) or set `CLOUDFLARE_API_TOKEN` for CI.
3. Select exactly one provider: `d1` or `postgres`.
4. Define the final application URL, for example `https://nexus-edge.example.com`.
5. Generate independent random values for `APP_INSTALLATION_ID`, `BETTER_AUTH_SECRET`, and `WEBHOOK_ENCRYPTION_KEY`.

Do not reuse secrets between staging and production. Public bootstrap is available only while `app_settings.bootstrap_state` is not `complete`; the API rejects further attempts after completion.

## 2. Install and validate

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:matrix
pnpm openapi:check
pnpm build:frontend
pnpm build:plugins
pnpm verify:bundle
```

The installable CRM artifact will be `artifacts/crm.plugin.zip`.

## 3A. D1 path

1. Create the database and copy the returned `database_id`:

```bash
pnpm exec wrangler d1 create nexus-edge-db
```

2. In `workers/core/wrangler.jsonc`, replace `replace-with-d1-database-id` with the ID in both `vars.D1_DATABASE_ID` and `d1_databases[0].database_id`.
3. Set `APP_INSTALLATION_ID`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, and, when needed, `WEBHOOK_ALLOWED_DOMAINS` under `vars`.
4. Create the Queue and DLQ:

```bash
pnpm exec wrangler queues create nexus-edge-webhooks
pnpm exec wrangler queues create nexus-edge-webhooks-dlq
```

5. Export the same installation ID in the provisioning process:

```bash
APP_INSTALLATION_ID="install_..." pnpm provision:d1
```

## 3B. PostgreSQL + Hyperdrive path

1. Copy `workers/core/wrangler.postgres.example.jsonc` to an environment file such as `workers/core/wrangler.postgres.jsonc`.
2. Create an empty PostgreSQL database and keep `DATABASE_URL` only in the terminal or secret manager.
3. Create a Hyperdrive and copy its ID:

```bash
pnpm exec wrangler hyperdrive create app-postgres --connection-string="$DATABASE_URL"
```

4. Replace `replace-with-hyperdrive-id`; set `APP_INSTALLATION_ID`, URLs, and `DATABASE_PROVIDER=postgres` in the new file.
5. Provision the schema:

```bash
APP_INSTALLATION_ID="install_..." DATABASE_URL="postgres://..." pnpm provision:postgres
```

6. Select the file during deployment:

```bash
CORE_WRANGLER_CONFIG=workers/core/wrangler.postgres.jsonc pnpm deploy:core
```

Do not include `DB` in the PostgreSQL path and do not include `HYPERDRIVE` in the D1 path. Runtime validation fails closed when bindings are inconsistent.

## 4. Core secrets

Use the selected `--config` value for every command below. Keep the first line for D1; replace it with the file created in step 3B for PostgreSQL:

```bash
export CORE_CONFIG=workers/core/wrangler.jsonc
pnpm exec wrangler secret put BETTER_AUTH_SECRET --config "$CORE_CONFIG"
pnpm exec wrangler secret put WEBHOOK_ENCRYPTION_KEY --config "$CORE_CONFIG"
pnpm exec wrangler secret put CF_API_TOKEN --config "$CORE_CONFIG"
pnpm exec wrangler secret put CF_ACCOUNT_ID --config "$CORE_CONFIG"
```

Use a separate Cloudflare token per environment with only the permissions required for Workers Scripts/settings. `CF_ACCOUNT_ID` is not inherently secret, but this runbook accepts it as one for simpler configuration. In PostgreSQL mode, the Hyperdrive ID is in the config; the Core never receives the database password.

## 5. Publish the Core and SPA

Before every release, apply pending migrations for the selected provider. The
commands are idempotent and preserve the current `app_settings` row:

```bash
APP_INSTALLATION_ID="install_..." pnpm provision:d1
# or: APP_INSTALLATION_ID="install_..." DATABASE_URL="postgres://..." pnpm provision:postgres
```

```bash
CF_API_TOKEN="..." CF_ACCOUNT_ID="..." CORE_WORKER_NAME=nexus-edge-core CORE_WRANGLER_CONFIG="$CORE_CONFIG" pnpm deploy:core
```

The script builds the SPA, reads existing `PLUGIN_*` Service Bindings, publishes, and reapplies/verifies them. This prevents a new Core release from removing plugins installed through the panel.

`pnpm deploy:direct` uses `CLOUDFLARE_API_TOKEN` only to publish. It inherits the Worker's existing `CF_API_TOKEN` and `CF_ACCOUNT_ID` installer secrets unless separate replacement values are explicitly supplied; it never copies the deployment credential into runtime automatically.

Configure a Cloudflare Custom Domain/Route for the Core. Set `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` to exactly the published HTTPS origin. Then verify:

```bash
curl -fsS https://YOUR-DOMAIN/health
curl -fsS https://YOUR-DOMAIN/api/v1/setup/status
```

Open `https://YOUR-DOMAIN/setup` and create the first administrator using only a name, email address, and a password of at least eight characters. There is no public sign-up; the bootstrap endpoint permanently closes for that installation after completion.

## 6. Install the CRM

New plugin packages must follow `docs/PLUGIN-DEVELOPMENT.md`. In particular,
build the Worker with Wrangler dry-run, package it with
`scripts/package-plugin.ts`, and never substitute a raw Node/esbuild bundle.

1. Sign in as an administrator.
2. Open `/app/plugins`.
3. Click **Add** and select `artifacts/crm.plugin.zip`.
4. Review the version, sizes, migrations, menus, and permissions.
5. Confirm the installation. The interface advances one stage per request and displays the persisted state.
6. Verify `/app/crm/leads`, create/edit/delete one lead, and inspect `/app/audit`.

The Installer creates `app-plugin-crm`, applies only the active provider's
migration, disables the public URL, and adds `PLUGIN_CRM` to the Core. On
failure, copy the expandable support report before closing the panel and attach
it to the incident or developer report. It contains safe operation and request
identifiers, the failed stage, a bounded error code, and package metadata; raw
provider logs, credentials, and secrets are excluded.

Installation and removal use the current authenticated administrator session;
they do not request the account password again. API operators can resume a
failed operation only with exactly the same artifact; selecting a package again
in the panel starts a new safe operation. A rebuilt package has different hashes
and must always start a new operation. Core Worker settings updates are
multipart requests whose JSON part is named `settings`; `pnpm deploy:core`
preserves and verifies all existing `PLUGIN_*` bindings.

## 7. Production verification

- `/health` returns the expected version and provider;
- setup completes and login works without a public sign-up route;
- the language selector switches the complete interface between Portuguese and English and persists after reload;
- every CRUD displays one row per record with search, add, click-to-open, edit, and delete;
- group and API-key forms organize plain-language permission labels by system area and expose read, create, update, and delete independently;
- direct user creation supports name, email, a password of at least eight characters, active status, and groups; editing exposes the same fields and keeps password replacement optional;
- plugin permissions are absent before installation, appear after successful installation, and disappear after uninstallation;
- the separate invitation action creates a one-time link and the fragment disappears after the SPA reads it;
- an API key cannot exceed the user's permissions;
- CRM works only through `/api/v1/p/crm/*`;
- the plugin Worker does not respond through `workers.dev` or a preview URL;
- a test webhook arrives with the correct `X-App-Signature` and event;
- `/api/docs` and `/api/v1/openapi.json` respond for an authenticated user;
- auditing contains setup, user, group, plugin, and webhook events;
- another `pnpm deploy:core` preserves `PLUGIN_CRM`.

## 8. Rollback, backup, and provider

Worker versions in the Cloudflare dashboard/CLI can roll back code deployments. Databases and plugins have no automatic destructive rollback: back up before migrations. Uninstallation preserves tables. Do not change `DATABASE_PROVIDER` for an existing installation without an explicit export, restore, count-validation, and new-installation-ID procedure.

See `docs/BACKUP-RESTORE.md` and `docs/IMPLEMENTATION-MAP.md` for operations and traceability.
