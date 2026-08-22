import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const frontendSource = resolve(repositoryRoot, "frontend/src");

const legacyUsageCeiling = new Map<string, number>([
  ["frontend/src/features/users/UsersPage.tsx", 1],
]);

const rawTableCeiling = new Map<string, number>([
  ["frontend/src/components/ui/configurable-data-table.tsx", 1],
  ["frontend/src/components/ui/data-table.tsx", 1],
  ["frontend/src/features/users/UsersPage.tsx", 1],
]);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  });

describe("repository data-table standard", () => {
  it("rejects new uses of the legacy DataTable component", () => {
    const violations = sourceFiles(frontendSource).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const usageCount = source.match(/<DataTable(?:\s|>)/gu)?.length ?? 0;
      if (!usageCount) return [];
      const repositoryPath = relative(repositoryRoot, path).replaceAll(
        "\\",
        "/",
      );
      const allowedCount = legacyUsageCeiling.get(repositoryPath) ?? 0;
      return usageCount > allowedCount
        ? [
            `${repositoryPath}: ${usageCount} legacy uses (maximum ${allowedCount})`,
          ]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it("rejects new raw table implementations outside the canonical component", () => {
    const violations = sourceFiles(frontendSource).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const usageCount = source.match(/<table(?:\s|>)/gu)?.length ?? 0;
      if (!usageCount) return [];
      const repositoryPath = relative(repositoryRoot, path).replaceAll(
        "\\",
        "/",
      );
      const allowedCount = rawTableCeiling.get(repositoryPath) ?? 0;
      return usageCount > allowedCount
        ? [
            `${repositoryPath}: ${usageCount} raw tables (maximum ${allowedCount})`,
          ]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it("keeps the canonical live-resize and per-user preference integration", () => {
    const source = readFileSync(
      resolve(
        repositoryRoot,
        "frontend/src/components/ui/configurable-data-table.tsx",
      ),
      "utf8",
    );

    expect(source).toContain('columnResizeMode: "onChange"');
    expect(source).toContain("<colgroup>");
    expect(source).toContain("/api/v1/me/table-preferences/");
    expect(source).toContain('aria-label={t("table.columns")}');
    expect(source).toContain('t("common.actions")');
  });

  it("requires plugin tables to use the plugin preference namespace", () => {
    const pluginSource = resolve(frontendSource, "plugins");
    const violations = sourceFiles(pluginSource).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const tableCount =
        source.match(/<ConfigurableDataTable(?:\s|>)/gu)?.length ?? 0;
      if (!tableCount) return [];
      const pluginId = relative(pluginSource, path).split(/[\\/]/u)[0];
      const expectedPrefix = `tableId="plugin.${pluginId}.`;
      const namespacedIdCount = source.split(expectedPrefix).length - 1;
      const manifestPath = resolve(
        repositoryRoot,
        `workers/plugin-${pluginId}/manifest.json`,
      );
      let manifestId = "";
      try {
        manifestId = String(
          (JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown })
            .id ?? "",
        );
      } catch {
        return [`${relative(repositoryRoot, path)}: missing plugin manifest`];
      }
      if (manifestId !== pluginId)
        return [
          `${relative(repositoryRoot, path)}: UI namespace ${pluginId} does not match manifest ID ${manifestId}`,
        ];
      return namespacedIdCount === tableCount
        ? []
        : [
            `${relative(repositoryRoot, path)}: ${tableCount} plugin tables but ${namespacedIdCount} IDs starting with ${expectedPrefix}`,
          ];
    });

    expect(violations).toEqual([]);
  });

  it("keeps the groups list on the configurable table standard", () => {
    const source = readFileSync(
      resolve(repositoryRoot, "frontend/src/features/groups/GroupsPage.tsx"),
      "utf8",
    );

    expect(source).toContain("<ConfigurableDataTable");
    expect(source).toContain('tableId="core.groups"');
    for (const key of ["name", "members", "permissions", "type"]) {
      const columnStart = source.indexOf(`key: "${key}"`);
      const nextColumn = source.indexOf("key:", columnStart + 1);
      const column = source.slice(
        columnStart,
        nextColumn === -1 ? undefined : nextColumn,
      );
      expect(columnStart).toBeGreaterThan(-1);
      expect(column).toContain("sortValue:");
      expect(column).toContain("size:");
      expect(column).toContain("minSize:");
      expect(column).toContain("maxSize:");
    }
  });

  it("keeps Installer operation history out of the Plugins page", () => {
    const source = readFileSync(
      resolve(repositoryRoot, "frontend/src/features/plugins/PluginsPage.tsx"),
      "utf8",
    );

    expect(source).not.toContain('tableId="core.plugin-operations"');
    expect(source).not.toContain('queryKey: ["plugin-operations"]');
    expect(source).not.toContain("plugins.recentOperations");
  });
});
