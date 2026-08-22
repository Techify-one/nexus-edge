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
  const filter = uniqueKeys
    ? ` WHERE key IN (${uniqueKeys.map(() => "?").join(",")})`
    : "";
  const [permissions, plugins] = await Promise.all([
    db.query<PermissionRow>(
      `SELECT id, key FROM permissions${filter} ORDER BY key`,
      uniqueKeys ?? [],
    ),
    db.query<{ id: string }>(
      "SELECT id FROM plugins WHERE status = 'installed' ORDER BY id",
    ),
  ]);
  const installedPluginIds = new Set(plugins.map(({ id }) => id));
  return permissions.filter(({ key }) =>
    isPermissionAvailable(key, installedPluginIds),
  );
}
