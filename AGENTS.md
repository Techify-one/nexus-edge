# Codex instructions — Cloudflare deployment

This repository contains a complete Cloudflare Workers application. Before changing or publishing any resource, read `DEPLOY-CODEX.md`; it is the authoritative runbook.

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
- Every data column must have a stable `key`, translated `label`, `render`, `sortValue`, and deliberate `size`, `minSize`, and `maxSize`. A column may omit sorting only when sorting has no meaningful definition, and that exception must be documented in code.
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
