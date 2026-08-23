import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const shippedPlugins = ["crm", "meta_ads"];

describe("plugin colocation", () => {
  it.each(shippedPlugins)("keeps every %s concern in one directory", (id) => {
    const root = resolve(repositoryRoot, "plugins", id);
    const manifest = JSON.parse(
      readFileSync(resolve(root, "manifest.json"), "utf8"),
    ) as { id?: string };

    expect(manifest.id).toBe(id);
    for (const path of [
      "frontend",
      "frontend/i18n.ts",
      "frontend/registry.ts",
      "src",
      "migrations/d1",
      "migrations/postgres",
      "package.json",
      "tsconfig.json",
      "wrangler.jsonc",
      `release/${id}.plugin.zip`,
    ]) {
      expect(existsSync(resolve(root, path)), `${id}/${path}`).toBe(true);
    }
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
