import type { DatabasePort } from "@app/database";
import type { InstallerRelease } from "@app/installer-release-schema";
import type { VerifiedCoreArchive } from "./release.js";
import { dbTime } from "../lib/values.js";

const controls = [
  `CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nexus_release_migrations(
    name TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
];

export async function applyCoreUpdateMigrations(
  db: DatabasePort,
  release: InstallerRelease,
  archive: VerifiedCoreArchive,
): Promise<void> {
  if (db.provider !== "d1") throw new Error("CORE_UPDATE_PROVIDER_UNSUPPORTED");
  for (const sql of controls) await db.execute(sql);
  const rows = await db.query<{ name: string; sha256: string | null }>(
    `SELECT d.name, h.sha256
       FROM d1_migrations d
       LEFT JOIN nexus_release_migrations h ON h.name = d.name
       ORDER BY d.id`,
  );
  const applied = new Map(rows.map((row) => [row.name, row.sha256]));

  for (const [ordinal, descriptor] of release.d1Migrations.entries()) {
    const artifact = archive.migration(descriptor);
    const migrationName = `${artifact.id}.sql`;
    if (applied.has(migrationName)) {
      const priorHash = applied.get(migrationName);
      if (priorHash && priorHash !== artifact.sourceSha256)
        throw new Error(`CORE_UPDATE_MIGRATION_HASH_MISMATCH:${migrationName}`);
      if (!priorHash)
        await db.execute(
          `INSERT INTO nexus_release_migrations(name, ordinal, sha256)
           VALUES (?, ?, ?)`,
          [migrationName, ordinal + 1, artifact.sourceSha256],
        );
      continue;
    }
    await db.atomic([
      ...artifact.statements.map((sql) => ({ sql })),
      {
        sql: "INSERT INTO d1_migrations(name) VALUES (?)",
        params: [migrationName],
      },
      {
        sql: `INSERT INTO nexus_release_migrations(name, ordinal, sha256)
              VALUES (?, ?, ?)`,
        params: [migrationName, ordinal + 1, artifact.sourceSha256],
      },
    ]);
  }

  if (release.databaseSchemaVersion)
    await db.execute(
      `UPDATE app_settings SET schema_version = ? WHERE id = 'system' AND database_provider = 'd1'`,
      [release.databaseSchemaVersion],
    );
  await db.execute(`DELETE FROM api_reauth_tokens WHERE expires_at < ?`, [
    dbTime(db),
  ]);
}
