import { readFileSync } from "node:fs";
import { createMongoAbility } from "@casl/ability";
import type { DatabasePort, SqlStatement } from "@app/database";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreEnv, HonoEnv } from "../workers/core/src/env.js";
import { replaceCoreBindings } from "../workers/core/src/installer/cloudflare.js";
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
  plugin?: Record<string, unknown>;
  executedSql?: string[];
  atomicSql?: string[];
  atomicStatements?: SqlStatement[];
}) => {
  const db: DatabasePort = {
    provider: "d1",
    orm: {},
    query: async () => [],
    first: async <T extends Record<string, unknown>>(sql: string) => {
      if (sql.includes("FROM plugin_operations") && options?.operation)
        return options.operation as T;
      if (sql.includes("FROM plugins") && options?.plugin)
        return options.plugin as T;
      return null;
    },
    execute: async (sql: string) => {
      options?.executedSql?.push(sql);
      return { rowsAffected: 1 };
    },
    atomic: async (statements: SqlStatement[]) => {
      options?.atomicSql?.push(...statements.map(({ sql }) => sql));
      options?.atomicStatements?.push(...statements);
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
    const atomicStatements: SqlStatement[] = [];
    const executedSql: string[] = [];
    const response = await installerApp({
      atomicSql,
      atomicStatements,
      executedSql,
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
    expect(executedSql).toContainEqual(
      expect.stringContaining("INSERT INTO audit_log"),
    );
    expect(String(atomicStatements[0]?.params?.[0])).toContain(
      '"requestId":"req_plugin_test"',
    );
    expect(String(atomicStatements[0]?.params?.[0])).toMatch(/"failedAt":\d+/u);
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

  it("returns only a safe Cloudflare failure code to administrators", async () => {
    const response = await installerApp({
      operation: {
        operationId: "pop_diagnostic",
        pluginId: "crm",
        type: "install",
        targetVersion: "1.0.0",
        state: "failed",
        manifestSha256: "manifest",
        workerSha256: "worker",
        d1MigrationsSha256: "d1",
        postgresMigrationsSha256: "postgres",
        lastError: JSON.stringify({
          from: "deploying",
          detail: "Cloudflare API failed (400): 10021",
          requestId: "req_cloudflare_failure",
          failedAt: 1_787_425_185_000,
        }),
      },
    }).request("/plugin-operations/pop_diagnostic");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        failureStage: "deploying",
        failureReason: "cloudflare_api_400_10021",
        failureDetail: "Cloudflare API returned HTTP 400 with code(s) 10021.",
        failureRequestId: "req_cloudflare_failure",
        failedAt: 1_787_425_185_000,
      }),
    );
  });

  it("never returns arbitrary provider failure details", async () => {
    const response = await installerApp({
      operation: {
        operationId: "pop_secret_diagnostic",
        pluginId: "crm",
        type: "install",
        targetVersion: "1.0.0",
        state: "failed",
        manifestSha256: "manifest",
        workerSha256: "worker",
        d1MigrationsSha256: "d1",
        postgresMigrationsSha256: "postgres",
        lastError: JSON.stringify({
          from: "deploying",
          detail: "token=super-secret https://private.example.test/account",
          requestId: "invalid request id",
        }),
      },
    }).request("/plugin-operations/pop_secret_diagnostic");

    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(body).toContain("unexpected_stage_failure");
    expect(body).not.toContain("super-secret");
    expect(body).not.toContain("private.example.test");
    expect(body).not.toContain("invalid request id");
  });

  it("deletes an already-uninstalled plugin record without touching preserved data", async () => {
    const executedSql: string[] = [];
    const response = await installerApp({
      executedSql,
      plugin: {
        workerName: "app-plugin-crm",
        status: "uninstalled",
      },
    }).request("/plugins/crm", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(executedSql).toContainEqual(
      expect.stringContaining("DELETE FROM plugins"),
    );
    expect(executedSql).not.toContainEqual(
      expect.stringContaining("DELETE FROM plugin_migrations"),
    );
    expect(executedSql).not.toContainEqual(
      expect.stringContaining("DELETE FROM plugin_operations"),
    );
  });

  it("reports a conflict instead of not-found for transitional plugin states", async () => {
    const response = await installerApp({
      plugin: {
        workerName: "app-plugin-crm",
        status: "uninstalling",
      },
    }).request("/plugins/crm", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "PLUGIN_STATE_CONFLICT" });
  });
});

describe("Cloudflare plugin bindings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("patches Worker bindings as multipart JSON", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("PATCH");
        expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
        expect(init?.body).toBeInstanceOf(FormData);
        const settingsPart = (init?.body as FormData).get("settings");
        expect(settingsPart).toBeInstanceOf(Blob);
        expect((settingsPart as Blob).type).toBe("application/json");
        expect(JSON.parse(await (settingsPart as Blob).text())).toEqual({
          bindings: [
            { type: "service", name: "PLUGIN_CRM", service: "plugin-crm" },
          ],
        });
        return Response.json({ success: true, result: {} });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await replaceCoreBindings(
      {
        CF_API_TOKEN: "test-token",
        CF_ACCOUNT_ID: "test-account",
        CORE_WORKER_NAME: "test-core",
      } as CoreEnv,
      [{ type: "service", name: "PLUGIN_CRM", service: "plugin-crm" }],
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
