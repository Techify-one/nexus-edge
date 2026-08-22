import { Hono } from "hono";
import type { PluginContext } from "@app/core-contract";
import type { HonoEnv } from "../env.js";
import { concretePermissionsForNamespace } from "../lib/ability.js";
import { AppError } from "../lib/http.js";
import { validateRecentReauth } from "../middleware/reauth.js";
import { idempotencyLookup, saveIdempotency } from "../services/idempotency.js";

const encode = (value: unknown): string => {
  const binary = unescape(encodeURIComponent(JSON.stringify(value)));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const gatewayRoutes = new Hono<HonoEnv>();

gatewayRoutes.all("/:pluginId/*", async (c) => {
  const pluginId = c.req.param("pluginId");
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(pluginId))
    throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
  const plugin = await c
    .get("db")
    .first<{ status: string }>("SELECT status FROM plugins WHERE id = ?", [
      pluginId,
    ]);
  if (!plugin || plugin.status !== "installed")
    throw new AppError(404, "PLUGIN_NOT_INSTALLED", "Plugin is not installed.");
  if (c.req.method === "DELETE") await validateRecentReauth(c);
  const binding = c.env[`PLUGIN_${pluginId.toUpperCase()}`];
  if (!binding || typeof (binding as Fetcher).fetch !== "function")
    throw new AppError(
      503,
      "PLUGIN_BINDING_MISSING",
      "The internal plugin binding is unavailable.",
    );
  const context: PluginContext = {
    userId: c.get("principal").userId,
    permissions: await concretePermissionsForNamespace(
      c.get("db"),
      c.get("ability"),
      pluginId,
    ),
    requestId: c.get("requestId"),
  };
  const prefix = `/api/v1/p/${pluginId}`;
  const incoming = new URL(c.req.url);
  const internalUrl = new URL(
    incoming.pathname.slice(prefix.length) || "/",
    "https://plugin.internal",
  );
  internalUrl.search = incoming.search;
  const idempotency =
    c.req.method === "POST"
      ? await idempotencyLookup(
          c,
          `plugins.${pluginId}.${internalUrl.pathname}.create`,
          await c.req.raw
            .clone()
            .json()
            .catch(() => null),
        )
      : null;
  if (idempotency?.replay)
    return new Response(JSON.stringify(idempotency.replay.body), {
      status: idempotency.replay.status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  const headers = new Headers(c.req.raw.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.delete("X-API-Key");
  headers.delete("X-Reauth-Token");
  headers.set("X-Plugin-Context", encode(context));
  const response = await (binding as Fetcher).fetch(
    new Request(internalUrl, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? null : c.req.raw.body,
    }),
  );
  if (
    idempotency &&
    response.ok &&
    response.headers.get("Content-Type")?.includes("application/json")
  ) {
    await saveIdempotency(
      c,
      `plugins.${pluginId}.${internalUrl.pathname}.create`,
      idempotency,
      response.status,
      await response.clone().json(),
    );
  }
  return response;
});
