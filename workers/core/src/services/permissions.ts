import { permissionNamespace } from "@app/core-contract";
import type { DatabasePort } from "@app/database";

export type PermissionRow = { id: string; key: string };

export const isPermissionAvailable = (
  key: string,
  installedPluginIds: ReadonlySet<string>,
): boolean => {
  const namespace = permissionNamespace(key);
  return namespace === "core" || installedPluginIds.has(namespace);
};

export async function availablePermissionRows(
  db: DatabasePort,
  keys?: string[],
): Promise<PermissionRow[]> {
  const uniqueKeys = keys ? [...new Set(keys)] : undefined;
  if (uniqueKeys?.length === 0) return [];
  const keyFilter = uniqueKeys
    ? `p.key IN (${uniqueKeys.map(() => "?").join(",")}) AND `
    : "";
  return db.query<PermissionRow>(
    `SELECT p.id, p.key
       FROM permissions p
      WHERE ${keyFilter}(
        p.key LIKE 'core.%'
        OR EXISTS (
          SELECT 1 FROM plugins installed
           WHERE installed.status = 'installed'
             AND p.key LIKE installed.id || '.%'
        )
      )
      ORDER BY p.key`,
    uniqueKeys ?? [],
  );
}
