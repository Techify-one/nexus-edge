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
  const rows = await c.get("db").query<{ userId: string }>(
    `SELECT p.user_id AS "userId"
       FROM user_profiles p JOIN "user" u ON u.id = p.user_id
      WHERE p.telegram_id = ? AND p.status = 'active' AND u.active = ?
        AND EXISTS (
          SELECT 1 FROM group_members gm
          JOIN group_permissions gp ON gp.group_id = gm.group_id
          JOIN permissions perm ON perm.id = gp.permission_id
          WHERE gm.user_id = p.user_id
            AND perm.key = 'meeting_recorder.recording.create'
        )
      LIMIT 2`,
    [telegramId, c.get("db").provider === "d1" ? 1 : true],
  );
  return rows.length === 1 ? rows[0]!.userId : null;
}
