import { describe, expect, it } from "vitest";
import {
  archivePackageStatements,
  assertNoRuntimeValues,
  restorePortablePackage,
  type PackageChunkRow,
} from "../workers/core/src/installer/package-archive.js";
import type { PluginManifest } from "../workers/core/src/installer/manifest.js";

const packageParts = () => ({
  manifest: {
    id: "archive_fixture",
    name: "Archive fixture",
    version: "1.0.0",
    apiVersion: 1,
    coreMinVersion: "1.0.0",
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    databaseDialects: ["d1", "postgres"],
    tablePrefix: "archive_fixture_",
    permissions: [],
    menu: [],
  } as PluginManifest,
  worker: `export default {};\n${"x".repeat(3_100_000)}`,
  d1Migrations: {
    "0001_init":
      "CREATE TABLE IF NOT EXISTS archive_fixture_items (id TEXT PRIMARY KEY);",
  },
  postgresMigrations: {
    "0001_init":
      "CREATE TABLE IF NOT EXISTS archive_fixture_items (id TEXT PRIMARY KEY);",
  },
});

const chunkRows = (): PackageChunkRow[] =>
  archivePackageStatements("pop_archive", packageParts(), 1)
    .slice(1)
    .map((statement) => ({
      path: String(statement.params?.[1]),
      chunkIndex: Number(statement.params?.[2]),
      content: String(statement.params?.[3]),
    }));

describe("portable plugin package archive", () => {
  it("restores multi-chunk package files exactly", () => {
    const original = packageParts();
    const restored = restorePortablePackage(chunkRows().toReversed());

    expect(restored).toEqual(original);
  });

  it("rejects missing chunks instead of creating a partial ZIP", () => {
    const rows = chunkRows();
    const withoutMiddleWorkerChunk = rows.filter(
      (row) => !(row.path === "worker.mjs" && row.chunkIndex === 1),
    );

    expect(() => restorePortablePackage(withoutMiddleWorkerChunk)).toThrow(
      "missing chunks",
    );
  });

  it("rejects installation-specific credentials before archiving", () => {
    const parts = packageParts();
    parts.worker += '\nconst token = "credential-sentinel";';

    expect(() =>
      assertNoRuntimeValues(parts, [undefined, "credential-sentinel"]),
    ).toThrow("installation-specific runtime value");
  });
});
