import { createMongoAbility } from "@casl/ability";
import { parsePermission } from "@app/core-contract";
import type { DatabasePort } from "@app/database";
import type { RequestPrincipal } from "@app/core-contract";
import type { AppAbility } from "../env.js";

type PermissionRow = { key: string | null; isAdmin: number | boolean };

export async function buildAbility(
  db: DatabasePort,
  principal: RequestPrincipal,
): Promise<AppAbility> {
  const rows = await db.query<PermissionRow>(
    `SELECT p.key AS key, g.is_admin AS "isAdmin"
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       LEFT JOIN group_permissions gp ON gp.group_id = g.id
       LEFT JOIN permissions p ON p.id = gp.permission_id
      WHERE gm.user_id = ?`,
    [principal.userId],
  );
  const isAdministrator = rows.some((row) => Boolean(row.isAdmin));
  const assigned = new Set(rows.flatMap((row) => (row.key ? [row.key] : [])));

  if (principal.authMethod !== "api_key" && isAdministrator) {
    return createMongoAbility<[string, string]>([
      { action: "manage", subject: "all" },
    ]);
  }

  const permitted =
    principal.authMethod === "api_key"
      ? (principal.credentialScopes ?? []).filter(
          (key) => isAdministrator || assigned.has(key),
        )
      : [...assigned];
  return createMongoAbility<[string, string]>(
    permitted.map((key) => parsePermission(key)),
  );
}

export async function concretePermissionsForNamespace(
  db: DatabasePort,
  ability: AppAbility,
  namespace: string,
): Promise<string[]> {
  const capabilities = await db.query<{ key: string }>(
    "SELECT key FROM permissions WHERE key LIKE ? ORDER BY key ASC",
    [`${namespace}.%`],
  );
  return capabilities
    .map(({ key }) => ({ key, ...parsePermission(key) }))
    .filter(({ action, subject }) => ability.can(action, subject))
    .map(({ key }) => key);
}

export function canPermission(ability: AppAbility, key: string): boolean {
  const { action, subject } = parsePermission(key);
  return ability.can(action, subject);
}
