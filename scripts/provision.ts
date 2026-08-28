import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { SCHEMA_VERSION } from "../packages/db-schema/src/common/index.js";
import { Client } from "pg";

const provider = process.argv[2];
if (provider !== "d1" && provider !== "postgres")
  throw new Error("Use: pnpm provision:d1 or pnpm provision:postgres");
const installationId =
  process.env.APP_INSTALLATION_ID ||
  `install_${randomUUID().replaceAll("-", "")}`;
if (!/^install_[A-Za-z0-9_-]{20,80}$/u.test(installationId))
  throw new Error("APP_INSTALLATION_ID is invalid.");

if (provider === "d1") {
  const config =
    process.env.CORE_WRANGLER_CONFIG ?? "workers/core/wrangler.jsonc";
  const databaseName = process.env.CORE_D1_DATABASE_NAME ?? "nexus-edge-db";
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      databaseName,
      "--remote",
      "--config",
      config,
    ],
    { stdio: "inherit" },
  );
  const sql = `INSERT INTO app_settings(id,installation_id,database_provider,schema_version,bootstrap_state)
    VALUES ('system','${installationId}','d1',${SCHEMA_VERSION},'open')
    ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version
      WHERE app_settings.installation_id = excluded.installation_id
        AND app_settings.database_provider = excluded.database_provider`;
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      databaseName,
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
      `INSERT INTO app_settings(id,installation_id,database_provider,schema_version,bootstrap_state)
       VALUES ('system',$1,'postgres',$2,'open')
       ON CONFLICT (id) DO UPDATE SET schema_version = excluded.schema_version
         WHERE app_settings.installation_id = excluded.installation_id
           AND app_settings.database_provider = excluded.database_provider`,
      [installationId, SCHEMA_VERSION],
    );
  } finally {
    await client.end();
  }
}

process.stdout.write(
  `\nProvisioning completed. Set APP_INSTALLATION_ID=${installationId} in the Core Wrangler configuration.\n`,
);
