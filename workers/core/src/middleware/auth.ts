import type { MiddlewareHandler } from "hono";
import { createId, type RequestPrincipal } from "@app/core-contract";
import type { HonoEnv } from "../env.js";
import { AppError } from "../lib/http.js";
import { buildAbility, canPermission } from "../lib/ability.js";

async function consumePrincipalRateLimit(
  c: Parameters<MiddlewareHandler<HonoEnv>>[0],
  principal: RequestPrincipal,
): Promise<void> {
  const bounded = (
    value: string | undefined,
    fallback: number,
    ceiling: number,
  ) => {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed)
      ? Math.max(1, Math.min(ceiling, Math.floor(parsed)))
      : fallback;
  };
  const max = bounded(c.env.API_RATE_LIMIT_MAX, 120, 10_000);
  const windowSeconds = bounded(
    c.env.API_RATE_LIMIT_WINDOW_SECONDS,
    60,
    86_400,
  );
  const now = Date.now();
  const cutoff = now - windowSeconds * 1_000;
  const key = `app:${principal.authMethod}:${principal.credentialId ?? principal.userId}`;
  const result = await c.get("db").execute(
    `INSERT INTO "rateLimit"(id,key,count,last_request) VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN last_request <= ? THEN 1 ELSE count + 1 END,
       last_request = ?
     WHERE last_request <= ? OR count < ?`,
    [createId("rl"), key, now, cutoff, now, cutoff, max],
  );
  if (!result.rowsAffected) {
    c.header("Retry-After", String(windowSeconds));
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again shortly.",
    );
  }
}

const cookieCredentialPresent = (headers: Headers): boolean => {
  const cookie = headers.get("cookie") ?? "";
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/u.test(cookie);
};

const parseStoredPermissions = (value: unknown): string[] => {
  if (!value) return [];
  const parsed =
    typeof value === "string"
      ? (JSON.parse(value) as Record<string, string[]>)
      : (value as Record<string, string[]>);
  return Object.entries(parsed).flatMap(([subject, actions]) =>
    actions.map((action) => `${subject}.${action}`),
  );
};

export const requirePrincipal: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const hasCookie = cookieCredentialPresent(c.req.raw.headers);
  const bearer = c.req.header("Authorization")?.startsWith("Bearer ") ?? false;
  const apiKey = c.req.header("X-API-Key");
  if ([hasCookie, bearer, Boolean(apiKey)].filter(Boolean).length > 1) {
    throw new AppError(
      401,
      "CONFLICTING_CREDENTIALS",
      "Send exactly one authentication method.",
    );
  }

  const auth = c.get("auth");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user?.id)
    throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");

  const active = await c
    .get("db")
    .first<{ active: number | boolean }>(
      'SELECT active FROM "user" WHERE id = ?',
      [session.user.id],
    );
  if (!active || !Boolean(active.active))
    throw new AppError(401, "USER_INACTIVE", "The account is inactive.");

  const principal: RequestPrincipal = {
    userId: session.user.id,
    authMethod: apiKey ? "api_key" : bearer ? "bearer" : "cookie",
  };
  if (bearer) principal.credentialId = session.session.id;
  if (apiKey) {
    const verified = await auth.api.verifyApiKey({ body: { key: apiKey } });
    if (!verified.valid)
      throw new AppError(401, "INVALID_API_KEY", "Invalid API key.");
    const record = (
      verified as unknown as { key?: { id?: string; permissions?: unknown } }
    ).key;
    if (record?.id) principal.credentialId = record.id;
    principal.credentialScopes = parseStoredPermissions(record?.permissions);
  }
  await consumePrincipalRateLimit(c, principal);
  c.set("principal", principal);
  c.set("ability", await buildAbility(c.get("db"), principal));
  await next();
};

export const requirePermission =
  (key: string): MiddlewareHandler<HonoEnv> =>
  async (c, next) => {
    if (!canPermission(c.get("ability"), key))
      throw new AppError(
        403,
        "FORBIDDEN",
        "You do not have permission for this operation.",
      );
    await next();
  };

export const enforceCookieOrigin: MiddlewareHandler<HonoEnv> = async (
  c,
  next,
) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  if (c.get("principal").authMethod !== "cookie") return next();
  const origin = c.req.header("Origin");
  const allowed = c.env.TRUSTED_ORIGINS.split(",").map((value) => value.trim());
  if (!origin || !allowed.includes(origin))
    throw new AppError(
      403,
      "INVALID_ORIGIN",
      "The request origin is not authorized.",
    );
  await next();
};
