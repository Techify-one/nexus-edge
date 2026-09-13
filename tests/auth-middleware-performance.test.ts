import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePort } from "../packages/database/src/index.js";
import type { CoreEnv, HonoEnv } from "../workers/core/src/env.js";
import { requirePrincipal } from "../workers/core/src/middleware/auth.js";

describe("authenticated request hot path", () => {
  it("uses one access query and the edge rate limiter without a D1 write", async () => {
    const query = vi.fn(async () => [
      {
        id: "usr_admin",
        name: "Admin",
        email: "admin@example.com",
        active: 1,
        key: null,
        isAdmin: 1,
      },
    ]);
    const execute = vi.fn(async () => ({ rowsAffected: 1 }));
    const database = {
      provider: "d1",
      orm: {},
      query,
      first: async () => null,
      execute,
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;
    const sessionHeaders = new Headers();
    sessionHeaders.append(
      "Set-Cookie",
      "__Secure-better-auth.session_data=signed; Path=/; HttpOnly; Secure",
    );
    const getSession = vi.fn(async () => ({
      headers: sessionHeaders,
      response: {
        user: { id: "usr_admin" },
        session: { id: "session_admin" },
      },
    }));
    const edgeLimit = vi.fn(async () => ({ success: true }));
    const app = new Hono<HonoEnv>();
    app.use("*", async (c, next) => {
      c.set("db", database);
      c.set("auth", { api: { getSession } } as never);
      await next();
    });
    app.use("*", requirePrincipal);
    app.get("/", (c) =>
      c.json({
        user: c.get("currentUser"),
        allowed: c.get("ability").can("manage", "all"),
      }),
    );

    const response = await app.request(
      "/",
      {
        headers: {
          Cookie: "__Secure-better-auth.session_token=signed-session",
        },
      },
      {
        APP_INSTALLATION_ID: "install_performance_test",
        API_RATE_LIMIT_MAX: "600",
        API_RATE_LIMIT_WINDOW_SECONDS: "60",
        API_RATE_LIMITER: { limit: edgeLimit },
      } as unknown as CoreEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: "usr_admin", active: 1 },
      allowed: true,
    });
    expect(getSession).toHaveBeenCalledWith(
      expect.objectContaining({ returnHeaders: true }),
    );
    expect(response.headers.get("Set-Cookie")).toContain("session_data");
    expect(query).toHaveBeenCalledOnce();
    expect(edgeLimit).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
