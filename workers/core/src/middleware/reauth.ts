import type { MiddlewareHandler } from "hono";
import type { HonoEnv } from "../env.js";
import { hashToken } from "../lib/crypto.js";
import { AppError } from "../lib/http.js";
import { dbTime } from "../lib/values.js";

type ReauthRow = {
  userId: string;
  authMethod: string;
  credentialId: string | null;
  expiresAt: unknown;
};

export async function validateRecentReauth(
  c: Parameters<MiddlewareHandler<HonoEnv>>[0],
): Promise<void> {
  const token = c.req.header("X-Reauth-Token");
  if (!token)
    throw new AppError(
      403,
      "REAUTH_REQUIRED",
      "Confirm your password before this operation.",
    );
  const row = await c.get("db").first<ReauthRow>(
    `SELECT user_id AS "userId", auth_method AS "authMethod", credential_id AS "credentialId", expires_at AS "expiresAt"
       FROM api_reauth_tokens WHERE token_hash = ?`,
    [await hashToken(token)],
  );
  const principal = c.get("principal");
  const expiresAt =
    row?.expiresAt instanceof Date
      ? row.expiresAt.getTime()
      : Number(row?.expiresAt ?? 0);
  if (
    !row ||
    row.userId !== principal.userId ||
    row.authMethod !== principal.authMethod ||
    (row.credentialId ?? undefined) !== principal.credentialId ||
    expiresAt <= Date.now()
  ) {
    throw new AppError(
      403,
      "REAUTH_INVALID",
      "The password confirmation is invalid or has expired.",
    );
  }
  await c
    .get("db")
    .execute(
      "UPDATE api_reauth_tokens SET last_used_at = ? WHERE token_hash = ?",
      [dbTime(c.get("db")), await hashToken(token)],
    );
}

export const requireRecentReauth: MiddlewareHandler<HonoEnv> = async (
  c,
  next,
) => {
  await validateRecentReauth(c);
  await next();
};
