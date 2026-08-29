import type { PluginContext } from "@app/core-contract";
import type { Context } from "hono";
import { MeetingRecorderError } from "./errors.js";
import type { MeetingRecorderEnv } from "./env.js";
import type { Recording } from "./repository.js";

export const userContext = (c: Context<MeetingRecorderEnv>): PluginContext => {
  const context = c.get("pluginContext");
  if (!context)
    throw new MeetingRecorderError(
      403,
      "FORBIDDEN",
      "An authenticated plugin context is required.",
    );
  return context;
};

export const requirePermission = (
  c: Context<MeetingRecorderEnv>,
  permission: string,
): PluginContext => {
  const context = userContext(c);
  if (!context.permissions.includes(permission))
    throw new MeetingRecorderError(403, "FORBIDDEN", "Permission denied.");
  return context;
};

export const requireRecordingAccess = (
  context: PluginContext,
  recording: Recording | null,
  basePermission: string,
  overridePermission: string,
): Recording => {
  if (!context.permissions.includes(basePermission))
    throw new MeetingRecorderError(403, "FORBIDDEN", "Permission denied.");
  if (!recording)
    throw new MeetingRecorderError(404, "NOT_FOUND", "Recording not found.");
  if (
    recording.ownerUserId !== context.userId &&
    !context.permissions.includes(overridePermission)
  )
    throw new MeetingRecorderError(404, "NOT_FOUND", "Recording not found.");
  return recording;
};

export async function telegramOwner(
  c: Context<MeetingRecorderEnv>,
  telegramId: string,
): Promise<string | null> {
  const rows = await c.get("db").query<{
    userId: string;
    memberId: string | null;
  }>(
    `SELECT u.id AS "userId",NULL AS "memberId"
       FROM "user" u LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE (p.telegram_id = ? OR EXISTS (
              SELECT 1 FROM meeting_recorder_telegram_user_links link
               WHERE link.user_id = u.id AND link.telegram_id = ?
            ))
        AND (p.status IS NULL OR p.status = 'active') AND u.active = ?
        AND EXISTS (
          SELECT 1 FROM group_members gm
          JOIN group_permissions gp ON gp.group_id = gm.group_id
          JOIN permissions perm ON perm.id = gp.permission_id
          WHERE gm.user_id = u.id
            AND perm.key = 'meeting_recorder.recording.create'
        )
     UNION ALL
     SELECT u.id AS "userId",member.id AS "memberId"
       FROM meeting_recorder_telegram_members member
       JOIN "user" u ON u.id = member.owner_user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE member.telegram_id = ? AND member.revoked_at IS NULL
        AND (p.status IS NULL OR p.status = 'active') AND u.active = ?
        AND EXISTS (
          SELECT 1 FROM group_members gm
          JOIN group_permissions gp ON gp.group_id = gm.group_id
          JOIN permissions perm ON perm.id = gp.permission_id
          WHERE gm.user_id = u.id
            AND perm.key = 'meeting_recorder.recording.create'
        )
      LIMIT 2`,
    [
      telegramId,
      telegramId,
      c.get("db").provider === "d1" ? 1 : true,
      telegramId,
      c.get("db").provider === "d1" ? 1 : true,
    ],
  );
  if (rows.length !== 1) return null;
  const owner = rows[0]!;
  if (owner.memberId) {
    const now = c.get("db").provider === "d1" ? Date.now() : new Date();
    await c.get("db").execute(
      `UPDATE meeting_recorder_telegram_members
            SET last_used_at = ?, updated_at = ?
          WHERE id = ? AND revoked_at IS NULL`,
      [now, now, owner.memberId],
    );
  }
  return owner.userId;
}
