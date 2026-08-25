import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePort } from "../packages/database/src/index.js";
import type { HonoEnv } from "../workers/core/src/env.js";
import { publicPluginGatewayRoutes } from "../workers/core/src/routes/public-plugin-gateway.js";

describe("public plugin gateway", () => {
  it("keeps the Worker private while stripping credentials and sending bounded context", async () => {
    const pluginFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/public/play/abcdefghijklmnopqrstuvwxyzABCDEFG1234567890",
      );
      expect(request.headers.has("Authorization")).toBe(false);
      expect(request.headers.has("Cookie")).toBe(false);
      expect(request.headers.has("X-API-Key")).toBe(false);
      expect(request.headers.get("X-Plugin-Context")).toBeNull();
      expect(request.headers.get("X-Plugin-Public-Context")).toBeTruthy();
      return Response.json({ ok: true });
    });
    const database = {
      provider: "d1",
      orm: {},
      query: async () => [],
      first: async () => ({ status: "installed" }),
      execute: async () => ({ rowsAffected: 1 }),
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;
    const app = new Hono<HonoEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "req_public_plugin");
      c.set("db", database);
      await next();
    });
    app.route("/api/v1/public/p", publicPluginGatewayRoutes);
    const response = await app.request(
      "/api/v1/public/p/soletrando/play/abcdefghijklmnopqrstuvwxyzABCDEFG1234567890",
      {
        headers: {
          Authorization: "Bearer must-not-forward",
          Cookie: "session=must-not-forward",
          "X-API-Key": "must-not-forward",
          "CF-Connecting-IP": "203.0.113.10",
        },
      },
      {
        DATABASE_PROVIDER: "d1",
        API_RATE_LIMIT_MAX: "120",
        API_RATE_LIMIT_WINDOW_SECONDS: "60",
        PLUGIN_SOLETRANDO: { fetch: pluginFetch },
      } as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(pluginFetch).toHaveBeenCalledOnce();
  });
});
