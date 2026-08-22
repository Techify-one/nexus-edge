import { readFileSync } from "node:fs";
import { createMongoAbility } from "@casl/ability";
import type { DatabasePort, SqlStatement } from "@app/database";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CoreEnv, HonoEnv } from "../workers/core/src/env.js";
import { AppError } from "../workers/core/src/lib/http.js";
import { installerRoutes } from "../workers/core/src/routes/installer.js";

const crmPackageBody = () => {
  const pluginRoot = "workers/plugin-crm";
  const migration = (dialect: "d1" | "postgres") => ({
    "0001_init": readFileSync(
      `${pluginRoot}/migrations/${dialect}/0001_init.sql`,
      "utf8",
    ),
  });
  const body = new FormData();
  body.set("manifest", readFileSync(`${pluginRoot}/manifest.json`, "utf8"));
  body.set(
    "worker",
    new File(["export default {};"], "worker.mjs", {
      type: "application/javascript",
    }),
  );
  body.set("d1Migrations", JSON.stringify(migration("d1")));
  body.set("postgresMigrations", JSON.stringify(migration("postgres")));
  return body;
};

const installerApp = (options?: {
  operation?: Record<string, unknown>;
  executedSql?: string[];
  atomicSql?: string[];
}) => {
  const db: DatabasePort = {
    provider: "d1",
    orm: {},
    query: async () => [],
    first: async <T extends Record<string, unknown>>(sql: string) =>
      sql.includes("FROM plugin_operations") && options?.operation
        ? (options.operation as T)
        : null,
    execute: async (sql: string) => {
      options?.executedSql?.push(sql);
      return { rowsAffected: 1 };
    },
    atomic: async (statements: SqlStatement[]) => {
      options?.atomicSql?.push(...statements.map(({ sql }) => sql));
      return statements.map(() => ({ rowsAffected: 1 }));
    },
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
  it("accepts the CRM package sources without password confirmation", async () => {
    const executedSql: string[] = [];
    const response = await installerApp({ executedSql }).request(
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
    expect(executedSql).toContainEqual(
      expect.stringContaining("state = 'failed'"),
    );
  });

  it("releases the global lock when an installation stage fails", async () => {
    const atomicSql: string[] = [];
    const response = await installerApp({
      atomicSql,
      operation: {
        operationId: "pop_failure",
        pluginId: "crm",
        type: "install",
        targetVersion: "1.0.0",
        state: "hardening",
        manifestSha256: "manifest",
        workerSha256: "worker",
        d1MigrationsSha256: "d1",
        postgresMigrationsSha256: "postgres",
        lastError: null,
      },
    }).request("/plugin-operations/pop_failure/advance", { method: "POST" }, {
      DATABASE_PROVIDER: "d1",
    } as CoreEnv);

    expect(response.status).toBe(500);
    expect(atomicSql).toContainEqual(
      expect.stringContaining("UPDATE installer_lock SET operation_id = NULL"),
    );
  });

  it("releases the global lock when a resumed package has different hashes", async () => {
    const atomicSql: string[] = [];
    const response = await installerApp({
      atomicSql,
      operation: {
        operationId: "pop_mismatch",
        pluginId: "crm",
        type: "install",
        targetVersion: "1.0.0",
        state: "deploying",
        manifestSha256: "old-manifest",
        workerSha256: "old-worker",
        d1MigrationsSha256: "old-d1",
        postgresMigrationsSha256: "old-postgres",
        lastError: null,
      },
    }).request(
      "/plugin-operations/pop_mismatch/advance",
      { method: "POST", body: crmPackageBody() },
      { DATABASE_PROVIDER: "d1" } as CoreEnv,
    );

    expect(response.status).toBe(409);
    expect(atomicSql).toContainEqual(
      expect.stringContaining("UPDATE installer_lock SET operation_id = NULL"),
    );
  });
});
