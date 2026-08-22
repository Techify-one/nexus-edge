# Plugin development and packaging

This is the authoritative guide for creating installable Nexus Edge plugins.
Start from `workers/plugin-template`; do not create a Worker, package layout, or
build command from memory.

Plugin UI is compiled into the Core SPA. The plugin Worker is a private backend
reached only through a Cloudflare Service Binding and the Core gateway at
`/api/v1/p/<plugin-id>/*`.

## 1. Create the plugin from the template

For an example plugin named `inventory`:

```bash
cp -R workers/plugin-template workers/plugin-inventory
```

Replace every template identifier consistently:

| Location                              | Required value                    |
| ------------------------------------- | --------------------------------- |
| directory                             | `workers/plugin-inventory`        |
| `package.json` name                   | `@app/plugin-inventory`           |
| `manifest.json` id                    | `inventory`                       |
| `manifest.json` table prefix          | `inventory_`                      |
| Wrangler Worker name                  | `app-plugin-inventory`            |
| permission prefix                     | `inventory.`                      |
| Core binding created by the Installer | `PLUGIN_INVENTORY`                |
| Core gateway                          | `/api/v1/p/inventory/*`           |
| frontend directory                    | `frontend/src/plugins/inventory/` |
| table preference IDs                  | `plugin.inventory.<resource>`     |

Plugin IDs must match `^[a-z][a-z0-9_]{1,31}$`. Released IDs, permission keys,
migration IDs, route keys, table IDs, and data-column keys are persistent
contracts; do not rename them casually.

## 2. Keep the manifest and Wrangler configuration aligned

The manifest is strict and accepts only these fields:

- `id`, `name`, and valid semantic `version`;
- `apiVersion: 1` and a valid `coreMinVersion`;
- a real `compatibilityDate` in `YYYY-MM-DD` format;
- only compatibility flags allowed by the Core environment;
- `databaseDialects: ["d1", "postgres"]` in that order;
- `tablePrefix` equal to `<id>_`;
- namespaced permissions in `<id>.<resource>.<action>` form;
- menu entries whose route keys are compiled into the Core.

Keep `compatibilityDate` and `compatibilityFlags` identical in `manifest.json`
and `wrangler.jsonc`. Keep these Wrangler security settings:

```jsonc
{
  "name": "app-plugin-inventory",
  "main": "src/index.ts",
  "workers_dev": false,
  "preview_urls": false,
}
```

The Installer supplies the production database binding and provider variable.
Never put Cloudflare tokens, passwords, connection strings, session cookies, or
other secrets in the plugin, manifest, ZIP, migrations, or Wrangler file.

## 3. Build with Wrangler

Every plugin package must use Wrangler's Worker pipeline:

```json
{
  "scripts": {
    "build": "wrangler deploy --dry-run --outdir dist --config wrangler.jsonc"
  }
}
```

Do not replace this with a raw `esbuild --platform=node` bundle. A raw Node
bundle can leave dynamic `__require(...)` calls for modules such as `events`,
`crypto`, `fs`, `net`, `stream`, or `util`. Cloudflare then rejects an otherwise
valid package during the Installer's `deploying` stage. Wrangler converts
supported Node compatibility imports into the Worker module format.

Add the new `workers/plugin-<id>/dist/index.js` path to
`scripts/verify-bundles.ts`. The verification must reject unsupported dynamic
Node built-in requires. Add the plugin build and packaging command to the root
build workflow so CI exercises the installable artifact.

## 4. Backend boundary and authorization

Copy the template's `X-Plugin-Context` middleware. The Core generates this
internal header and sends only `userId`, concrete permission keys, and
`requestId` through the Service Binding.

- Never authenticate plugin routes directly with Core cookies, passwords,
  personal API keys, or Better Auth state.
- Reject missing or malformed plugin context before business routes run.
- Check the precise permission on every protected operation.
- Keep `POST /__installer/smoke`; it must return a successful response when the
  internal context is valid.
- Expose business routes through `/api/v1/p/<plugin-id>/*`, not a public Worker
  hostname.
- Use the shared database abstraction and the active provider supplied by the
  Installer.

The plugin Worker must remain unreachable through `workers.dev` and preview
URLs. Do not manually add a public route during development or installation.

## 5. Database migrations

Create matching files for both providers:

```text
workers/plugin-inventory/migrations/
  d1/0001_init.sql
  postgres/0001_init.sql
```

The two directories must contain the same ordered migration IDs. IDs use
`NNNN_lowercase_name`, and an applied migration must never be edited. Add a new
paired migration instead.

Only additive statements are accepted:

- `CREATE TABLE`;
- `CREATE INDEX` or `CREATE UNIQUE INDEX`;
- `ALTER TABLE ... ADD COLUMN`.

Every affected table name must start with the manifest's table prefix. Foreign
key actions such as `ON DELETE CASCADE` are allowed; standalone destructive
statements such as `DELETE`, `DROP`, `TRUNCATE`, column removal, or table
renaming are not. Plugin removal deliberately preserves plugin tables.

Keep D1 and PostgreSQL semantics equivalent while using the correct provider
types, for example integer timestamps for D1 and `TIMESTAMPTZ` for PostgreSQL.
Update `scripts/test-database-matrix.ts` coverage for the new migration pair.

## 6. Frontend registration

For every manifest menu route:

1. Create the page under `frontend/src/plugins/<plugin-id>/`.
2. Register its lazy import in `frontend/src/plugins/registry.ts`.
3. Add the route key to the Core allowlist in
   `workers/core/src/installer/manifest.ts`.
4. Add translated labels to every typed locale catalog.
5. Call only the Core gateway path `/api/v1/p/<plugin-id>/*` with the shared API
   client.

Read `docs/INTERNATIONALIZATION.md` and `docs/DATA-TABLE-STANDARD.md`. Every new
record-list table must use `ConfigurableDataTable` with an immutable
`plugin.<plugin-id>.<resource>` ID, stable data-column keys, explicit sizes,
sorting, accessibility, and Core-owned per-user preferences. Do not introduce a
plugin-specific table or preference store.

Document plugin endpoints in the Core OpenAPI map and add API, permission, UI,
and interaction tests in the same change.

## 7. Package the artifact

Build first, then use the repository packager:

```bash
pnpm --filter @app/plugin-inventory build
node --import tsx scripts/package-plugin.ts inventory
```

The resulting `artifacts/inventory.plugin.zip` must contain exactly the expected
install inputs:

```text
manifest.json
worker.mjs
migrations/d1/*.sql
migrations/postgres/*.sql
```

Do not hand-build the ZIP or package TypeScript source as `worker.mjs`. The raw
combined install input must not exceed 4 MiB, and the gzipped Worker must not
exceed 3 MiB. Artifacts are local build outputs and must not contain source
maps, credentials, `.dev.vars`, environment files, or unrelated files.

## 8. Required verification

Use Node.js 24+ and pnpm 11.19.0. From the repository root, run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:matrix
pnpm openapi:check
pnpm build
pnpm verify:bundle
pnpm format:check
```

Also inspect the package before installation:

```bash
unzip -l artifacts/inventory.plugin.zip
```

For a production/staging install, verify all of the following:

- the operation reaches `installed`;
- the Installer smoke test passes;
- the plugin is listed with the expected version and active database provider;
- business requests work only through the Core gateway;
- the Worker has no public `workers.dev` or preview URL;
- permissions and menu entries appear only while the plugin is installed;
- uninstall removes the binding and permission exposure while preserving data;
- a subsequent Core deployment preserves the `PLUGIN_*` Service Binding.

## 9. Installer operations and retries

Installation and removal use the authenticated administrator session and do not
ask for the account password again.

Removal is intentionally two-step. The first delete action uninstalls an
installed plugin, removes its Worker, binding, and permission exposure, and
keeps an `uninstalled` row visible. A second delete action removes that catalog
row. Both actions preserve plugin tables, migration hashes, operation history,
and audit history.

The Installer persists each stage. If a stage fails, keep the operation ID and
select exactly the same `.plugin.zip` to resume. Package hashes cover the
manifest, Worker, and both migration sets. A rebuilt or edited package is a new
artifact and must start a new operation; it cannot resume an older operation.
Failed operations release the global Installer lock.

Common failures:

| Result                               | Meaning                                               | Action                                                      |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------- |
| `409 INSTALLER_BUSY`                 | another live operation owns the global lock           | wait for that operation or resume it                        |
| `409 PLUGIN_PACKAGE_HASH_MISMATCH`   | the selected file differs from the original operation | select the original file or start a new operation           |
| `409 PLUGIN_DOWNGRADE_NOT_AUTOMATIC` | requested version is below the installed version      | use a documented manual downgrade procedure                 |
| failure in `deploying`               | Cloudflare rejected the Worker bundle or metadata     | confirm the Wrangler build and bundle verification          |
| failure in `binding`                 | the Core Service Binding could not be updated         | verify Installer credentials and the Core settings contract |
| failure in `registering`             | the binding is not propagated yet or smoke failed     | retry with the same package after propagation               |

## 10. Core and Cloudflare invariants

These details are owned by the Core, not by individual plugins, but must remain
true when the Installer or deployment code changes:

- upload plugin Workers as module Workers using multipart `metadata` and
  `worker.mjs` parts;
- patch Core Worker settings as `multipart/form-data` with an
  `application/json` part named `settings` containing `{ "bindings": [...] }`;
- let the runtime generate the multipart boundary; never set the multipart
  `Content-Type` header manually;
- merge the new service binding with all existing Core bindings and verify it
  through a fresh settings read;
- use `pnpm deploy:core` so Core releases preserve and verify all dynamic
  `PLUGIN_*` bindings;
- disable and verify both public subdomain and preview exposure before
  registration;
- release the Installer lock atomically whenever a stage or package-hash check
  fails.

Use `workers/plugin-crm` as the complete executable example and
`workers/plugin-template` as the source for new plugin scaffolds.
