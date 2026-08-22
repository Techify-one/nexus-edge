# Cloudflare deployment status

Environment recreated from scratch on 2026-08-22 (America/Sao_Paulo).

| Resource     | Value                                                    |
| ------------ | -------------------------------------------------------- |
| Public URL   | `https://modular-workers-core.francisconeto.workers.dev` |
| Core Worker  | `modular-workers-core`                                   |
| Provider     | `d1`                                                     |
| Database     | `modular-workers-app-db`                                 |
| D1 ID        | `475c01e1-ea6e-4f1a-8e27-2f025a092e62`                   |
| Queue        | `modular-workers-webhooks`                               |
| DLQ          | `modular-workers-webhooks-dlq`                           |
| Cron         | `* * * * *`                                              |
| Preview URLs | disabled                                                 |

## Verification completed

- `/health`: `ok=true`, version `1.0.0`, provider `d1`;
- `/api/v1/setup/status`: bootstrap complete;
- SPA `/` and `/setup`: HTTP 200;
- 23 physical D1 tables, including domain and control tables;
- D1, assets, Queue, variables, and secret bindings present;
- Queue consumer configured with a DLQ and six attempts;
- Worker published on `workers.dev` with preview URLs disabled;
- bootstrap without an initial token, eight-character minimum passwords, and show/hide password controls;
- complete Portuguese and English UI with persisted preference;
- empty search normalized so the first administrator appears in the user list;
- source identifiers, database objects, system-owned data, API base messages, tests, scripts, and operational documentation use English by default;
- the system-owned `Administrators` group is localized only at the presentation layer;
- permission selectors use localized plain-language labels grouped by Users, Groups and access, Plugins, Webhooks, Audit, and installed plugin areas;
- each mutable Core resource separates read, create, update, and delete; Audit is read-only and webhook test/redelivery remain independent operational permissions;
- complete user editing covers name, email, optional replacement password, active status, and groups in one API operation;
- direct user creation uses the same complete form, requires a password of at least eight characters, and keeps one-time invitations as a separate action;
- password replacement requires recent reauthentication, uses the Better Auth password hash, and revokes the target user's existing sessions;
- D1 contains 19 Core permissions, no legacy broad permissions, and no `crm.*` permissions while CRM is not installed;
- all 19 Core permissions are assigned to the protected Administrators group;
- the existing user, two groups, and active sessions were preserved during deployment;
- application secrets were inherited instead of rotated;
- 31 automated tests pass, covering route authorization, complete user creation and update, password handling, and executable D1 migrations.

The first administrator has completed setup. Future users can be created directly or invited with a one-time link. This file contains no secrets.
