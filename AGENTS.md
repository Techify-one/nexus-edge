# Repository instructions

This repository uses the [open `AGENTS.md` format](https://agents.md/) as the
portable entry point for automated development tools. The rules are tool-neutral
and rely only on tracked documentation and executable repository commands.

## Start here

- Read `CONTRIBUTING.md` before changing code or documentation.
- Read `DEPLOYMENT.md` before changing or publishing infrastructure.
- Read `docs/PLUGIN-DEVELOPMENT.md` before creating or changing a plugin.
- Read `docs/DATA-TABLE-STANDARD.md` before creating or changing a record-list
  table.
- Read `docs/INTERNATIONALIZATION.md` before changing user-facing text or locale
  behavior.

## Required workflow

- Never store tokens, passwords, connection strings, session data, or other
  secrets in the repository.
- Use Node.js 24+ and pnpm 11.19.0 with
  `pnpm install --frozen-lockfile`.
- Preserve the selected database provider. Do not switch between D1 and
  PostgreSQL without an explicit provider-migration procedure.
- Preserve existing user changes and unrelated worktree changes.
- Use additive migrations and stop on migration, provider, binding, or smoke-test
  errors.
- Before deployment, run `pnpm typecheck`, `pnpm test`, `pnpm test:matrix`,
  `pnpm openapi:check`, `pnpm build`, and `pnpm verify:bundle`.
- Publish the Core with `pnpm deploy:core` so dynamic `PLUGIN_*` Service Bindings
  are preserved and verified.
- Build plugin Workers with Wrangler dry-run and package them with
  `scripts/package-plugin.ts`; never substitute a raw Node bundle.
- Keep plugin Workers private with `workers_dev` and preview URLs disabled.

## Portability

`AGENTS.md`, `CONTRIBUTING.md`, `DEPLOYMENT.md`, and `docs/` are the complete
shared source of truth. Do not require proprietary prompts, plugins, skills,
memory stores, connectors, or hidden state. A tool that does not discover
`AGENTS.md` automatically should be configured locally to load this file; do not
commit a duplicate vendor-specific instruction file.

Nested directories may add another `AGENTS.md` only for genuinely local rules.
The closest file applies to that subtree and must not weaken repository-wide
security, testing, migration, or deployment requirements.
