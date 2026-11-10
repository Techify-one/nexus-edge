import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { apiKey } from "@better-auth/api-key";
import { describe, expect, it } from "vitest";
import type { DatabasePort } from "../packages/database/src/index.js";
import type { HonoEnv } from "../workers/core/src/env.js";
import { AppError, errorResponse } from "../workers/core/src/lib/http.js";
import { requirePrincipal } from "../workers/core/src/middleware/auth.js";
import { requireMcpPrincipal } from "../workers/core/src/mcp/oauth.js";

async function fixture() {
  const owner = {
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    active: true,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const auth = betterAuth({
    baseURL: "https://hub.example.com",
    secret: "test-only-secret-for-real-auth-contract-1234567890",
    database: memoryAdapter({ user: [owner], apikey: [] }),
    logger: { disabled: true },
    plugins: [
      apiKey({
        references: "user",
        enableSessionForAPIKeys: true,
        defaultPrefix: "app_",
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
      }),
    ],
  });
  const created = await auth.api.createApiKey({
    body: {
      userId: owner.id,
      name: "Auth contract",
      permissions: { "demo.record": ["read"] },
    },
  });
  const db = {
    query: async () => [{ ...owner, active: 1, key: null, isAdmin: 1 }],
  } as unknown as DatabasePort;
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth as never);
    c.set("db", db);
    c.set("requestId", "req_real_auth");
    await next();
  });
  const response = (c: import("hono").Context<HonoEnv>) =>
    c.json({
      authMethod: c.get("principal").authMethod,
      scopes: c.get("principal").credentialScopes,
      read: c.get("ability").can("read", "demo.record"),
      delete: c.get("ability").can("delete", "demo.record"),
    });
  app.get("/api", requirePrincipal, response);
  app.get("/mcp", requireMcpPrincipal, response);
  app.onError((error, c) => {
    if (error instanceof AppError) return errorResponse(c, error);
    throw error;
  });
  const request = (path: string, headers: HeadersInit) =>
    app.request(path, { headers }, {
      APP_INSTALLATION_ID: "test",
      BETTER_AUTH_URL: "https://hub.example.com",
      API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as never);
  return { request, key: created.key };
}

describe("real Better Auth API-key sessions", () => {
  it("accepts a headerless API-key session and preserves credential scope limits", async () => {
    const f = await fixture();
    const response = await f.request("/api", { "X-API-Key": f.key });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authMethod: "api_key",
      scopes: ["demo.record.read"],
      read: true,
      delete: false,
    });
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });
  it("accepts the same real key as a Bearer credential on MCP", async () => {
    const f = await fixture();
    const response = await f.request("/mcp", {
      Authorization: `Bearer ${f.key}`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scopes: ["demo.record.read"],
      read: true,
      delete: false,
    });
  });
  it("turns an invalid key into 401 rather than an internal error", async () => {
    const f = await fixture();
    const response = await f.request("/mcp", {
      Authorization:
        "Bearer app_invalid_key_that_is_long_enough_for_validation",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_API_KEY" },
    });
  });
});
