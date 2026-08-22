import type { DatabasePort, SqlStatement, SqlValue } from "@app/database";
import { sha256, stableJson } from "@app/webhook-contract";
import { strToU8, zipSync } from "fflate";
import { pluginManifestSchema, type PluginManifest } from "./manifest.js";
import { migrationStatements, type MigrationSet } from "./migrations.js";

const CHUNK_CHARACTERS = 60_000;
const migrationPath = /^migrations\/(d1|postgres)\/(\d{4}_[a-z0-9_]+)\.sql$/u;

export type PortablePackage = {
  manifest: PluginManifest;
  worker: string;
  d1Migrations: MigrationSet;
  postgresMigrations: MigrationSet;
};

export type PackageHashes = {
  manifest: string;
  worker: string;
  d1: string;
  postgres: string;
};

export type PackageChunkRow = {
  path: string;
  chunkIndex: number;
  content: string;
};

export const assertNoRuntimeValues = (
  parts: PortablePackage,
  runtimeValues: Array<string | undefined>,
): void => {
  const packageText = [
    stableJson(parts.manifest),
    parts.worker,
    stableJson(parts.d1Migrations),
    stableJson(parts.postgresMigrations),
  ].join("\n");
  if (
    runtimeValues.some(
      (value) =>
        typeof value === "string" &&
        value.length >= 8 &&
        packageText.includes(value),
    )
  )
    throw new Error(
      "The plugin package contains an installation-specific runtime value.",
    );
};

const packageFiles = (parts: PortablePackage): Record<string, string> => ({
  "manifest.json": `${JSON.stringify(parts.manifest, null, 2)}\n`,
  "worker.mjs": parts.worker,
  ...Object.fromEntries(
    Object.entries(parts.d1Migrations).map(([id, sql]) => [
      `migrations/d1/${id}.sql`,
      sql,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(parts.postgresMigrations).map(([id, sql]) => [
      `migrations/postgres/${id}.sql`,
      sql,
    ]),
  ),
});

export const archivePackageStatements = (
  operationId: string,
  parts: PortablePackage,
  createdAt: SqlValue,
): SqlStatement[] => {
  const statements: SqlStatement[] = [
    {
      sql: "DELETE FROM plugin_package_chunks WHERE operation_id = ?",
      params: [operationId],
    },
  ];
  for (const [path, content] of Object.entries(packageFiles(parts)).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const chunks = Math.max(1, Math.ceil(content.length / CHUNK_CHARACTERS));
    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1)
      statements.push({
        sql: `INSERT INTO plugin_package_chunks(operation_id, path, chunk_index, content, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        params: [
          operationId,
          path,
          chunkIndex,
          content.slice(
            chunkIndex * CHUNK_CHARACTERS,
            (chunkIndex + 1) * CHUNK_CHARACTERS,
          ),
          createdAt,
        ],
      });
  }
  return statements;
};

const restoreFiles = (rows: PackageChunkRow[]): Record<string, string> => {
  const chunksByPath = new Map<string, PackageChunkRow[]>();
  for (const row of rows) {
    if (
      row.path !== "manifest.json" &&
      row.path !== "worker.mjs" &&
      !migrationPath.test(row.path)
    )
      throw new Error("The stored plugin package contains an invalid path.");
    if (!Number.isSafeInteger(row.chunkIndex) || row.chunkIndex < 0)
      throw new Error("The stored plugin package contains an invalid chunk.");
    const chunks = chunksByPath.get(row.path) ?? [];
    chunks.push(row);
    chunksByPath.set(row.path, chunks);
  }
  return Object.fromEntries(
    [...chunksByPath.entries()].map(([path, chunks]) => {
      chunks.sort((left, right) => left.chunkIndex - right.chunkIndex);
      if (chunks.some((chunk, index) => chunk.chunkIndex !== index))
        throw new Error("The stored plugin package has missing chunks.");
      return [path, chunks.map(({ content }) => content).join("")];
    }),
  );
};

export const restorePortablePackage = (
  rows: PackageChunkRow[],
): PortablePackage => {
  const files = restoreFiles(rows);
  if (!files["manifest.json"] || !files["worker.mjs"])
    throw new Error("The stored plugin package is incomplete.");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(files["manifest.json"]);
  } catch {
    throw new Error("The stored plugin manifest is invalid.");
  }
  const manifest = pluginManifestSchema.safeParse(manifestValue);
  if (!manifest.success)
    throw new Error("The stored plugin manifest is invalid.");
  const migrations = (dialect: "d1" | "postgres"): MigrationSet =>
    Object.fromEntries(
      Object.entries(files)
        .map(([path, content]) => {
          const match = migrationPath.exec(path);
          return match?.[1] === dialect ? [match[2]!, content] : null;
        })
        .filter((entry): entry is [string, string] => Boolean(entry))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  const d1Migrations = migrations("d1");
  const postgresMigrations = migrations("postgres");
  if (
    stableJson(Object.keys(d1Migrations)) !==
    stableJson(Object.keys(postgresMigrations))
  )
    throw new Error("The stored plugin migrations are incomplete.");
  migrationStatements(d1Migrations, manifest.data.tablePrefix);
  migrationStatements(postgresMigrations, manifest.data.tablePrefix);
  return {
    manifest: manifest.data,
    worker: files["worker.mjs"],
    d1Migrations,
    postgresMigrations,
  };
};

export const verifyPortablePackage = async (
  parts: PortablePackage,
  expected: PackageHashes & { pluginId: string; version: string },
): Promise<void> => {
  const actual = {
    manifest: await sha256(stableJson(parts.manifest)),
    worker: await sha256(parts.worker),
    d1: await sha256(stableJson(parts.d1Migrations)),
    postgres: await sha256(stableJson(parts.postgresMigrations)),
  };
  if (
    parts.manifest.id !== expected.pluginId ||
    parts.manifest.version !== expected.version ||
    actual.manifest !== expected.manifest ||
    actual.worker !== expected.worker ||
    actual.d1 !== expected.d1 ||
    actual.postgres !== expected.postgres
  )
    throw new Error("The stored plugin package failed integrity verification.");
};

export const portablePackageZip = (parts: PortablePackage): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(packageFiles(parts)).map(([path, content]) => [
        path,
        strToU8(content),
      ]),
    ),
    { level: 9 },
  );

export async function loadPortablePackage(
  db: DatabasePort,
  operationId: string,
): Promise<PortablePackage> {
  return restorePortablePackage(
    await db.query<PackageChunkRow>(
      `SELECT path, chunk_index AS "chunkIndex", content
         FROM plugin_package_chunks
        WHERE operation_id = ?
        ORDER BY path, chunk_index`,
      [operationId],
    ),
  );
}
