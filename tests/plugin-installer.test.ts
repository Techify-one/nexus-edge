import { readFileSync } from "node:fs";
import { createMongoAbility } from "@casl/ability";
import type { DatabasePort, SqlStatement } from "@app/database";
import { strFromU8, unzipSync } from "fflate";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CoreEnv, HonoEnv } from "../workers/core/src/env.js";
import { AppError } from "../workers/core/src/lib/http.js";
import { installerRoutes } from "../workers/core/src/routes/installer.js";

const crmPackageBody = () => {
  const files = unzipSync(readFileSync("artifacts/crm.plugin.zip"));
  const migrations = (dialect: "d1" | "postgres") =>
    Object.fromEntries(
      Object.entries(files)
        .filter(
          ([name]) =>
            name.startsWith(`migrations/${dialect}/`) && name.endsWith(".sql"),
        )
        .map(([name, contents]) => [
          name
            .split("/")
            .at(-1)!
            .replace(/\.sql$/u, ""),
          strFromU8(contents),
        ]),
    );
  const body = new FormData();
  body.set("manifest", strFromU8(files["manifest.json"]!));
  body.set(
    "worker",
    new File([files["worker.mjs"]!], "worker.mjs", {
      type: "application/javascript",
    }),
  );
  body.set("d1Migrations", JSON.stringify(migrations("d1")));
  body.set("postgresMigrations", JSON.stringify(migrations("postgres")));
  return body;
};

const installerApp = () => {
  const db: DatabasePort = {
    provider: "d1",
    orm: {},
    query: async () => [],
    first: async () => null,
    execute: async () => ({ rowsAffected: 1 }),
    atomic: async (statements: SqlStatement[]) =>
      statements.map(() => ({ rowsAffected: 1 })),
    close: async () => {},
  };
  const app = new Hono<HonoEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "req_plugin_test");
    context.set("db", db);
    context.set("principal", { userId: "usr_admin", authMethod: "cookie" });
    context.set(
      "ability",
      createMongoAbility<[string, string]>([
        { action: "manage", subject: "all" },
      ]),
    );
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

describe("CRM plugin installer", () => {
  it("accepts the packaged CRM artifact without password confirmation", async () => {
    const response = await installerApp().request(
      "/plugin-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "plugin-install-test-key" },
        body: crmPackageBody(),
      },
      {
        APP_VERSION: "1.0.0",
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(
      expect.objectContaining({ pluginId: "crm", state: "validating" }),
    );
  });
});
