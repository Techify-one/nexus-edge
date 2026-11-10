import { Hono, type Context } from "hono";
import type { PluginContext } from "@app/core-contract";
import type { HonoEnv } from "../env.js";
import { concretePermissionsForNamespace } from "../lib/ability.js";
import { AppError } from "../lib/http.js";
import { idempotencyLookup, saveIdempotency } from "../services/idempotency.js";

const encode = (value: unknown): string => {
  const binary = unescape(encodeURIComponent(JSON.stringify(value)));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const gatewayRoutes = new Hono<HonoEnv>();

export async function forwardPluginRequest(
  c: Context<HonoEnv>,
  pluginId: string,
  request: Request = c.req.raw,
  delegatedPermissions?: string[],
): Promise<Response> {
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(pluginId))
    throw new AppError(404, "PLUGIN_NOT_FOUND", "Plugin not found.");
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
  const context: PluginContext = {
    userId: c.get("principal").userId,
    permissions:
      delegatedPermissions ??
      (await concretePermissionsForNamespace(
        c.get("db"),
        c.get("ability"),
        pluginId,
      )),
    requestId: c.get("requestId"),
    origin: new URL(c.req.url).origin,
  };
  const prefix = `/api/v1/p/${pluginId}`;
  const incoming = new URL(request.url);
  const forwardedPath = incoming.pathname.slice(prefix.length) || "/";
  if (
    forwardedPath === "/__installer" ||
    forwardedPath.startsWith("/__installer/")
  )
    throw new AppError(404, "NOT_FOUND", "Resource not found.");
  const internalUrl = new URL(forwardedPath, "https://plugin.internal");
  internalUrl.search = incoming.search;
  const contentType = request.headers.get("Content-Type") ?? "";
  const idempotencyRequested = Boolean(request.headers.get("Idempotency-Key"));
  const idempotency =
    request.method === "POST" &&
    idempotencyRequested &&
    contentType.toLowerCase().includes("application/json")
      ? await idempotencyLookup(
          c,
          `plugins.${pluginId}.${internalUrl.pathname}.create`,
          await request
            .clone()
            .json()
            .catch(() => null),
          false,
          request,
        )
      : null;
  if (idempotency?.replay)
    return new Response(JSON.stringify(idempotency.replay.body), {
      status: idempotency.replay.status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.delete("X-API-Key");
  headers.delete("X-Reauth-Token");
  headers.delete("X-Plugin-Installer-Context");
  headers.delete("X-Plugin-Public-Context");
  headers.set("X-Plugin-Context", encode(context));
  const response = await (binding as Fetcher).fetch(
    new Request(internalUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
      ...(!["GET", "HEAD"].includes(request.method) ? { duplex: "half" } : {}),
      signal: request.signal,
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
      request,
    );
  }
  return response;
}

gatewayRoutes.all("/:pluginId/*", (c) =>
  forwardPluginRequest(c, c.req.param("pluginId")),
);
