import type { DatabasePort } from "@app/database";

const PERSONAL_LINK_TTL_MS = 15 * 60 * 1_000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const databaseTime = (db: DatabasePort, value = Date.now()): number | Date =>
  db.provider === "d1" ? value : new Date(value);

const epochTime = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(String(value)).getTime();
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const randomToken = (): string =>
  base64Url(crypto.getRandomValues(new Uint8Array(32)));

const tokenHash = async (token: string): Promise<string> =>
  base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );

const telegramDisplayName = (input: {
  firstName?: string;
  lastName?: string;
}): string | null => {
  const name = [input.firstName, input.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .trim();
  return name ? name.slice(0, 128) : null;
};

export type TelegramUserLink = {
  linked: boolean;
  telegramId: string | null;
  username: string | null;
};

export type TelegramAccessItem = {
  id: string;
  kind: "member" | "invitation";
  label: string;
  ownerUserId: string;
  ownerName: string;
  telegramId: string | null;
  username: string | null;
  displayName: string | null;
  status: "active" | "pending";
  createdAt: number;
  linkedAt: number | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
};

export async function telegramUserLink(
  db: DatabasePort,
  userId: string,
): Promise<TelegramUserLink> {
  const row = await db.first<{ telegramId: string; username: string | null }>(
    `SELECT telegram_id AS "telegramId", telegram_username AS username
       FROM meeting_recorder_telegram_user_links WHERE user_id = ?`,
    [userId],
  );
  if (row)
    return {
      linked: true,
      telegramId: row.telegramId,
      username: row.username,
    };
  const profile = await db.first<{ telegramId: string }>(
    `SELECT telegram_id AS "telegramId" FROM user_profiles
      WHERE user_id = ? AND telegram_id IS NOT NULL AND telegram_id <> ''`,
    [userId],
  );
  return {
    linked: Boolean(profile),
    telegramId: profile?.telegramId ?? null,
    username: null,
  };
}

export async function createTelegramLinkRequest(input: {
  db: DatabasePort;
  userId: string;
  botUsername: string;
}): Promise<{ url: string; expiresAt: number }> {
  const token = randomToken();
  const hash = await tokenHash(token);
  const now = Date.now();
  const expiresAt = now + PERSONAL_LINK_TTL_MS;
  await input.db.execute(
    `INSERT INTO meeting_recorder_telegram_link_requests(
       user_id,token_hash,expires_at,used_at,created_at
     ) VALUES (?,?,?,NULL,?)
     ON CONFLICT(user_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       expires_at = excluded.expires_at,
       used_at = NULL,
       created_at = excluded.created_at`,
    [
      input.userId,
      hash,
      databaseTime(input.db, expiresAt),
      databaseTime(input.db, now),
    ],
  );
  const url = new URL(`https://t.me/${input.botUsername}`);
  url.searchParams.set("start", `nexus_${token}`);
  return { url: url.toString(), expiresAt };
}

export async function createTelegramInvitation(input: {
  db: DatabasePort;
  ownerUserId: string;
  createdByUserId: string;
  botUsername: string;
  label: string;
}): Promise<{ id: string; label: string; url: string; expiresAt: number }> {
  const id = `tgi_${crypto.randomUUID().replaceAll("-", "")}`;
  const token = randomToken();
  const hash = await tokenHash(token);
  const now = Date.now();
  const expiresAt = now + INVITATION_TTL_MS;
  const label = input.label.trim().slice(0, 100);
  await input.db.execute(
    `INSERT INTO meeting_recorder_telegram_invitations(
       id,owner_user_id,created_by_user_id,label,token_hash,expires_at,
       used_at,used_telegram_id,revoked_at,created_at
     ) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?)`,
    [
      id,
      input.ownerUserId,
      input.createdByUserId,
      label,
      hash,
      databaseTime(input.db, expiresAt),
      databaseTime(input.db, now),
    ],
  );
  const url = new URL(`https://t.me/${input.botUsername}`);
  url.searchParams.set("start", `nexus_inv_${token}`);
  return { id, label, url: url.toString(), expiresAt };
}

export type TelegramStartPayload = {
  kind: "personal" | "invitation";
  token: string;
};

export const telegramStartPayload = (
  text: string | undefined,
): TelegramStartPayload | null => {
  const match = text
    ?.trim()
    .match(
      /^\/start(?:@[A-Za-z0-9_]{5,32})?\s+nexus_(?:(inv)_)?([A-Za-z0-9_-]{40,64})$/u,
    );
  return match?.[2]
    ? { kind: match[1] ? "invitation" : "personal", token: match[2] }
    : null;
};

export async function consumeTelegramLinkRequest(input: {
  db: DatabasePort;
  token: string;
  telegramId: string;
  telegramUsername?: string;
}): Promise<{ userId: string; kind: "personal" } | null> {
  const hash = await tokenHash(input.token);
  const request = await input.db.first<{ userId: string }>(
    `SELECT user_id AS "userId"
       FROM meeting_recorder_telegram_link_requests
      WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?`,
    [hash, databaseTime(input.db)],
  );
  if (!request) return null;
  const existing = await input.db.first<{ userId: string }>(
    `SELECT user_id AS "userId" FROM meeting_recorder_telegram_user_links
      WHERE telegram_id = ? AND user_id <> ?
     UNION ALL
     SELECT user_id AS "userId" FROM user_profiles
      WHERE telegram_id = ? AND user_id <> ?
     UNION ALL
     SELECT owner_user_id AS "userId" FROM meeting_recorder_telegram_members
      WHERE telegram_id = ? AND revoked_at IS NULL
    `,
    [
      input.telegramId,
      request.userId,
      input.telegramId,
      request.userId,
      input.telegramId,
    ],
  );
  if (existing) return null;
  const now = databaseTime(input.db);
  const claimed = await input.db.execute(
    `UPDATE meeting_recorder_telegram_link_requests
        SET used_at = ?
      WHERE user_id = ? AND token_hash = ? AND used_at IS NULL AND expires_at >= ?`,
    [now, request.userId, hash, now],
  );
  if (!claimed.rowsAffected) return null;
  await input.db.execute(
    `INSERT INTO meeting_recorder_telegram_user_links(
       user_id,telegram_id,telegram_username,linked_at,updated_at
     ) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       telegram_id = excluded.telegram_id,
       telegram_username = excluded.telegram_username,
       linked_at = excluded.linked_at,
       updated_at = excluded.updated_at`,
    [
      request.userId,
      input.telegramId,
      input.telegramUsername?.slice(0, 64) ?? null,
      now,
      now,
    ],
  );
  return { ...request, kind: "personal" };
}

export async function consumeTelegramInvitation(input: {
  db: DatabasePort;
  token: string;
  telegramId: string;
  telegramUsername?: string;
  firstName?: string;
  lastName?: string;
}): Promise<{
  userId: string;
  ownerName: string;
  memberId: string;
  kind: "invitation";
} | null> {
  const hash = await tokenHash(input.token);
  const invitation = await input.db.first<{
    id: string;
    userId: string;
    ownerName: string;
    createdByUserId: string;
    label: string;
  }>(
    `SELECT invitation.id, invitation.owner_user_id AS "userId",
            owner.name AS "ownerName",
            invitation.created_by_user_id AS "createdByUserId",
            invitation.label
       FROM meeting_recorder_telegram_invitations invitation
       JOIN "user" owner ON owner.id = invitation.owner_user_id
      WHERE invitation.token_hash = ? AND invitation.used_at IS NULL
        AND invitation.revoked_at IS NULL AND invitation.expires_at >= ?
        AND owner.active = ?
        AND EXISTS (
          SELECT 1 FROM group_members gm
          JOIN group_permissions gp ON gp.group_id = gm.group_id
          JOIN permissions permission ON permission.id = gp.permission_id
          WHERE gm.user_id = owner.id
            AND permission.key = 'meeting_recorder.recording.create'
        )`,
    [hash, databaseTime(input.db), input.db.provider === "d1" ? 1 : true],
  );
  if (!invitation) return null;
  const existing = await input.db.first<{ userId: string }>(
    `SELECT user_id AS "userId" FROM meeting_recorder_telegram_user_links
      WHERE telegram_id = ?
     UNION ALL
     SELECT user_id AS "userId" FROM user_profiles WHERE telegram_id = ?
     UNION ALL
     SELECT owner_user_id AS "userId" FROM meeting_recorder_telegram_members
      WHERE telegram_id = ? AND revoked_at IS NULL
    `,
    [input.telegramId, input.telegramId, input.telegramId],
  );
  if (existing) return null;
  const now = databaseTime(input.db);
  const claimed = await input.db.execute(
    `UPDATE meeting_recorder_telegram_invitations
        SET used_at = ?, used_telegram_id = ?
      WHERE id = ? AND token_hash = ? AND used_at IS NULL
        AND revoked_at IS NULL AND expires_at >= ?`,
    [now, input.telegramId, invitation.id, hash, now],
  );
  if (!claimed.rowsAffected) return null;
  const memberId = `tgm_${crypto.randomUUID().replaceAll("-", "")}`;
  const member = await input.db.execute(
    `INSERT INTO meeting_recorder_telegram_members(
       id,owner_user_id,telegram_id,telegram_username,telegram_display_name,
       label,invited_by_user_id,invitation_id,linked_at,last_used_at,
       revoked_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       id = excluded.id,
       owner_user_id = excluded.owner_user_id,
       telegram_username = excluded.telegram_username,
       telegram_display_name = excluded.telegram_display_name,
       label = excluded.label,
       invited_by_user_id = excluded.invited_by_user_id,
       invitation_id = excluded.invitation_id,
       linked_at = excluded.linked_at,
       last_used_at = NULL,
       revoked_at = NULL,
       updated_at = excluded.updated_at
     WHERE meeting_recorder_telegram_members.revoked_at IS NOT NULL`,
    [
      memberId,
      invitation.userId,
      input.telegramId,
      input.telegramUsername?.slice(0, 64) ?? null,
      telegramDisplayName(input),
      invitation.label,
      invitation.createdByUserId,
      invitation.id,
      now,
      now,
    ],
  );
  if (!member.rowsAffected) return null;
  return {
    userId: invitation.userId,
    ownerName: invitation.ownerName,
    memberId,
    kind: "invitation",
  };
}

export async function listTelegramAccess(input: {
  db: DatabasePort;
  viewerUserId: string;
  readAll: boolean;
}): Promise<TelegramAccessItem[]> {
  const scope = input.readAll ? "" : " AND member.owner_user_id = ?";
  const params = input.readAll ? [] : [input.viewerUserId];
  const members = await input.db.query<{
    id: string;
    label: string;
    ownerUserId: string;
    ownerName: string;
    telegramId: string;
    username: string | null;
    displayName: string | null;
    linkedAt: unknown;
    lastUsedAt: unknown;
  }>(
    `SELECT member.id,member.label,member.owner_user_id AS "ownerUserId",
            owner.name AS "ownerName",member.telegram_id AS "telegramId",
            member.telegram_username AS username,
            member.telegram_display_name AS "displayName",
            member.linked_at AS "linkedAt",member.last_used_at AS "lastUsedAt"
       FROM meeting_recorder_telegram_members member
       JOIN "user" owner ON owner.id = member.owner_user_id
      WHERE member.revoked_at IS NULL${scope}
      ORDER BY member.linked_at DESC`,
    params,
  );
  const invitationScope = input.readAll
    ? ""
    : " AND invitation.owner_user_id = ?";
  const invitations = await input.db.query<{
    id: string;
    label: string;
    ownerUserId: string;
    ownerName: string;
    createdAt: unknown;
    expiresAt: unknown;
  }>(
    `SELECT invitation.id,invitation.label,
            invitation.owner_user_id AS "ownerUserId",
            owner.name AS "ownerName",invitation.created_at AS "createdAt",
            invitation.expires_at AS "expiresAt"
       FROM meeting_recorder_telegram_invitations invitation
       JOIN "user" owner ON owner.id = invitation.owner_user_id
      WHERE invitation.used_at IS NULL AND invitation.revoked_at IS NULL
        AND invitation.expires_at >= ?${invitationScope}
      ORDER BY invitation.created_at DESC`,
    [databaseTime(input.db), ...params],
  );
  return [
    ...members.map((member): TelegramAccessItem => ({
      id: member.id,
      kind: "member",
      label: member.label,
      ownerUserId: member.ownerUserId,
      ownerName: member.ownerName,
      telegramId: member.telegramId,
      username: member.username,
      displayName: member.displayName,
      status: "active",
      createdAt: epochTime(member.linkedAt),
      linkedAt: epochTime(member.linkedAt),
      lastUsedAt:
        member.lastUsedAt === null ? null : epochTime(member.lastUsedAt),
      expiresAt: null,
    })),
    ...invitations.map((invitation): TelegramAccessItem => ({
      id: invitation.id,
      kind: "invitation",
      label: invitation.label,
      ownerUserId: invitation.ownerUserId,
      ownerName: invitation.ownerName,
      telegramId: null,
      username: null,
      displayName: null,
      status: "pending",
      createdAt: epochTime(invitation.createdAt),
      linkedAt: null,
      lastUsedAt: null,
      expiresAt: epochTime(invitation.expiresAt),
    })),
  ].sort((left, right) => right.createdAt - left.createdAt);
}

export async function revokeTelegramMember(input: {
  db: DatabasePort;
  id: string;
  viewerUserId: string;
  manageAll: boolean;
}): Promise<boolean> {
  const now = databaseTime(input.db);
  const ownerScope = input.manageAll ? "" : " AND owner_user_id = ?";
  const result = await input.db.execute(
    `UPDATE meeting_recorder_telegram_members
        SET revoked_at = ?, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL${ownerScope}`,
    [now, now, input.id, ...(input.manageAll ? [] : [input.viewerUserId])],
  );
  return result.rowsAffected === 1;
}

export async function revokeTelegramInvitation(input: {
  db: DatabasePort;
  id: string;
  viewerUserId: string;
  manageAll: boolean;
}): Promise<boolean> {
  const ownerScope = input.manageAll ? "" : " AND owner_user_id = ?";
  const result = await input.db.execute(
    `UPDATE meeting_recorder_telegram_invitations SET revoked_at = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL${ownerScope}`,
    [
      databaseTime(input.db),
      input.id,
      ...(input.manageAll ? [] : [input.viewerUserId]),
    ],
  );
  return result.rowsAffected === 1;
}
