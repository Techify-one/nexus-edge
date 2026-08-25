import { Hono, type Context } from "hono";
import { createId, type PluginPublicContext } from "@app/core-contract";
import type { HonoEnv } from "../env.js";
import { hashToken } from "../lib/crypto.js";
import { AppError } from "../lib/http.js";

const encode = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/gu, "");
};

const bounded = (
  value: string | undefined,
  fallback: number,
  ceiling: number,
): number => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(ceiling, Math.floor(parsed)))
    : fallback;
};

async function consumePublicRateLimit(
  c: Context<HonoEnv>,
  pluginId: string,
  routeIdentity: string,
): Promise<void> {
  const max = bounded(c.env.API_RATE_LIMIT_MAX, 120, 10_000);
  const windowSeconds = bounded(
    c.env.API_RATE_LIMIT_WINDOW_SECONDS,
    60,
    86_400,
  );
  const now = Date.now();
  const cutoff = now - windowSeconds * 1_000;
  const address = c.req.header("CF-Connecting-IP") ?? "unknown";
  const key = `public:${pluginId}:${await hashToken(`${address}:${routeIdentity}`)}`;
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

export const publicPluginGatewayRoutes = new Hono<HonoEnv>();

publicPluginGatewayRoutes.all("/:pluginId/*", async (c) => {
  const pluginId = c.req.param("pluginId");
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(pluginId))
    throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
  if (!["GET", "HEAD", "POST"].includes(c.req.method))
    return c.json(
      {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Method not allowed.",
          requestId: c.get("requestId"),
        },
      },
      405,
    );
  const plugin = await c
    .get("db")
    .first<{ status: string }>("SELECT status FROM plugins WHERE id = ?", [
      pluginId,
    ]);
  if (!plugin || plugin.status !== "installed")
    throw new AppError(404, "PLUGIN_NOT_INSTALLED", "Plugin is not installed.");
  const binding = c.env[`PLUGIN_${pluginId.toUpperCase()}`];
  if (!binding || typeof (binding as Fetcher).fetch !== "function")
    throw new AppError(
      503,
      "PLUGIN_BINDING_MISSING",
      "The internal plugin binding is unavailable.",
    );

  const prefix = `/api/v1/public/p/${pluginId}`;
  const incoming = new URL(c.req.url);
  const forwardedPath = incoming.pathname.slice(prefix.length) || "/";
  const identity = forwardedPath
    .split("/")
    .filter(Boolean)
    .slice(0, 2)
    .join("/");
  await consumePublicRateLimit(c, pluginId, identity);

  const internalUrl = new URL(
    `/public${forwardedPath}`,
    "https://plugin.internal",
  );
  internalUrl.search = incoming.search;
  const headers = new Headers(c.req.raw.headers);
  for (const name of [
    "Authorization",
    "Cookie",
    "X-API-Key",
    "X-Reauth-Token",
    "X-Plugin-Context",
    "X-Plugin-Public-Context",
  ])
    headers.delete(name);
  const context: PluginPublicContext = {
    pluginId,
    requestId: c.get("requestId"),
  };
  headers.set("X-Plugin-Public-Context", encode(context));
  const response = await (binding as Fetcher).fetch(
    new Request(internalUrl, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? null : c.req.raw.body,
      signal: c.req.raw.signal,
    }),
  );
  const outgoing = new Response(response.body, response);
  outgoing.headers.set("Cache-Control", "private, no-store");
  return outgoing;
});
