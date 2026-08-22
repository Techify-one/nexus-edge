import { createMongoAbility } from "@casl/ability";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { HonoEnv } from "../workers/core/src/env.js";
import { AppError } from "../workers/core/src/lib/http.js";
import { OPENAPI_DOCUMENT } from "../workers/core/src/lib/openapi.js";
import { managementRoutes } from "../workers/core/src/routes/management.js";
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

describe("creation authentication", () => {
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
});
