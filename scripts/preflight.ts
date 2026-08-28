import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "workers/core/wrangler.jsonc",
  "workers/core/migrations/d1/0001_init.sql",
  "workers/core/migrations/d1/0002_granular_permissions.sql",
  "workers/core/migrations/d1/0003_user_profiles_and_schedules.sql",
  "workers/core/migrations/d1/0004_user_table_preferences.sql",
  "workers/core/migrations/d1/0005_plugin_package_exports.sql",
  "workers/core/migrations/d1/0006_user_overview_preferences.sql",
  "workers/core/migrations/d1/0008_plugin_runtime_resources.sql",
  "workers/core/migrations/postgres/0001_init.sql",
  "workers/core/migrations/postgres/0002_granular_permissions.sql",
  "workers/core/migrations/postgres/0003_user_profiles_and_schedules.sql",
  "workers/core/migrations/postgres/0004_user_table_preferences.sql",
  "workers/core/migrations/postgres/0005_plugin_package_exports.sql",
  "workers/core/migrations/postgres/0006_user_overview_preferences.sql",
  "workers/core/migrations/postgres/0008_plugin_runtime_resources.sql",
  "plugins/crm/manifest.json",
  "plugins/crm/catalog.json",
  "plugins/crm/migrations/d1/0001_init.sql",
  "plugins/crm/migrations/postgres/0001_init.sql",
  "plugins/meta_ads/manifest.json",
  "plugins/meta_ads/catalog.json",
  "plugins/meta_ads/migrations/d1/0001_init.sql",
  "plugins/meta_ads/migrations/postgres/0001_init.sql",
  "plugins/meeting_recorder/manifest.json",
  "plugins/meeting_recorder/catalog.json",
  "plugins/meeting_recorder/migrations/d1/0001_init.sql",
  "plugins/meeting_recorder/migrations/postgres/0001_init.sql",
  "frontend/src/main.tsx",
  "AGENTS.md",
  "DEPLOYMENT.md",
];
const missing = requiredFiles.filter((file) => !existsSync(file));
if (missing.length)
  throw new Error(`Required files are missing: ${missing.join(", ")}`);
const config = readFileSync("workers/core/wrangler.jsonc", "utf8");
for (const placeholder of [
  "replace-with-d1-database-id",
  "set-by-provision-command",
  "http://localhost:5173",
]) {
  if (config.includes(placeholder))
    process.stderr.write(
      `WARNING: replace ${placeholder} before a production deployment.\n`,
    );
}
for (const secret of [
  "BETTER_AUTH_SECRET",
  "WEBHOOK_ENCRYPTION_KEY",
  "CF_API_TOKEN",
  "CF_ACCOUNT_ID",
]) {
  if (!process.env[secret])
    process.stderr.write(
      `WARNING: provide ${secret} with wrangler secret put.\n`,
    );
}
process.stdout.write("Structural preflight completed.\n");
