# Repository instructions

This repository uses the [open `AGENTS.md` format](https://agents.md/) as the
portable entry point for automated development tools. The rules are tool-neutral
and rely only on tracked documentation and executable repository commands.

## Start here

- Read `DEPLOYMENT.md` before changing or publishing infrastructure.
- Read `docs/PLUGIN-DEVELOPMENT.md` before creating or changing a plugin.
- Read `docs/DATA-TABLE-STANDARD.md` before creating or changing a record-list
  table.
- Read `docs/INTERNATIONALIZATION.md` before changing user-facing text or locale
  behavior.
- Read `docs/UI-STYLING-STANDARD.md` before creating or changing user-facing
  screens or shared interface components.

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
  `pnpm openapi:check`, `pnpm build`, `pnpm verify:artifacts`, and
  `pnpm verify:bundle`.
- Production deployments are GitHub-driven. When the owner requests deployment,
  commit only the intended changes and push them to `main`; the
  `deploy-production` job in `.github/workflows/ci.yml` validates the commit,
  applies D1 migrations, publishes the Core, and runs production smoke tests.
- The independently maintained public plugin catalog consumes
  `plugins/*/{catalog.json,manifest.json,release/*.plugin.zip}` from this
  repository. Keep those plugin-owned inputs current, but do not add catalog
  application or deployment code here.
- Do not run `pnpm deploy:core`, `pnpm deploy:direct`, or `wrangler deploy`
  locally for an ordinary production release. `pnpm deploy:core` is the
  publishing implementation used by GitHub Actions and preserves/verifies
  dynamic `PLUGIN_*` Service Bindings. A direct manual publish requires an
  explicit owner request for an exceptional recovery or non-production target.
- If GitHub Actions fails, stop and report or fix the failing commit; never
  bypass a failed workflow with a local direct deployment.
- Build plugin Workers with Wrangler dry-run and package them with
  `scripts/package-plugin.ts`; never substitute a raw Node bundle.
- Keep every plugin-specific Worker, frontend, manifest, migration, and release
  artifact under its single `plugins/<plugin-id>/` directory.
- Commit every generated `plugins/*/release/*.plugin.zip` with the plugin source
  that produced it. Packaging must remain reproducible, and CI must reject
  stale or missing tracked plugin artifacts.
- A publicly downloadable plugin must keep `catalog.json`, `manifest.json`, and
  `release/<plugin-id>.plugin.zip` together in `plugins/<plugin-id>/`.
- Keep plugin Workers private with `workers_dev` and preview URLs disabled.
- Every new or modified record-list table must follow
  `docs/DATA-TABLE-STANDARD.md` and use the canonical
  `ConfigurableDataTable`. Do not expand automated-test allowances to admit a
  parallel table implementation.

## Portability

`AGENTS.md`, `DEPLOYMENT.md`, `README.md`, and the topic guides under `docs/`
are the complete shared source of truth. Do not require proprietary prompts,
plugins, skills, memory stores, connectors, or hidden state. A tool that does
not discover `AGENTS.md` automatically may use a committed compatibility
adapter only when the adapter imports this file without duplicating or
extending its rules.

Nested directories may add another `AGENTS.md` only for genuinely local rules.
The closest file applies to that subtree and must not weaken repository-wide
security, testing, migration, or deployment requirements.
