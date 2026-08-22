# Repository contribution rules

This repository contains a complete Cloudflare Workers application. These rules
apply equally to people, scripts, CI jobs, and automated development tools.
Before changing or publishing any resource, read `DEPLOYMENT.md`; it is the
authoritative runbook.

## Tool neutrality

Repository documentation and engineering workflows must remain independent of
editors, coding assistants, and automation vendors.

- Keep every required instruction in standard tracked Markdown files with
  ordinary relative links.
- Do not require proprietary instruction files, prompts, plugins, skills,
  memory stores, connectors, or hidden tool state.
- Express build, test, migration, packaging, and deployment procedures as
  versioned repository commands that a person, terminal, or CI runner can
  execute.
- Keep environment-specific values in environment variables or an external
  secret manager. Documentation must explain the required inputs without
  depending on one product's credential interface.
- Use the open `AGENTS.md` format as the portable discovery entry point. Treat
  it, `CONTRIBUTING.md`, `DEPLOYMENT.md`, and the documents under `docs/` as the
  shared source of truth.
- Tools that do not discover `AGENTS.md` automatically may use a minimal
  compatibility adapter. A tracked adapter must only import `AGENTS.md`; it must
  not duplicate, extend, replace, or contradict the shared instructions.
- Do not add vendor-specific rules, prompts, or workflows to the repository.

`tests/documentation-neutrality.test.ts` enforces the portable entry point,
validates import-only compatibility adapters, and checks shared documentation
for tool-vendor references.

## Operating rules

- Ask the owner whether the environment will use `d1` or `postgres`; never select or change the provider silently.
- Never store tokens, passwords, connection strings, or secrets in the repository.
- Use Node.js 24+ and pnpm 11.19.0 with `pnpm install --frozen-lockfile`.
- Before deployment, run `pnpm typecheck`, `pnpm test`, `pnpm test:matrix`, `pnpm openapi:check`, `pnpm build`, and `pnpm verify:bundle`.
- Publish the Core with `pnpm deploy:core`. This script preserves and verifies dynamic `PLUGIN_*` Service Bindings.
- Install the CRM through the Installer panel using `artifacts/crm.plugin.zip`; do not expose the plugin Worker through `workers.dev` or a preview URL.
- Stop on any migration, provider, binding, or smoke-test error. Do not improvise destructive rollbacks.

## Mandatory data-table standard

- Read `docs/DATA-TABLE-STANDARD.md` before creating a record-list table or changing an existing record-list table.
- Every new table must use `frontend/src/components/ui/configurable-data-table.tsx`. Do not use the legacy `DataTable` for new work.
- When a request changes an existing legacy table, migrate that table to `ConfigurableDataTable` as part of the change unless the owner explicitly excludes the migration.
- Give every table a unique, immutable `tableId`: `core.<resource>` for Core tables and `plugin.<plugin-id>.<resource>` for plugin tables. Never reuse or rename a released ID casually because it keys saved user preferences.
- Plugin tables are not exempt: plugin UI is compiled into the Core SPA and must import the same canonical `ConfigurableDataTable`. Do not create a plugin-local table component, preference endpoint, storage table, layout, or settings toolbar.
- When creating a plugin with frontend routes, follow `workers/plugin-template/README.md`, place its UI under `frontend/src/plugins/<plugin-id>/`, register it in `frontend/src/plugins/registry.ts`, and use `plugin.<plugin-id>.<resource>` for every table ID.
- Every data column must have a stable `key`, translated `label`, `render`, `sortValue`, and deliberate `size`, `minSize`, and `maxSize`. These fields are required by the TypeScript component contract; do not weaken it or create non-sortable data columns.
- Preserve all standard behavior: drag-to-reorder, show/hide, single-column sorting, live independent resizing, reset, keyboard-accessible rows, loading/empty states, and debounced server persistence scoped to the authenticated user.
- Column resizing must remain `columnResizeMode: "onChange"`, use exact column widths, follow the pointer while held, stop where released, and never redistribute width into a neighboring column.
- Keep the fixed `Ações` column outside user ordering/visibility/sizing. Put the icon-only column-settings trigger in its header, with an accessible label/title; do not add a separate toolbar row for it.
- Persist preferences through `/api/v1/me/table-preferences/:tableId`; never use global settings or `localStorage` as the source of truth.
- Add or update interaction tests for sorting, visibility, live isolated resizing, per-user persistence, and placement of the settings icon in the `Ações` header.
- `tests/table-standard.test.ts` prevents new uses of the legacy component and new one-off raw table implementations. Do not expand its allowances; migrate or extend the canonical component instead.

## Values that must come from the owner or environment

- database provider (`d1` or `postgres`);
- Cloudflare account/token and Worker name;
- final HTTPS domain and trusted origins;
- D1 or Hyperdrive IDs;
- independent secrets listed in the runbook.

Migrations are additive and plugin uninstallation preserves tables. Follow `docs/BACKUP-RESTORE.md` for backup, restore, and provider migration.
