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

## Values that must come from the owner or environment

- database provider (`d1` or `postgres`);
- Cloudflare account/token and Worker name;
- final HTTPS domain and trusted origins;
- D1 or Hyperdrive IDs;
- independent secrets listed in the runbook.

Migrations are additive and plugin uninstallation preserves tables. Follow `docs/BACKUP-RESTORE.md` for backup, restore, and provider migration.
