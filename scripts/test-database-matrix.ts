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
const pluginMigrationNames = (plugin: string, dialect: "d1" | "postgres") =>
  readdirSync(`plugins/${plugin}/migrations/${dialect}`)
    .filter((name) => name.endsWith(".sql"))
    .sort();
const pluginMigrationSql = (plugin: string, dialect: "d1" | "postgres") =>
  pluginMigrationNames(plugin, dialect)
    .map((name) =>
      readFileSync(`plugins/${plugin}/migrations/${dialect}/${name}`, "utf8"),
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
    `plugins/crm/migrations/${dialect}/0001_init.sql`,
    "utf8",
  );
  if (!crm.includes("crm_leads"))
    throw new Error(`CRM migration is missing for ${dialect}`);
  const metaAds = readFileSync(
    `plugins/meta_ads/migrations/${dialect}/0001_init.sql`,
    "utf8",
  );
  if (!metaAds.includes("meta_ads_accounts"))
    throw new Error(`Meta Ads migration is missing for ${dialect}`);
  const soletrando = pluginMigrationSql("soletrando", dialect);
  for (const table of [
    "soletrando_children",
    "soletrando_sessions",
    "soletrando_attempts",
    "soletrando_settings",
  ])
    if (!soletrando.includes(table))
      throw new Error(
        `Soletrando migration is missing ${table} for ${dialect}`,
      );
  const meetingRecorder = readFileSync(
    `plugins/meeting_recorder/migrations/${dialect}/0001_init.sql`,
    "utf8",
  );
  for (const table of [
    "meeting_recorder_recordings",
    "meeting_recorder_segments",
    "meeting_recorder_settings",
    "meeting_recorder_deletion_tombstones",
    "meeting_recorder_ingest_events",
  ])
    if (!meetingRecorder.includes(table))
      throw new Error(
        `Meeting Recorder migration is missing ${table} for ${dialect}`,
      );
}
for (const plugin of ["crm", "meta_ads", "soletrando"]) {
  const d1PluginMigrations = pluginMigrationNames(plugin, "d1");
  const postgresPluginMigrations = pluginMigrationNames(plugin, "postgres");
  if (
    JSON.stringify(d1PluginMigrations) !==
    JSON.stringify(postgresPluginMigrations)
  )
    throw new Error(
      `${plugin} migration parity failed. D1=${d1PluginMigrations.join(",")} PG=${postgresPluginMigrations.join(",")}`,
    );
}
process.stdout.write(
  `D1/PostgreSQL matrix: ${left.length} equivalent tables, ${d1Migrations.length} paired Core migrations, and paired CRM/Meta Ads/Soletrando/Meeting Recorder migrations.\n`,
);
