import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
describe("plugin extraction", () => {
  it("keeps only the format-2 author template in the Core repository", () => {
    const root = resolve(repositoryRoot, "plugins", "template");
    const manifest = JSON.parse(
      readFileSync(resolve(root, "manifest.json"), "utf8"),
    ) as { id?: string; packageFormat?: number };

    expect(manifest.id).toBe("template");
    expect(manifest.packageFormat).toBe(2);
    for (const path of [
      "frontend",
      "src",
      "migrations/d1",
      "migrations/postgres",
      "package.json",
      "tsconfig.json",
      "wrangler.jsonc",
    ]) {
      expect(existsSync(resolve(root, path)), `template/${path}`).toBe(true);
    }
    for (const id of ["crm", "meta_ads", "soletrando", "meeting_recorder"])
      expect(existsSync(resolve(repositoryRoot, "plugins", id))).toBe(false);
  });

  it("keeps plugin-specific directories out of Core locations", () => {
    const legacyWorkers = readdirSync(resolve(repositoryRoot, "workers"), {
      withFileTypes: true,
    })
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("plugin-"),
      )
      .map((entry) => entry.name);
    const fragmentedFrontend = readdirSync(
      resolve(repositoryRoot, "frontend/src/plugins"),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(legacyWorkers).toEqual([]);
    expect(fragmentedFrontend).toEqual([]);
  });
});
