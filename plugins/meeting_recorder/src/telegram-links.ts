import type { DatabasePort } from "@app/database";

const LINK_TTL_MS = 15 * 60 * 1_000;

const databaseTime = (db: DatabasePort, value = Date.now()): number | Date =>
  db.provider === "d1" ? value : new Date(value);

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const tokenHash = async (token: string): Promise<string> =>
  base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );

export type TelegramUserLink = {
  linked: boolean;
  telegramId: string | null;
  username: string | null;
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
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = base64Url(random);
  const hash = await tokenHash(token);
  const now = Date.now();
  const expiresAt = now + LINK_TTL_MS;
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

export const telegramStartToken = (text: string | undefined): string | null => {
  const match = text
    ?.trim()
    .match(/^\/start(?:@[A-Za-z0-9_]{5,32})?\s+nexus_([A-Za-z0-9_-]{40,64})$/u);
  return match?.[1] ?? null;
};

export async function consumeTelegramLinkRequest(input: {
  db: DatabasePort;
  token: string;
  telegramId: string;
  telegramUsername?: string;
}): Promise<{ userId: string } | null> {
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
     LIMIT 1`,
    [input.telegramId, request.userId, input.telegramId, request.userId],
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
  return request;
}
