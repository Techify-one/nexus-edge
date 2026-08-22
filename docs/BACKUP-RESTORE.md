# Backup and restore

Create a backup before migrations, plugin updates, or provider changes. Periodically test restoration under a different installation ID.

## D1

```bash
pnpm exec wrangler d1 export nexus-edge-db --remote --output backups/nexus-edge-db-YYYYMMDD.sql --config workers/core/wrangler.jsonc
pnpm exec wrangler d1 execute nexus-edge-db-restore --remote --file backups/nexus-edge-db-YYYYMMDD.sql --config workers/core/wrangler.jsonc
```

Keep `backups/` outside version control and store the export encrypted. After restoring, point the Core to the restored database and validate `installation_id`, `database_provider`, and `schema_version` before allowing traffic.

## PostgreSQL

```bash
pg_dump --format=custom --no-owner --file=backups/app-YYYYMMDD.dump "$DATABASE_URL"
createdb app_restore
pg_restore --no-owner --dbname="$RESTORE_DATABASE_URL" backups/app-YYYYMMDD.dump
```

Use tools compatible with the server version. Verify counts for the main tables, constraints, login, one CRM CRUD flow, pending outbox entries, and auditing.

## Changing provider

Do not change only the environment variable. Provision a new database with a new installation ID, transform types (epoch/boolean/JSON in D1; timestamptz/boolean/JSONB in PostgreSQL), import in dependency order, validate counts and sample hashes, configure only the new provider's binding, and then cut over. Keep the old database read-only during the rollback window.
