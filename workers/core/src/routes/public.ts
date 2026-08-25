import { Hono } from "hono";
import { CORE_PERMISSIONS } from "@app/db-schema/common";
import { createId } from "@app/core-contract";
import { firstAdminSchema, invitationAcceptSchema } from "@app/api-contracts";
import type { HonoEnv } from "../env.js";
import { hashToken } from "../lib/crypto.js";
import { AppError, noStore, parseBody } from "../lib/http.js";
import { dbTime, numberTime, parseJson } from "../lib/values.js";
import { auditAnonymous } from "../services/audit.js";
import { publicPluginGatewayRoutes } from "./public-plugin-gateway.js";

type BootstrapRow = {
  bootstrapState: "open" | "claimed" | "complete";
  bootstrapEmail: string | null;
};
type InvitationRow = {
  id: string;
  email: string;
  groupIdsJson: unknown;
  expiresAt: unknown;
  reservedAt: unknown;
  usedAt: unknown;
  revokedAt: unknown;
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

const findUser = (db: HonoEnv["Variables"]["db"], email: string) =>
  db.first<{ id: string }>(
    'SELECT id FROM "user" WHERE lower(email) = lower(?)',
    [email],
  );

export const publicRoutes = new Hono<HonoEnv>();

publicRoutes.route("/public/p", publicPluginGatewayRoutes);

publicRoutes.get("/setup/status", async (c) => {
  const settings = await c
    .get("db")
    .first<BootstrapRow>(
      `SELECT bootstrap_state AS "bootstrapState", bootstrap_email AS "bootstrapEmail" FROM app_settings WHERE id = 'system'`,
    );
  return c.json(
    {
      state: settings?.bootstrapState ?? "unavailable",
      resumable: settings?.bootstrapState === "claimed",
    },
    200,
    noStore,
  );
});

publicRoutes.post("/setup/first-admin", async (c) => {
  const input = await parseBody(c, firstAdminSchema);
  const db = c.get("db");
  const settings = await db.first<BootstrapRow>(
    `SELECT bootstrap_state AS "bootstrapState", bootstrap_email AS "bootstrapEmail" FROM app_settings WHERE id = 'system'`,
  );
  if (!settings || settings.bootstrapState === "complete")
    throw new AppError(
      409,
      "BOOTSTRAP_UNAVAILABLE",
      "Initial setup has already been completed.",
    );
  if (
    settings.bootstrapState === "claimed" &&
    settings.bootstrapEmail !== input.email
  ) {
    throw new AppError(
      409,
      "BOOTSTRAP_ALREADY_CLAIMED",
      "Initial setup has already been claimed by another email address.",
    );
  }
  if (settings.bootstrapState === "open") {
    const claimed = await db.execute(
      `UPDATE app_settings SET bootstrap_state = 'claimed', bootstrap_email = ?, bootstrap_claimed_at = ?
        WHERE id = 'system' AND bootstrap_state = 'open'`,
      [input.email, dbTime(db)],
    );
    if (claimed.rowsAffected !== 1)
      throw new AppError(
        409,
        "BOOTSTRAP_RACE",
        "Another request completed this step.",
      );
  }

  let userId: string;
  const existing = await findUser(db, input.email);
  if (existing) userId = existing.id;
  else {
    const created = await c.get("auth").api.signUpEmail({
      body: {
        name: input.name,
        email: input.email,
        password: input.password,
      },
    });
    userId = created.user.id;
  }

  const now = dbTime(db);
  const adminGroupId = "grp_administrators";
  const statements = [
    {
      sql: insertIgnore(
        db.provider,
        "groups",
        "id,name,is_admin,created_at,updated_at",
        "?, ?, ?, ?, ?",
        "(id)",
      ),
      params: [adminGroupId, "Administrators", true, now, now],
    },
    ...CORE_PERMISSIONS.map((key) => ({
      sql: insertIgnore(
        db.provider,
        "permissions",
        "id,key,created_at",
        "?, ?, ?",
        "(key)",
      ),
      params: [`perm_${key.replaceAll(".", "_")}`, key, now],
    })),
    ...CORE_PERMISSIONS.map((key) => ({
      sql: insertIgnore(
        db.provider,
        "group_permissions",
        "group_id,permission_id,created_at",
        "?, ?, ?",
        "(group_id,permission_id)",
      ),
      params: [adminGroupId, `perm_${key.replaceAll(".", "_")}`, now],
    })),
    {
      sql: insertIgnore(
        db.provider,
        "group_members",
        "group_id,user_id,created_at",
        "?, ?, ?",
        "(group_id,user_id)",
      ),
      params: [adminGroupId, userId, now],
    },
    {
      sql: `UPDATE app_settings SET first_admin_user_id = ?, bootstrap_state = 'complete', bootstrap_completed_at = ?
             WHERE id = 'system' AND bootstrap_state = 'claimed' AND bootstrap_email = ?`,
      params: [userId, now, input.email],
    },
  ];
  await db.atomic(statements);
  await auditAnonymous(
    c,
    "core.bootstrap.completed",
    "core.installation",
    c.env.APP_INSTALLATION_ID,
    { firstAdminUserId: userId },
  );
  return c.json({ userId, state: "complete" }, 201, noStore);
});

publicRoutes.get("/invitations/inspect", async (c) => {
  const token = c.req.query("token");
  if (!token || token.length < 32)
    throw new AppError(400, "INVALID_INVITATION", "Invalid invitation.");
  const invitation = await c.get("db").first<InvitationRow>(
    `SELECT id, email, group_ids_json AS "groupIdsJson", expires_at AS "expiresAt", reserved_at AS "reservedAt", used_at AS "usedAt", revoked_at AS "revokedAt"
       FROM user_invitations WHERE token_hash = ?`,
    [await hashToken(token)],
  );
  if (
    !invitation ||
    invitation.revokedAt ||
    invitation.usedAt ||
    numberTime(invitation.expiresAt) <= Date.now()
  ) {
    throw new AppError(
      410,
      "INVITATION_UNAVAILABLE",
      "This invitation is invalid, expired, revoked, or has already been used.",
    );
  }
  return c.json(
    {
      id: invitation.id,
      email: invitation.email,
      expiresAt: new Date(numberTime(invitation.expiresAt)).toISOString(),
    },
    200,
    noStore,
  );
});

publicRoutes.post("/invitations/accept", async (c) => {
  const input = await parseBody(c, invitationAcceptSchema);
  const db = c.get("db");
  const tokenHash = await hashToken(input.token);
  const invitation = await db.first<InvitationRow>(
    `SELECT id, email, group_ids_json AS "groupIdsJson", expires_at AS "expiresAt", reserved_at AS "reservedAt", used_at AS "usedAt", revoked_at AS "revokedAt"
       FROM user_invitations WHERE token_hash = ?`,
    [tokenHash],
  );
  if (
    !invitation ||
    invitation.revokedAt ||
    invitation.usedAt ||
    numberTime(invitation.expiresAt) <= Date.now()
  ) {
    throw new AppError(
      409,
      "INVITATION_UNAVAILABLE",
      "This invitation is invalid, expired, revoked, or has already been used.",
    );
  }
  if (!invitation.reservedAt) {
    const reserved = await db.execute(
      `UPDATE user_invitations SET reserved_at = ? WHERE id = ? AND reserved_at IS NULL AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      [dbTime(db), invitation.id, dbTime(db)],
    );
    if (reserved.rowsAffected !== 1)
      throw new AppError(
        409,
        "INVITATION_RACE",
        "This invitation is currently being used.",
      );
  }
  let userId: string;
  const existing = await findUser(db, invitation.email);
  if (existing) userId = existing.id;
  else {
    const created = await c.get("auth").api.signUpEmail({
      body: {
        name: input.name,
        email: invitation.email,
        password: input.password,
      },
    });
    userId = created.user.id;
  }
  const now = dbTime(db);
  const groupIds = parseJson<string[]>(invitation.groupIdsJson, []);
  await db.atomic([
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
    {
      sql: "UPDATE user_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL",
      params: [now, invitation.id],
    },
  ]);
  await db.execute(
    `INSERT INTO audit_log(id, request_id, user_id, auth_method, action, resource_type, resource_id, metadata_json, ip, user_agent, created_at)
     VALUES (?, ?, ?, 'cookie', 'core.invitation.accepted', 'core.invitation', ?, '{}', ?, ?, ?)`,
    [
      createId("aud"),
      c.get("requestId"),
      userId,
      invitation.id,
      c.req.header("CF-Connecting-IP") ?? null,
      c.req.header("User-Agent") ?? null,
      now,
    ],
  );
  return c.json({ userId, accepted: true }, 201, noStore);
});
