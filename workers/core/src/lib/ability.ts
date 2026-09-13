import { createMongoAbility } from "@casl/ability";
import { parsePermission } from "@app/core-contract";
import type { DatabasePort } from "@app/database";
import type { RequestPrincipal } from "@app/core-contract";
import type { AppAbility } from "../env.js";

type AccessRow = {
  id: string;
  name: string;
  email: string;
  active: number | boolean;
  key: string | null;
  isAdmin: number | boolean;
};

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  active: number | boolean;
};

export type PrincipalAccess = {
  user: CurrentUser;
  ability: AppAbility;
};

export async function loadPrincipalAccess(
  db: DatabasePort,
  principal: RequestPrincipal,
): Promise<PrincipalAccess | null> {
  const rows = await db.query<AccessRow>(
    `SELECT u.id, u.name, u.email, u.active, p.key AS key,
            COALESCE(g.is_admin, ?) AS "isAdmin"
       FROM "user" u
       LEFT JOIN group_members gm ON gm.user_id = u.id
       LEFT JOIN groups g ON g.id = gm.group_id
       LEFT JOIN group_permissions gp ON gp.group_id = g.id
       LEFT JOIN permissions p ON p.id = gp.permission_id
      WHERE u.id = ?`,
    [false, principal.userId],
  );
  const first = rows[0];
  if (!first) return null;
  const isAdministrator = rows.some((row) => Boolean(row.isAdmin));
  const assigned = new Set(rows.flatMap((row) => (row.key ? [row.key] : [])));

  if (principal.authMethod !== "api_key" && isAdministrator) {
    return {
      user: {
        id: first.id,
        name: first.name,
        email: first.email,
        active: first.active,
      },
      ability: createMongoAbility<[string, string]>([
        { action: "manage", subject: "all" },
      ]),
    };
  }

  const permitted =
    principal.authMethod === "api_key"
      ? (principal.credentialScopes ?? []).filter(
          (key) => isAdministrator || assigned.has(key),
        )
      : [...assigned];
  return {
    user: {
      id: first.id,
      name: first.name,
      email: first.email,
      active: first.active,
    },
    ability: createMongoAbility<[string, string]>(
      permitted.map((key) => parsePermission(key)),
    ),
  };
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
