import { createMongoAbility } from "@casl/ability";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { HonoEnv } from "../workers/core/src/env.js";
import type { DatabasePort } from "@app/database";
import { API_KEY_EXPIRATION } from "../workers/core/src/auth/factory.js";
import { AppError } from "../workers/core/src/lib/http.js";
import { OPENAPI_DOCUMENT } from "../workers/core/src/lib/openapi.js";
import { managementRoutes } from "../workers/core/src/routes/management.js";
import { installerRoutes } from "../workers/core/src/routes/installer.js";
import { webhookRoutes } from "../workers/core/src/routes/webhooks.js";

const appWithCreationRoutes = () => {
  const app = new Hono<HonoEnv>();
  app.use("*", async (context, next) => {
    context.set(
      "ability",
      createMongoAbility<[string, string]>([
        { action: "create", subject: "core.webhook" },
      ]),
    );
    await next();
  });
  app.route("/", managementRoutes);
  app.route("/webhooks", webhookRoutes);
  app.onError((error, context) =>
    context.json(
      { code: error instanceof AppError ? error.code : "UNEXPECTED" },
      error instanceof AppError ? error.status : 500,
    ),
  );
  return app;
};

const appWithInstallerRoutes = () => {
  const app = new Hono<HonoEnv>();
  app.use("*", async (context, next) => {
    context.set(
      "ability",
      createMongoAbility<[string, string]>([
        { action: "manage", subject: "all" },
      ]),
    );
    context.set("principal", { userId: "usr_test", authMethod: "cookie" });
    context.set("db", {
      provider: "d1",
      first: async () => null,
    } as unknown as DatabasePort);
    await next();
  });
  app.route("/", installerRoutes);
  app.onError((error, context) =>
    context.json(
      { code: error instanceof AppError ? error.code : "UNEXPECTED" },
      error instanceof AppError ? error.status : 500,
    ),
  );
  return app;
};

describe("creation authentication", () => {
  it("configures API-key expiration bounds in Better Auth's expected units", () => {
    expect(API_KEY_EXPIRATION).toEqual({
      defaultExpiresIn: 90 * 24 * 60 * 60,
      minExpiresIn: 1,
      maxExpiresIn: 365,
    });
  });

  it.each(["/me/api-keys", "/webhooks/endpoints"])(
    "does not require password confirmation for POST %s",
    async (path) => {
      const response = await appWithCreationRoutes().request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "BAD_JSON" });
    },
  );

  it("does not advertise a reauthentication header for API-key creation", () => {
    const operation = OPENAPI_DOCUMENT.paths["/api/v1/me/api-keys"].post;
    expect("parameters" in operation ? operation.parameters : undefined).toBe(
      undefined,
    );
  });

  it.each([
    ["POST", "/plugin-operations", 422],
    ["POST", "/plugin-operations/pop_missing/resume", 404],
    ["POST", "/plugin-operations/pop_missing/advance", 404],
    ["DELETE", "/plugins/crm", 404],
  ] as const)(
    "does not require password confirmation for %s %s",
    async (method, path, expectedStatus) => {
      const response = await appWithInstallerRoutes().request(path, {
        method,
        ...(path === "/plugin-operations" ? { body: new FormData() } : {}),
      });
      expect(response.status).toBe(expectedStatus);
      expect((await response.json()) as { code: string }).not.toEqual({
        code: "REAUTH_REQUIRED",
      });
    },
  );

  it("does not advertise reauthentication for plugin installation", () => {
    const parameters =
      OPENAPI_DOCUMENT.paths["/api/v1/plugin-operations"].post.parameters;
    expect(parameters).not.toContainEqual(
      expect.objectContaining({ name: "X-Reauth-Token" }),
    );
  });
});
