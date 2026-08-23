import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  archivePackageStatements,
  assertNoRuntimeValues,
  restorePortablePackage,
  type PackageChunkRow,
} from "../workers/core/src/installer/package-archive.js";
import type { PluginManifest } from "../workers/core/src/installer/manifest.js";

const packageParts = () => ({
  manifest: JSON.parse(
    readFileSync("plugins/crm/manifest.json", "utf8"),
  ) as PluginManifest,
  worker: `export default {};\n${"x".repeat(130_000)}`,
  d1Migrations: {
    "0001_init": readFileSync(
      "plugins/crm/migrations/d1/0001_init.sql",
      "utf8",
    ),
  },
  postgresMigrations: {
    "0001_init": readFileSync(
      "plugins/crm/migrations/postgres/0001_init.sql",
      "utf8",
    ),
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
