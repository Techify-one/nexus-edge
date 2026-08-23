import { Hono, type Context } from "hono";
import { packRules } from "@casl/ability/extra";
import {
  apiKeyCreateSchema,
  groupCreateSchema,
  invitationCreateSchema,
  listQuerySchema,
  overviewPreferenceConfigSchema,
  tablePreferenceConfigSchema,
  tablePreferenceIdSchema,
  userCreateSchema,
  userUpdateSchema,
} from "@app/api-contracts";
import { createId, parsePermission } from "@app/core-contract";
import type { HonoEnv } from "../env.js";
import { canPermission } from "../lib/ability.js";
import { randomToken, hashToken } from "../lib/crypto.js";
import { AppError, noStore, parseBody } from "../lib/http.js";
import { countProfileOptions, dbTime, parseJson } from "../lib/values.js";
import { requirePermission } from "../middleware/auth.js";
import {
  requireRecentReauth,
  validateRecentReauth,
} from "../middleware/reauth.js";
import { audit } from "../services/audit.js";
import { commitWithEvent } from "../services/events.js";
import { idempotencyLookup, saveIdempotency } from "../services/idempotency.js";
import { availablePermissionRows } from "../services/permissions.js";

const permissionRecord = (keys: string[]): Record<string, string[]> => {
  const result: Record<string, string[]> = {};
  for (const key of keys) {
    const { action, subject } = parsePermission(key);
    result[subject] = [...(result[subject] ?? []), action];
  }
  return result;
};

const requireAvailablePermissionRows = async (
  db: HonoEnv["Variables"]["db"],
  keys: string[],
) => {
  const rows = await availablePermissionRows(db, keys);
  if (rows.length !== new Set(keys).size)
    throw new AppError(
      422,
      "PERMISSION_UNAVAILABLE",
      "One or more permissions are not available.",
    );
  return rows;
};

const insertIgnore = (
  provider: "d1" | "postgres",
  table: string,
  columns: string,
  placeholders: string,
  conflict: string,
): string =>
  provider === "d1"
    ? `INSERT OR IGNORE INTO ${table}(${columns}) VALUES (${placeholders})`
    : `INSERT INTO ${table}(${columns}) VALUES (${placeholders}) ON CONFLICT ${conflict} DO NOTHING`;

type UserAccessState = {
  id: string;
  name: string;
  email: string;
  active: number | boolean;
  isAdmin: number | boolean;
};

const userAccessState = async (
  c: Context<HonoEnv>,
  userId: string,
): Promise<UserAccessState> => {
  const user = await c.get("db").first<UserAccessState>(
    `SELECT u.id, u.name, u.email, u.active,
            MAX(CASE WHEN g.is_admin THEN 1 ELSE 0 END) AS "isAdmin"
       FROM "user" u
       LEFT JOIN group_members gm ON gm.user_id = u.id
       LEFT JOIN groups g ON g.id = gm.group_id
      WHERE u.id = ?
      GROUP BY u.id, u.name, u.email, u.active`,
    [userId],
  );
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
  return user;
};

const validateGroupAssignment = async (
  c: Context<HonoEnv>,
  groupIds: string[],
): Promise<boolean> => {
  const uniqueIds = [...new Set(groupIds)];
  if (!uniqueIds.length) return false;
  const rows = await c.get("db").query<{
    groupId: string;
    isAdmin: number | boolean;
    permissionKey: string | null;
  }>(
    `SELECT g.id AS "groupId", g.is_admin AS "isAdmin", p.key AS "permissionKey"
       FROM groups g
       LEFT JOIN group_permissions gp ON gp.group_id = g.id
       LEFT JOIN permissions p ON p.id = gp.permission_id
      WHERE g.id IN (${uniqueIds.map(() => "?").join(",")})`,
    uniqueIds,
  );
  if (new Set(rows.map((row) => row.groupId)).size !== uniqueIds.length)
    throw new AppError(
      422,
      "GROUP_UNAVAILABLE",
      "One or more selected groups do not exist.",
    );
  const includesAdministrator = rows.some((row) => Boolean(row.isAdmin));
  if (includesAdministrator) {
    const actorIsAdministrator = await c
      .get("db")
      .first<{ isAdmin: number | boolean }>(
        `SELECT MAX(CASE WHEN g.is_admin THEN 1 ELSE 0 END) AS "isAdmin"
           FROM group_members gm JOIN groups g ON g.id = gm.group_id
          WHERE gm.user_id = ?`,
        [c.get("principal").userId],
      );
    if (!Boolean(actorIsAdministrator?.isAdmin))
      throw new AppError(
        403,
        "ADMIN_GROUP_FORBIDDEN",
        "Only an administrator can assign the Administrators group.",
      );
  }
  const unavailable = rows
    .map((row) => row.permissionKey)
    .filter((key): key is string => Boolean(key))
    .some((key) => !canPermission(c.get("ability"), key));
  if (unavailable)
    throw new AppError(
      403,
      "PERMISSION_ESCALATION",
      "You cannot assign a group with permissions beyond your own.",
    );
  return includesAdministrator;
};

const protectLastActiveAdministrator = async (
  c: Context<HonoEnv>,
  current: UserAccessState,
  resultingActive: boolean,
  resultingAdministrator: boolean,
): Promise<void> => {
  if (
    !Boolean(current.active) ||
    !Boolean(current.isAdmin) ||
    (resultingActive && resultingAdministrator)
  )
    return;
  const activeAdmins = await c.get("db").first<{ count: number | string }>(
    `SELECT COUNT(DISTINCT u.id) AS count FROM "user" u
       JOIN group_members gm ON gm.user_id = u.id
       JOIN groups g ON g.id = gm.group_id
       WHERE g.is_admin = ? AND u.active = ?`,
    [true, true],
  );
  if (Number(activeAdmins?.count ?? 0) <= 1)
    throw new AppError(
      409,
      "LAST_ADMIN",
      "The last active administrator must remain active and in the Administrators group.",
    );
};

export const managementRoutes = new Hono<HonoEnv>();

managementRoutes.get("/me", async (c) => {
  const principal = c.get("principal");
  const user = await c.get("db").first<{
    id: string;
    name: string;
    email: string;
    active: number | boolean;
  }>('SELECT id, name, email, active FROM "user" WHERE id = ?', [principal.userId]);
  return c.json(
    {
      user,
      principal: {
        authMethod: principal.authMethod,
        credentialId: principal.credentialId,
      },
    },
    200,
    noStore,
  );
});

managementRoutes.get("/me/ability", (c) =>
  c.json({ rules: packRules(c.get("ability").rules) }, 200, noStore),
);

managementRoutes.get("/me/permissions", async (c) => {
  const items = await availablePermissionRows(c.get("db"));
  return c.json(
    {
      items: items.filter((permission) =>
        canPermission(c.get("ability"), permission.key),
      ),
    },
    200,
    noStore,
  );
});

const preferenceTableId = (value: string): string => {
  const parsed = tablePreferenceIdSchema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      400,
      "INVALID_TABLE_ID",
      "The table identifier is invalid.",
    );
  return parsed.data;
};

managementRoutes.get("/me/table-preferences/:tableId", async (c) => {
  const tableId = preferenceTableId(c.req.param("tableId"));
  const row = await c.get("db").first<{
    configJson: unknown;
    schemaVersion: number | string;
    updatedAt: unknown;
  }>(
    `SELECT config_json AS "configJson", schema_version AS "schemaVersion",
            updated_at AS "updatedAt"
       FROM user_table_preferences
      WHERE user_id = ? AND table_id = ?`,
    [c.get("principal").userId, tableId],
  );
  if (!row)
    return c.json({ tableId, config: null, updatedAt: null }, 200, noStore);
  const config = tablePreferenceConfigSchema.safeParse(
    parseJson<unknown>(row.configJson, null),
  );
  return c.json(
    {
      tableId,
      config: config.success ? config.data : null,
      updatedAt: row.updatedAt,
    },
    200,
    noStore,
  );
});

managementRoutes.put("/me/table-preferences/:tableId", async (c) => {
  const tableId = preferenceTableId(c.req.param("tableId"));
  const config = await parseBody(c, tablePreferenceConfigSchema);
  const updatedAt = dbTime(c.get("db"));
  await c.get("db").execute(
    `INSERT INTO user_table_preferences(user_id, table_id, schema_version, config_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, table_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at`,
    [
      c.get("principal").userId,
      tableId,
      config.version,
      JSON.stringify(config),
      updatedAt,
    ],
  );
  return c.json({ tableId, config, updatedAt }, 200, noStore);
});

managementRoutes.delete("/me/table-preferences/:tableId", async (c) => {
  const tableId = preferenceTableId(c.req.param("tableId"));
  await c
    .get("db")
    .execute(
      "DELETE FROM user_table_preferences WHERE user_id = ? AND table_id = ?",
      [c.get("principal").userId, tableId],
    );
  return c.body(null, 204);
});

managementRoutes.get("/me/overview-preference", async (c) => {
  const row = await c.get("db").first<{
    configJson: unknown;
    updatedAt: unknown;
  }>(
    `SELECT config_json AS "configJson", updated_at AS "updatedAt"
       FROM user_overview_preferences
      WHERE user_id = ?`,
    [c.get("principal").userId],
  );
  if (!row) return c.json({ config: null, updatedAt: null }, 200, noStore);
  const config = overviewPreferenceConfigSchema.safeParse(
    parseJson<unknown>(row.configJson, null),
  );
  return c.json(
    {
      config: config.success ? config.data : null,
      updatedAt: row.updatedAt,
    },
    200,
    noStore,
  );
});

managementRoutes.put("/me/overview-preference", async (c) => {
  const config = await parseBody(c, overviewPreferenceConfigSchema);
  const updatedAt = dbTime(c.get("db"));
  await c.get("db").execute(
    `INSERT INTO user_overview_preferences(user_id, schema_version, config_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at`,
    [
      c.get("principal").userId,
      config.version,
      JSON.stringify(config),
      updatedAt,
    ],
  );
  return c.json({ config, updatedAt }, 200, noStore);
});

managementRoutes.get("/me/plugin-navigation", async (c) => {
  const plugins = await c
    .get("db")
    .query<{ id: string; name: string; manifest: unknown }>(
      `SELECT id, name, manifest_json AS "manifest" FROM plugins WHERE status = 'installed' ORDER BY name`,
    );
  const permissions = await c
    .get("db")
    .query<{ key: string }>("SELECT key FROM permissions ORDER BY key");
  const visiblePlugins = plugins.flatMap((plugin) => {
    const manifest = parseJson<{
      menu?: Array<{ title: string; routeKey: string }>;
    }>(plugin.manifest, {});
    const namespaceAllowed = permissions.some(
      ({ key }) =>
        key.startsWith(`${plugin.id}.`) && canPermission(c.get("ability"), key),
    );
    return namespaceAllowed
      ? [
          {
            pluginId: plugin.id,
            name: plugin.name,
            menu: manifest.menu ?? [],
          },
        ]
      : [];
  });
  const items = visiblePlugins.flatMap((plugin) =>
    plugin.menu.map((entry) => ({ pluginId: plugin.pluginId, ...entry })),
  );
  return c.json({ plugins: visiblePlugins, items }, 200, noStore);
});

managementRoutes.get("/me/api-keys", async (c) => {
  const data = await c.get("auth").api.listApiKeys({
    query: {
      limit: 100,
      offset: 0,
      sortBy: "createdAt",
      sortDirection: "desc",
    },
    headers: c.req.raw.headers,
  });
  return c.json(data, 200, noStore);
});

managementRoutes.post("/me/api-keys", async (c) => {
  const input = await parseBody(c, apiKeyCreateSchema);
  await requireAvailablePermissionRows(c.get("db"), input.scopes);
  const ability = c.get("ability");
  if (input.scopes.some((key) => !canPermission(ability, key)))
    throw new AppError(
      403,
      "API_KEY_SCOPE_FORBIDDEN",
      "The key cannot be granted permissions beyond your own.",
    );
  const count = await c
    .get("db")
    .first<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM apikey WHERE reference_id = ? AND enabled = ? AND (expires_at IS NULL OR expires_at > ?)",
      [c.get("principal").userId, true, dbTime(c.get("db"))],
    );
  if (Number(count?.count ?? 0) >= 10)
    throw new AppError(
      409,
      "API_KEY_LIMIT",
      "You already have 10 active keys.",
    );
  const created = await c.get("auth").api.createApiKey({
    body: {
      userId: c.get("principal").userId,
      name: input.name,
      prefix: "app_",
      expiresIn: input.expiresInDays * 86_400,
      permissions: permissionRecord(input.scopes),
      rateLimitEnabled: true,
      rateLimitTimeWindow: 60_000,
      rateLimitMax: 120,
    },
  });
  await audit(c, "core.api_key.created", "core.api_key", created.id, {
    name: input.name,
    scopes: input.scopes,
  });
  return c.json(created, 201, noStore);
});

managementRoutes.delete("/me/api-keys/:keyId", async (c) => {
  const result = await c.get("auth").api.deleteApiKey({
    body: { keyId: c.req.param("keyId") },
    headers: c.req.raw.headers,
  });
  await audit(c, "core.api_key.revoked", "core.api_key", c.req.param("keyId"));
  return c.json(result, 200, noStore);
});

managementRoutes.get(
  "/users",
  requirePermission("core.user.read"),
  async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    const rows = await c.get("db").query<Record<string, unknown>>(
      `SELECT u.id, u.name, u.email, u.active, u.created_at AS "createdAt",
              p.phone, p.telegram_id AS "telegramId", p.job_title AS "jobTitle",
              p.birth_date AS "birthDate", p.cpf, p.tags_json AS "tagsJson",
              p.sectors_json AS "sectorsJson", p.notes,
              COALESCE(p.status, CASE WHEN u.active THEN 'active' ELSE 'inactive' END) AS status,
              s.daily_hours_json AS "dailyHoursJson", s.entry_times_json AS "entryTimesJson",
              s.effective_at AS "scheduleEffectiveAt"
       FROM "user" u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       LEFT JOIN user_work_schedules s ON s.id = (
         SELECT ws.id FROM user_work_schedules ws WHERE ws.user_id = u.id
          ORDER BY ws.effective_at DESC, ws.created_at DESC LIMIT 1
       )
      WHERE (? IS NULL OR lower(u.name) LIKE lower(?) OR lower(u.email) LIKE lower(?))
      ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
      [
        query.search ?? null,
        query.search ? `%${query.search}%` : null,
        query.search ? `%${query.search}%` : null,
        query.limit,
      ],
    );
    const memberships = await c
      .get("db")
      .query<{ userId: string; groupId: string; groupName: string }>(
        `SELECT gm.user_id AS "userId", g.id AS "groupId", g.name AS "groupName" FROM group_members gm JOIN groups g ON g.id = gm.group_id`,
      );
    return c.json({
      items: rows.map((row) => ({
        ...row,
        tags: parseJson<string[]>(row.tagsJson, []),
        sectors: parseJson<string[]>(row.sectorsJson, []),
        schedule: row.dailyHoursJson
          ? {
              dailyHours: parseJson<string[]>(row.dailyHoursJson, []),
              entryTimes: parseJson<string[]>(row.entryTimesJson, []),
              effectiveAt: row.scheduleEffectiveAt,
            }
          : null,
        tagsJson: undefined,
        sectorsJson: undefined,
        dailyHoursJson: undefined,
        entryTimesJson: undefined,
        scheduleEffectiveAt: undefined,
        groups: memberships
          .filter((membership) => membership.userId === row.id)
          .map((membership) => ({
            id: membership.groupId,
            name: membership.groupName,
          })),
      })),
      nextCursor: null,
    });
  },
);

managementRoutes.get(
  "/users/profile-options",
  requirePermission("core.user.read"),
  async (c) => {
    const rows = await c
      .get("db")
      .query<{ tagsJson: unknown; sectorsJson: unknown }>(
        `SELECT tags_json AS "tagsJson", sectors_json AS "sectorsJson"
           FROM user_profiles`,
      );
    return c.json(
      {
        tags: countProfileOptions(rows.map((row) => row.tagsJson)),
        sectors: countProfileOptions(rows.map((row) => row.sectorsJson)),
      },
      200,
      noStore,
    );
  },
);

managementRoutes.post(
  "/users",
  requirePermission("core.user.create"),
  async (c) => {
    const input = await parseBody(c, userCreateSchema);
    const db = c.get("db");
    await validateGroupAssignment(c, input.groupIds);
    const state = await idempotencyLookup(c, "users.create", input, true);
    if (state?.replay)
      return c.json(state.replay.body as never, state.replay.status as 201);
    const duplicate = await db.first<{ id: string }>(
      'SELECT id FROM "user" WHERE lower(email) = lower(?)',
      [input.email],
    );
    if (duplicate)
      throw new AppError(
        409,
        "EMAIL_ALREADY_EXISTS",
        "Another user already uses this email address.",
      );

    const created = await c.get("auth").api.signUpEmail({
      body: {
        name: input.name,
        email: input.email,
        password: input.password,
      },
    });
    const userId = created.user.id;
    const now = dbTime(db);
    const groupIds = [...new Set(input.groupIds)];
    const status = input.status ?? (input.active ? "active" : "inactive");
    const active = status === "active";
    try {
      await commitWithEvent(
        c,
        [
          {
            sql: 'UPDATE "user" SET active = ?, updated_at = ? WHERE id = ?',
            params: [active, now, userId],
          },
          {
            sql: `INSERT INTO user_profiles(user_id, phone, telegram_id, job_title, birth_date, cpf, tags_json, sectors_json, notes, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              userId,
              input.phone || null,
              input.telegramId || null,
              input.jobTitle || null,
              input.birthDate || null,
              input.cpf || null,
              JSON.stringify(input.tags ?? []),
              JSON.stringify(input.sectors ?? []),
              input.notes || null,
              status,
              now,
              now,
            ],
          },
          ...(input.schedule
            ? [
                {
                  sql: `INSERT INTO user_work_schedules(id, user_id, daily_hours_json, entry_times_json, effective_at, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)`,
                  params: [
                    createId("schedule"),
                    userId,
                    JSON.stringify(input.schedule.dailyHours),
                    JSON.stringify(input.schedule.entryTimes),
                    now,
                    now,
                  ],
                },
              ]
            : []),
          { sql: "DELETE FROM session WHERE user_id = ?", params: [userId] },
          ...groupIds.map((groupId) => ({
            sql: insertIgnore(
              db.provider,
              "group_members",
              "group_id,user_id,created_at",
              "?, ?, ?",
              "(group_id,user_id)",
            ),
            params: [groupId, userId, now],
          })),
        ],
        {
          eventType: "core.user.created",
          resourceType: "core.user",
          resourceId: userId,
          data: {
            name: input.name,
            email: input.email,
            active,
            status,
            groupIds,
          },
        },
      );
    } catch (error) {
      await db
        .execute('DELETE FROM "user" WHERE id = ?', [userId])
        .catch(() => undefined);
      throw error;
    }
    const response = {
      id: userId,
      name: input.name,
      email: input.email,
      active,
      groupIds,
    };
    await saveIdempotency(c, "users.create", state, 201, response);
    await audit(c, "core.user.created", "core.user", userId, {
      active,
      status,
      groupIds,
    });
    return c.json(response, 201);
  },
);

managementRoutes.patch(
  "/users/:userId",
  requirePermission("core.user.update"),
  async (c) => {
    const input = await parseBody(c, userUpdateSchema);
    const userId = c.req.param("userId");
    const db = c.get("db");
    const current = await userAccessState(c, userId);
    if (input.email && input.email !== current.email.toLowerCase()) {
      const duplicate = await db.first<{ id: string }>(
        'SELECT id FROM "user" WHERE lower(email) = lower(?) AND id <> ?',
        [input.email, userId],
      );
      if (duplicate)
        throw new AppError(
          409,
          "EMAIL_ALREADY_EXISTS",
          "Another user already uses this email address.",
        );
    }
    if (input.password) await validateRecentReauth(c);
    const resultingAdministrator = input.groupIds
      ? await validateGroupAssignment(c, input.groupIds)
      : Boolean(current.isAdmin);
    const currentProfile = await db.first<{
      phone: string | null;
      telegramId: string | null;
      jobTitle: string | null;
      birthDate: string | null;
      cpf: string | null;
      tagsJson: string;
      sectorsJson: string;
      notes: string | null;
      status: "active" | "inactive" | "pending";
    }>(
      `SELECT phone, telegram_id AS "telegramId", job_title AS "jobTitle",
              birth_date AS "birthDate", cpf, tags_json AS "tagsJson",
              sectors_json AS "sectorsJson", notes, status
         FROM user_profiles WHERE user_id = ?`,
      [userId],
    );
    const resultingStatus =
      input.status ??
      (input.active !== undefined
        ? input.active
          ? "active"
          : "inactive"
        : (currentProfile?.status ??
          (Boolean(current.active) ? "active" : "inactive")));
    const resultingActive = resultingStatus === "active";
    await protectLastActiveAdministrator(
      c,
      current,
      resultingActive,
      resultingAdministrator,
    );
    const credentialAccount = input.password
      ? await db.first<{ id: string }>(
          `SELECT id FROM account
            WHERE user_id = ? AND provider_id = 'credential'
              AND issuer = 'local:credential' AND account_id = ?`,
          [userId, userId],
        )
      : null;
    if (input.password && !credentialAccount)
      throw new AppError(
        409,
        "PASSWORD_ACCOUNT_UNAVAILABLE",
        "This user does not have a password account.",
      );
    const state = await idempotencyLookup(c, `users.${userId}.update`, input);
    if (state?.replay)
      return c.json(state.replay.body as never, state.replay.status as 200);
    const now = dbTime(db);
    const passwordHash = input.password
      ? await (await c.get("auth").$context).password.hash(input.password)
      : undefined;
    const latestSchedule = input.schedule
      ? await db.first<{ dailyHoursJson: string; entryTimesJson: string }>(
          `SELECT daily_hours_json AS "dailyHoursJson", entry_times_json AS "entryTimesJson"
             FROM user_work_schedules WHERE user_id = ?
            ORDER BY effective_at DESC, created_at DESC`,
          [userId],
        )
      : null;
    const scheduleChanged = Boolean(
      input.schedule &&
      (latestSchedule?.dailyHoursJson !==
        JSON.stringify(input.schedule.dailyHours) ||
        latestSchedule?.entryTimesJson !==
          JSON.stringify(input.schedule.entryTimes)),
    );
    const statements = [
      {
        sql: 'UPDATE "user" SET name = ?, email = ?, active = ?, updated_at = ? WHERE id = ?',
        params: [
          input.name ?? current.name,
          input.email ?? current.email,
          resultingActive,
          now,
          userId,
        ],
      },
      {
        sql: `INSERT INTO user_profiles(user_id, phone, telegram_id, job_title, birth_date, cpf, tags_json, sectors_json, notes, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                phone = excluded.phone, telegram_id = excluded.telegram_id,
                job_title = excluded.job_title, birth_date = excluded.birth_date,
                cpf = excluded.cpf, tags_json = excluded.tags_json,
                sectors_json = excluded.sectors_json, notes = excluded.notes,
                status = excluded.status, updated_at = excluded.updated_at`,
        params: [
          userId,
          input.phone === undefined
            ? (currentProfile?.phone ?? null)
            : input.phone || null,
          input.telegramId === undefined
            ? (currentProfile?.telegramId ?? null)
            : input.telegramId || null,
          input.jobTitle === undefined
            ? (currentProfile?.jobTitle ?? null)
            : input.jobTitle || null,
          input.birthDate === undefined
            ? (currentProfile?.birthDate ?? null)
            : input.birthDate || null,
          input.cpf === undefined
            ? (currentProfile?.cpf ?? null)
            : input.cpf || null,
          JSON.stringify(
            input.tags ?? parseJson<string[]>(currentProfile?.tagsJson, []),
          ),
          JSON.stringify(
            input.sectors ??
              parseJson<string[]>(currentProfile?.sectorsJson, []),
          ),
          input.notes === undefined
            ? (currentProfile?.notes ?? null)
            : input.notes || null,
          resultingStatus,
          now,
          now,
        ],
      },
      ...(scheduleChanged && input.schedule
        ? [
            {
              sql: `INSERT INTO user_work_schedules(id, user_id, daily_hours_json, entry_times_json, effective_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)`,
              params: [
                createId("schedule"),
                userId,
                JSON.stringify(input.schedule.dailyHours),
                JSON.stringify(input.schedule.entryTimes),
                now,
                now,
              ],
            },
          ]
        : []),
      ...(input.groupIds
        ? [
            {
              sql: "DELETE FROM group_members WHERE user_id = ?",
              params: [userId],
            },
            ...[...new Set(input.groupIds)].map((groupId) => ({
              sql: insertIgnore(
                db.provider,
                "group_members",
                "group_id,user_id,created_at",
                "?, ?, ?",
                "(group_id,user_id)",
              ),
              params: [groupId, userId, now],
            })),
          ]
        : []),
      ...(passwordHash
        ? [
            {
              sql: `UPDATE account SET password = ?, updated_at = ?
                     WHERE user_id = ? AND provider_id = 'credential'
                       AND issuer = 'local:credential' AND account_id = ?`,
              params: [passwordHash, now, userId, userId],
            },
            { sql: "DELETE FROM session WHERE user_id = ?", params: [userId] },
          ]
        : []),
      ...(!resultingActive && Boolean(current.active) && !passwordHash
        ? [{ sql: "DELETE FROM session WHERE user_id = ?", params: [userId] }]
        : []),
    ];
    const eventType =
      resultingActive !== Boolean(current.active)
        ? resultingActive
          ? "core.user.activated"
          : "core.user.deactivated"
        : "core.user.updated";
    await commitWithEvent(c, statements, {
      eventType,
      resourceType: "core.user",
      resourceId: userId,
      data: {
        name: input.name ?? current.name,
        email: input.email ?? current.email,
        active: resultingActive,
        status: resultingStatus,
        groupIds: input.groupIds,
        passwordChanged: Boolean(input.password),
      },
    });
    const response = {
      id: userId,
      name: input.name ?? current.name,
      email: input.email ?? current.email,
      active: resultingActive,
      ...(input.groupIds ? { groupIds: [...new Set(input.groupIds)] } : {}),
      passwordChanged: Boolean(input.password),
    };
    await saveIdempotency(
      c,
      `users.${userId}.update`,
      state ?? null,
      200,
      response,
    );
    await audit(c, eventType, "core.user", userId, {
      changedFields: Object.keys(input).filter((key) => key !== "password"),
      passwordChanged: Boolean(input.password),
    });
    return c.json(response);
  },
);

managementRoutes.get(
  "/users/:userId/schedule-history",
  requirePermission("core.user.read"),
  async (c) => {
    const userId = c.req.param("userId");
    if (
      !(await c
        .get("db")
        .first<{ id: string }>('SELECT id FROM "user" WHERE id = ?', [userId]))
    )
      throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    const rows = await c.get("db").query<{
      id: string;
      dailyHoursJson: string;
      entryTimesJson: string;
      effectiveAt: string | number | Date;
      createdAt: string | number | Date;
    }>(
      `SELECT id, daily_hours_json AS "dailyHoursJson",
              entry_times_json AS "entryTimesJson", effective_at AS "effectiveAt",
              created_at AS "createdAt"
         FROM user_work_schedules WHERE user_id = ?
        ORDER BY effective_at DESC, created_at DESC LIMIT 100`,
      [userId],
    );
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        dailyHours: parseJson<string[]>(row.dailyHoursJson, []),
        entryTimes: parseJson<string[]>(row.entryTimesJson, []),
        effectiveAt: row.effectiveAt,
        createdAt: row.createdAt,
      })),
    });
  },
);

managementRoutes.delete(
  "/users/:userId",
  requirePermission("core.user.delete"),
  requireRecentReauth,
  async (c) => {
    const userId = c.req.param("userId");
    const db = c.get("db");
    const current = await userAccessState(c, userId);
    await protectLastActiveAdministrator(c, current, false, false);
    await commitWithEvent(
      c,
      [
        {
          sql: 'UPDATE "user" SET active = ?, updated_at = ? WHERE id = ?',
          params: [false, dbTime(db), userId],
        },
        {
          sql: "UPDATE user_profiles SET status = 'inactive', updated_at = ? WHERE user_id = ?",
          params: [dbTime(db), userId],
        },
        { sql: "DELETE FROM session WHERE user_id = ?", params: [userId] },
        {
          sql: "UPDATE apikey SET enabled = ?, updated_at = ? WHERE reference_id = ?",
          params: [false, dbTime(db), userId],
        },
      ],
      {
        eventType: "core.user.deactivated",
        resourceType: "core.user",
        resourceId: userId,
        data: { active: false, deleted: true },
      },
    );
    await audit(c, "core.user.deleted", "core.user", userId);
    return c.body(null, 204);
  },
);

managementRoutes.put(
  "/users/:userId/groups",
  requirePermission("core.user.update"),
  async (c) => {
    const { groupIds } = await c.req.json<{ groupIds?: string[] }>();
    if (
      !Array.isArray(groupIds) ||
      groupIds.some((id) => typeof id !== "string")
    )
      throw new AppError(
        422,
        "VALIDATION_ERROR",
        "groupIds must be a list of IDs.",
      );
    const userId = c.req.param("userId");
    const db = c.get("db");
    const current = await userAccessState(c, userId);
    const selectedAdmin = await validateGroupAssignment(c, groupIds);
    await protectLastActiveAdministrator(
      c,
      current,
      Boolean(current.active),
      selectedAdmin,
    );
    const now = dbTime(db);
    await db.atomic([
      { sql: "DELETE FROM group_members WHERE user_id = ?", params: [userId] },
      ...groupIds.map((groupId) => ({
        sql: insertIgnore(
          db.provider,
          "group_members",
          "group_id,user_id,created_at",
          "?, ?, ?",
          "(group_id,user_id)",
        ),
        params: [groupId, userId, now],
      })),
    ]);
    await audit(c, "core.user.groups_updated", "core.user", userId, {
      groupIds,
    });
    return c.json({ id: userId, groupIds });
  },
);

managementRoutes.get(
  "/invitations",
  requirePermission("core.user.read"),
  async (c) => {
    const rows = await c.get("db").query<Record<string, unknown>>(
      `SELECT id, email, expires_at AS "expiresAt", reserved_at AS "reservedAt", used_at AS "usedAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM user_invitations ORDER BY created_at DESC LIMIT 100`,
    );
    return c.json({ items: rows });
  },
);

managementRoutes.post(
  "/invitations",
  requirePermission("core.user.create"),
  async (c) => {
    const input = await parseBody(c, invitationCreateSchema);
    await validateGroupAssignment(c, input.groupIds);
    const idem = await idempotencyLookup(c, "invitations.create", input, true);
    if (idem?.replay)
      return c.json(idem.replay.body as never, idem.replay.status as 201);
    const token = randomToken(32);
    const id = createId("inv");
    const now = Date.now();
    await commitWithEvent(
      c,
      [
        {
          sql: `INSERT INTO user_invitations(id, email, token_hash, invited_by_user_id, group_ids_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params: [
            id,
            input.email,
            await hashToken(token),
            c.get("principal").userId,
            JSON.stringify(input.groupIds),
            dbTime(c.get("db"), now + input.expiresInHours * 3_600_000),
            dbTime(c.get("db"), now),
          ],
        },
      ],
      {
        eventType: "core.invitation.created",
        resourceType: "core.invitation",
        resourceId: id,
        data: {
          email: input.email,
          expiresAt: new Date(
            now + input.expiresInHours * 3_600_000,
          ).toISOString(),
        },
      },
    );
    const origin = new URL(c.env.BETTER_AUTH_URL).origin;
    const response = {
      id,
      email: input.email,
      expiresAt: new Date(now + input.expiresInHours * 3_600_000).toISOString(),
      inviteUrl: `${origin}/accept-invite#token=${token}`,
    };
    await saveIdempotency(c, "invitations.create", idem, 201, response);
    await audit(c, "core.invitation.created", "core.invitation", id, {
      email: input.email,
      groupIds: input.groupIds,
    });
    return c.json(response, 201, noStore);
  },
);

managementRoutes.delete(
  "/invitations/:invitationId",
  requirePermission("core.user.delete"),
  async (c) => {
    const id = c.req.param("invitationId");
    await commitWithEvent(
      c,
      [
        {
          sql: "UPDATE user_invitations SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
          params: [dbTime(c.get("db")), id],
        },
      ],
      {
        eventType: "core.invitation.revoked",
        resourceType: "core.invitation",
        resourceId: id,
        data: { revoked: true },
      },
    );
    await audit(c, "core.invitation.revoked", "core.invitation", id);
    return c.body(null, 204);
  },
);

managementRoutes.get(
  "/groups",
  requirePermission("core.group.read"),
  async (c) => {
    const groups = await c.get("db").query<Record<string, unknown>>(
      `SELECT g.id, g.name, g.is_admin AS "isAdmin", g.created_at AS "createdAt",
            (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS "memberCount"
       FROM groups g ORDER BY g.name`,
    );
    const [permissions, availablePermissions] = await Promise.all([
      c.get("db").query<{ groupId: string; key: string }>(
        `SELECT gp.group_id AS "groupId", p.key
             FROM group_permissions gp
             JOIN permissions p ON p.id = gp.permission_id
            ORDER BY p.key`,
      ),
      availablePermissionRows(c.get("db")),
    ]);
    const availableKeys = new Set(
      availablePermissions.map((permission) => permission.key),
    );
    return c.json({
      items: groups.map((group) => ({
        ...group,
        permissionKeys: permissions
          .filter(
            (permission) =>
              permission.groupId === group.id &&
              availableKeys.has(permission.key),
          )
          .map((p) => p.key),
      })),
    });
  },
);

managementRoutes.get(
  "/permissions",
  requirePermission("core.group.read"),
  async (c) =>
    c.json({
      items: await availablePermissionRows(c.get("db")),
    }),
);

managementRoutes.post(
  "/groups",
  requirePermission("core.group.create"),
  async (c) => {
    const input = await parseBody(c, groupCreateSchema);
    const idem = await idempotencyLookup(c, "groups.create", input);
    if (idem?.replay)
      return c.json(idem.replay.body as never, idem.replay.status as 201);
    if (
      input.permissionKeys.some((key) => !canPermission(c.get("ability"), key))
    )
      throw new AppError(
        403,
        "PERMISSION_ESCALATION",
        "You cannot grant permissions you do not have.",
      );
    const id = createId("grp");
    const now = dbTime(c.get("db"));
    const permissionRows = await requireAvailablePermissionRows(
      c.get("db"),
      input.permissionKeys,
    );
    await commitWithEvent(
      c,
      [
        {
          sql: "INSERT INTO groups(id, name, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          params: [id, input.name, false, now, now],
        },
        ...permissionRows.map((permission) => ({
          sql: insertIgnore(
            c.get("db").provider,
            "group_permissions",
            "group_id,permission_id,created_at",
            "?, ?, ?",
            "(group_id,permission_id)",
          ),
          params: [id, permission.id, now],
        })),
      ],
      {
        eventType: "core.group.created",
        resourceType: "core.group",
        resourceId: id,
        data: { name: input.name, permissionKeys: input.permissionKeys },
      },
    );
    await audit(c, "core.group.created", "core.group", id, {
      permissionKeys: input.permissionKeys,
    });
    const response = { id, ...input };
    await saveIdempotency(c, "groups.create", idem, 201, response);
    return c.json(response, 201);
  },
);

managementRoutes.patch(
  "/groups/:groupId",
  requirePermission("core.group.update"),
  async (c) => {
    const input = await parseBody(c, groupCreateSchema);
    const id = c.req.param("groupId");
    const idem = await idempotencyLookup(c, `groups.${id}.update`, input);
    if (idem?.replay)
      return c.json(idem.replay.body as never, idem.replay.status as 200);
    const group = await c
      .get("db")
      .first<{ isAdmin: number | boolean }>(
        'SELECT is_admin AS "isAdmin" FROM groups WHERE id = ?',
        [id],
      );
    if (!group) throw new AppError(404, "GROUP_NOT_FOUND", "Group not found.");
    if (Boolean(group.isAdmin))
      throw new AppError(
        409,
        "ADMIN_GROUP_PROTECTED",
        "The Administrators group is protected.",
      );
    if (
      input.permissionKeys.some((key) => !canPermission(c.get("ability"), key))
    )
      throw new AppError(
        403,
        "PERMISSION_ESCALATION",
        "You cannot grant permissions you do not have.",
      );
    const permissionRows = await requireAvailablePermissionRows(
      c.get("db"),
      input.permissionKeys,
    );
    const now = dbTime(c.get("db"));
    await commitWithEvent(
      c,
      [
        {
          sql: "UPDATE groups SET name = ?, updated_at = ? WHERE id = ?",
          params: [input.name, now, id],
        },
        {
          sql: "DELETE FROM group_permissions WHERE group_id = ?",
          params: [id],
        },
        ...permissionRows.map((permission) => ({
          sql: insertIgnore(
            c.get("db").provider,
            "group_permissions",
            "group_id,permission_id,created_at",
            "?, ?, ?",
            "(group_id,permission_id)",
          ),
          params: [id, permission.id, now],
        })),
      ],
      {
        eventType: "core.group.updated",
        resourceType: "core.group",
        resourceId: id,
        data: { name: input.name, permissionKeys: input.permissionKeys },
      },
    );
    await audit(c, "core.group.updated", "core.group", id, {
      permissionKeys: input.permissionKeys,
    });
    const response = { id, ...input };
    await saveIdempotency(c, `groups.${id}.update`, idem, 200, response);
    return c.json(response);
  },
);

managementRoutes.delete(
  "/groups/:groupId",
  requirePermission("core.group.delete"),
  requireRecentReauth,
  async (c) => {
    const id = c.req.param("groupId");
    const group = await c
      .get("db")
      .first<{ isAdmin: number | boolean }>(
        'SELECT is_admin AS "isAdmin" FROM groups WHERE id = ?',
        [id],
      );
    if (!group) throw new AppError(404, "GROUP_NOT_FOUND", "Group not found.");
    if (Boolean(group.isAdmin))
      throw new AppError(
        409,
        "ADMIN_GROUP_PROTECTED",
        "The Administrators group is protected.",
      );
    await commitWithEvent(
      c,
      [{ sql: "DELETE FROM groups WHERE id = ?", params: [id] }],
      {
        eventType: "core.group.deleted",
        resourceType: "core.group",
        resourceId: id,
        data: { deleted: true },
      },
    );
    await audit(c, "core.group.deleted", "core.group", id);
    return c.body(null, 204);
  },
);

managementRoutes.get(
  "/audit",
  requirePermission("core.audit.read"),
  async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    const rows = await c.get("db").query<Record<string, unknown>>(
      `SELECT id, request_id AS "requestId", user_id AS "userId", auth_method AS "authMethod", action, resource_type AS "resourceType", resource_id AS "resourceId", metadata_json AS "metadata", created_at AS "createdAt"
       FROM audit_log WHERE (? IS NULL OR action LIKE ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
      [
        query.search ?? null,
        query.search ? `%${query.search}%` : null,
        query.limit,
      ],
    );
    return c.json({
      items: rows.map((row) => ({
        ...row,
        metadata: parseJson(row.metadata, {}),
      })),
    });
  },
);
