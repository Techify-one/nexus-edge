import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Client } from "pg";

const provider = process.argv[2];
if (provider !== "d1" && provider !== "postgres")
  throw new Error("Use: pnpm provision:d1 or pnpm provision:postgres");
const installationId =
  process.env.APP_INSTALLATION_ID ||
  `install_${randomUUID().replaceAll("-", "")}`;

if (provider === "d1") {
  const config = "workers/core/wrangler.jsonc";
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "app-db",
      "--remote",
      "--config",
      config,
    ],
    { stdio: "inherit" },
  );
  const sql = `INSERT OR IGNORE INTO app_settings(id,installation_id,database_provider,schema_version,bootstrap_state) VALUES ('system','${installationId}','d1',1,'open')`;
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "app-db",
      "--remote",
      "--config",
      config,
      "--command",
      sql,
    ],
    { stdio: "inherit" },
  );
} else {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("DATABASE_URL is required to provision PostgreSQL.");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const migrationsDirectory = "workers/core/migrations/postgres";
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const migration of migrations)
      await client.query(
        readFileSync(`${migrationsDirectory}/${migration}`, "utf8"),
      );
    await client.query(
      "INSERT INTO app_settings(id,installation_id,database_provider,schema_version,bootstrap_state) VALUES ('system',$1,'postgres',1,'open') ON CONFLICT (id) DO NOTHING",
      [installationId],
    );
  } finally {
    await client.end();
  }
}

process.stdout.write(
  `\nProvisioning completed. Set APP_INSTALLATION_ID=${installationId} in the Core Wrangler configuration.\n`,
);
