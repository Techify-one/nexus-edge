# Implementation map

| Specification phase          | Repository delivery                                                                                        | Verification                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 0 — Dual-database foundation | explicit Drizzle schemas, D1/PG migrations, `DatabasePort`, closed factory                                 | `pnpm test:matrix`           |
| 1 — Auth and first admin     | Better Auth, app settings, atomic/resumable bootstrap, no public sign-up                                   | tests + staging flow         |
| 2 — Invitations, users, CASL | one-time invitations, full user editing, granular CRUD permissions, groups, last-admin protection, Ability | authorization tests + API    |
| 3 — Gateway and CRM          | isolated CRM Worker, gateway, minimal context                                                              | CRUD `/app/crm/leads`        |
| 4 — API-first                | cookie/Bearer/API key, envelopes, idempotency, reauth, OpenAPI                                             | `pnpm openapi:check`         |
| 5 — Webhooks                 | encrypted endpoint, HMAC, outbox, Queue, retry, SSRF                                                       | `tests/security.test.ts`     |
| 6 — Frontend                 | SPA, pt-BR/en i18n, shell, lazy routes, single-line CRUD tables                                            | build + responsive QA        |
| 7 — Installer                | browser-side package, policy, migrations, Cloudflare API, hardening, binding                               | CRM `.plugin.zip` in staging |
| 8 — Launch                   | CI, preflight, runbook, backup, bundle budget                                                              | `.github/workflows/ci.yml`   |

## Boundaries

- The SPA communicates only with the Core.
- The Core reconstructs identity and permissions on every request.
- A plugin receives only `userId`, concrete permissions, and `requestId` through a Service Binding.
- The active provider is verified against `app_settings`; there is no fallback.
- Domain effects and outbox writes share the same atomic unit.
- Plugin UI code is compiled into the Core; v1 has no remote JavaScript.
- Permission records from a plugin are selectable only while that plugin has `installed` status; stale database rows are filtered at the API boundary.
- Permission keys remain stable internal identifiers, while the presentation layer supplies plain-language labels for each locale and groups them by system area.
- Core resources authorize read, create, update, and delete independently. Audit remains read-only; webhook test/redelivery are separate operational permissions.

## CRUD interface

`frontend/src/components/ui/data-table.tsx` is the shared contract. It uses `table-layout: fixed`, compact height, truncation, click/Enter/Space to open, and a separate actions cell. Users, groups, leads, API keys, webhooks, and plugins implement search, Add, edit, and delete/revoke. Action buttons and editable fields follow the user's concrete permission. Auditing is deliberately read-only.

## Deliberate v1 limitations

- first-party plugin packages, up to 4 MiB raw and 3 MiB gzip for the Worker;
- artifacts are not stored in R2, so resume may require the same local file;
- plugin migrations are additive only;
- one global Installer lock;
- provider migration is an operational procedure, not a button;
- Service Binding, cookie, Queue, and public-exposure tests require a real Cloudflare staging environment.
