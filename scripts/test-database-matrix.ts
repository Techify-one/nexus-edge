import { readdirSync, readFileSync } from "node:fs";

const coreMigrationNames = (dialect: "d1" | "postgres") =>
  readdirSync(`workers/core/migrations/${dialect}`)
    .filter((name) => name.endsWith(".sql"))
    .sort();
const migrationSql = (dialect: "d1" | "postgres") =>
  coreMigrationNames(dialect)
    .map((name) =>
      readFileSync(`workers/core/migrations/${dialect}/${name}`, "utf8"),
    )
    .join("\n");
const d1 = migrationSql("d1");
const postgres = migrationSql("postgres");
const tables = (sql: string) =>
  [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+"?([a-zA-Z_]+)"?/gu)]
    .map((match) => match[1])
    .sort();
const left = tables(d1);
const right = tables(postgres);
if (JSON.stringify(left) !== JSON.stringify(right))
  throw new Error(
    `Schema parity failed. D1=${left.join(",")} PG=${right.join(",")}`,
  );
const d1Migrations = coreMigrationNames("d1");
const postgresMigrations = coreMigrationNames("postgres");
if (JSON.stringify(d1Migrations) !== JSON.stringify(postgresMigrations))
  throw new Error(
    `Core migration parity failed. D1=${d1Migrations.join(",")} PG=${postgresMigrations.join(",")}`,
  );
for (const dialect of ["d1", "postgres"] as const) {
  const permissionMigration = readFileSync(
    `workers/core/migrations/${dialect}/0002_granular_permissions.sql`,
    "utf8",
  );
  for (const key of [
    "core.user.create",
    "core.user.update",
    "core.user.delete",
    "core.group.create",
    "core.group.update",
    "core.group.delete",
    "core.plugin.create",
    "core.plugin.update",
    "core.plugin.delete",
    "core.webhook.create",
    "core.webhook.update",
    "core.webhook.delete",
  ]) {
    if (!permissionMigration.includes(key))
      throw new Error(`${dialect} permission migration is missing ${key}`);
  }
}
for (const dialect of ["d1", "postgres"]) {
  const crm = readFileSync(
    `workers/plugin-crm/migrations/${dialect}/0001_init.sql`,
    "utf8",
  );
  if (!crm.includes("crm_leads"))
    throw new Error(`CRM migration is missing for ${dialect}`);
  const metaAds = readFileSync(
    `workers/plugin-meta_ads/migrations/${dialect}/0001_init.sql`,
    "utf8",
  );
  if (!metaAds.includes("meta_ads_accounts"))
    throw new Error(`Meta Ads migration is missing for ${dialect}`);
}
process.stdout.write(
  `D1/PostgreSQL matrix: ${left.length} equivalent tables, ${d1Migrations.length} paired Core migrations, and paired CRM/Meta Ads migrations.\n`,
);
