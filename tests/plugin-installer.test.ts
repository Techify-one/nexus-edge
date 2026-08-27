import { readFileSync } from "node:fs";
import { createMongoAbility } from "@casl/ability";
import type { DatabasePort, SqlStatement } from "@app/database";
import { strFromU8, unzipSync } from "fflate";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256, stableJson } from "../packages/webhook-contract/src/index.js";
import type { CoreEnv, HonoEnv } from "../workers/core/src/env.js";
import {
  deletePluginSecret,
  pluginSecretConfigured,
  putPluginSecret,
  replaceCoreBindings,
  uploadPluginWorker,
} from "../workers/core/src/installer/cloudflare.js";
import { AppError } from "../workers/core/src/lib/http.js";
import { archivePackageStatements } from "../workers/core/src/installer/package-archive.js";
import type { PluginManifest } from "../workers/core/src/installer/manifest.js";
import { installerRoutes } from "../workers/core/src/routes/installer.js";

const crmPackageParts = () => {
  const pluginRoot = "plugins/crm";
  const migration = (dialect: "d1" | "postgres") => ({
    "0001_init": readFileSync(
      `${pluginRoot}/migrations/${dialect}/0001_init.sql`,
      "utf8",
    ),
  });
  return {
    manifest: JSON.parse(
      readFileSync(`${pluginRoot}/manifest.json`, "utf8"),
    ) as PluginManifest,
    worker: "export default {};",
    d1Migrations: migration("d1"),
    postgresMigrations: migration("postgres"),
  };
};

const crmPackageBody = (worker?: string) => {
  const parts = crmPackageParts();
  const body = new FormData();
  body.set("manifest", JSON.stringify(parts.manifest));
  body.set(
    "worker",
    new File([worker ?? parts.worker], "worker.mjs", {
      type: "application/javascript",
    }),
  );
  body.set("d1Migrations", JSON.stringify(parts.d1Migrations));
  body.set("postgresMigrations", JSON.stringify(parts.postgresMigrations));
  return body;
};

const installerApp = (options?: {
  operation?: Record<string, unknown>;
  plugin?: Record<string, unknown>;
  executedSql?: string[];
  atomicSql?: string[];
  atomicStatements?: SqlStatement[];
  packageChunks?: Array<{
    path: string;
    chunkIndex: number;
    content: string;
  }>;
}) => {
  const db: DatabasePort = {
    provider: "d1",
    orm: {},
    query: async <T extends Record<string, unknown>>(sql: string) =>
      (sql.includes("FROM plugin_package_chunks")
        ? (options?.packageChunks ?? [])
        : []) as T[],
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
        CF_API_TOKEN: "configured-plugin-runtime-token",
        CF_ACCOUNT_ID: "a".repeat(32),
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

  it("requires the deferred credential before creating the first plugin operation", async () => {
    const response = await installerApp().request(
      "/plugin-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "plugin-credential-required" },
        body: crmPackageBody(),
      },
      {
        APP_VERSION: "1.0.0",
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "PLUGIN_RUNTIME_CREDENTIAL_REQUIRED",
    });
  });

  it("rejects a package containing a Nexus runtime credential", async () => {
    const response = await installerApp().request(
      "/plugin-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "plugin-secret-test-key" },
        body: crmPackageBody(
          'const credential = "runtime-secret-sentinel"; export default {};',
        ),
      },
      {
        APP_VERSION: "1.0.0",
        APP_INSTALLATION_ID: "install_test",
        BETTER_AUTH_SECRET: "runtime-secret-sentinel",
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "PLUGIN_PACKAGE_CONTAINS_RUNTIME_VALUE",
    });
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
    const atomicSql: string[] = [];
    const response = await installerApp({
      executedSql,
      atomicSql,
      plugin: {
        workerName: "app-plugin-crm",
        status: "uninstalled",
      },
    }).request("/plugins/crm", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(atomicSql).toContainEqual(
      expect.stringContaining("DELETE FROM plugins"),
    );
    expect(atomicSql).not.toContainEqual(
      expect.stringContaining("DELETE FROM plugin_migrations"),
    );
    expect(atomicSql).not.toContainEqual(
      expect.stringContaining("DELETE FROM plugin_operations"),
    );
  });

  it("downloads only a verified portable package without Nexus data or credentials", async () => {
    const parts = crmPackageParts();
    const operationId = "pop_export";
    const packageChunks = archivePackageStatements(operationId, parts, 1)
      .slice(1)
      .map((statement) => ({
        path: String(statement.params?.[1]),
        chunkIndex: Number(statement.params?.[2]),
        content: String(statement.params?.[3]),
      }));
    const executedSql: string[] = [];
    const response = await installerApp({
      executedSql,
      packageChunks,
      plugin: {
        installedVersion: parts.manifest.version,
        status: "installed",
        databaseRowSecret: "must-not-be-exported",
      },
      operation: {
        operationId,
        manifestSha256: await sha256(stableJson(parts.manifest)),
        workerSha256: await sha256(parts.worker),
        d1MigrationsSha256: await sha256(stableJson(parts.d1Migrations)),
        postgresMigrationsSha256: await sha256(
          stableJson(parts.postgresMigrations),
        ),
        lastError: "credential=must-not-be-exported",
      },
    }).request("/plugins/crm/package");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="crm-1.0.0.plugin.zip"',
    );
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      "manifest.json",
      "migrations/d1/0001_init.sql",
      "migrations/postgres/0001_init.sql",
      "worker.mjs",
    ]);
    const archiveText = Object.values(files).map(strFromU8).join("\n");
    expect(archiveText).not.toContain("must-not-be-exported");
    expect(archiveText).not.toContain("BETTER_AUTH_SECRET");
    expect(archiveText).not.toContain("CF_API_TOKEN");
    expect(executedSql).toContainEqual(
      expect.stringContaining("INSERT INTO audit_log"),
    );

    const importBody = new FormData();
    importBody.set("manifest", strFromU8(files["manifest.json"]!));
    importBody.set(
      "worker",
      new File([files["worker.mjs"]!.buffer as ArrayBuffer], "worker.mjs", {
        type: "application/javascript",
      }),
    );
    importBody.set(
      "d1Migrations",
      JSON.stringify({
        "0001_init": strFromU8(files["migrations/d1/0001_init.sql"]!),
      }),
    );
    importBody.set(
      "postgresMigrations",
      JSON.stringify({
        "0001_init": strFromU8(files["migrations/postgres/0001_init.sql"]!),
      }),
    );
    const importResponse = await installerApp({ executedSql: [] }).request(
      "/plugin-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "portable-package-import" },
        body: importBody,
      },
      {
        APP_VERSION: "1.0.0",
        CF_API_TOKEN: "configured-plugin-runtime-token",
        CF_ACCOUNT_ID: "a".repeat(32),
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );
    expect(importResponse.status).toBe(201);
  });

  it("refuses to export a legacy package that was not archived", async () => {
    const response = await installerApp({
      plugin: { installedVersion: "1.0.0", status: "installed" },
      operation: {
        operationId: "pop_legacy",
        manifestSha256: "manifest",
        workerSha256: "worker",
        d1MigrationsSha256: "d1",
        postgresMigrationsSha256: "postgres",
      },
    }).request("/plugins/crm/package");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "PLUGIN_PACKAGE_EXPORT_UNAVAILABLE",
    });
  });

  it("restores a legacy portable archive from the exact original package without reinstalling", async () => {
    const parts = crmPackageParts();
    const atomicSql: string[] = [];
    const executedSql: string[] = [];
    const response = await installerApp({
      atomicSql,
      executedSql,
      plugin: {
        installedVersion: parts.manifest.version,
        status: "installed",
      },
      operation: {
        operationId: "pop_legacy_restore",
        pluginId: "crm",
        type: "install",
        targetVersion: parts.manifest.version,
        state: "installed",
        manifestSha256: await sha256(stableJson(parts.manifest)),
        workerSha256: await sha256(parts.worker),
        d1MigrationsSha256: await sha256(stableJson(parts.d1Migrations)),
        postgresMigrationsSha256: await sha256(
          stableJson(parts.postgresMigrations),
        ),
        lastError: null,
      },
    }).request(
      "/plugins/crm/package",
      { method: "POST", body: crmPackageBody() },
      {
        APP_VERSION: "1.0.0",
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );

    expect(response.status).toBe(204);
    expect(atomicSql).toContainEqual(
      expect.stringContaining("INSERT INTO plugin_package_chunks"),
    );
    expect(
      atomicSql.every((sql) => sql.includes("plugin_package_chunks")),
    ).toBe(true);
    expect(executedSql).toContainEqual(
      expect.stringContaining("INSERT INTO audit_log"),
    );
  });

  it("refuses to archive a rebuilt package for a legacy installation", async () => {
    const parts = crmPackageParts();
    const atomicSql: string[] = [];
    const response = await installerApp({
      atomicSql,
      plugin: {
        installedVersion: parts.manifest.version,
        status: "installed",
      },
      operation: {
        operationId: "pop_legacy_restore",
        pluginId: "crm",
        type: "install",
        targetVersion: parts.manifest.version,
        state: "installed",
        manifestSha256: await sha256(stableJson(parts.manifest)),
        workerSha256: await sha256(parts.worker),
        d1MigrationsSha256: await sha256(stableJson(parts.d1Migrations)),
        postgresMigrationsSha256: await sha256(
          stableJson(parts.postgresMigrations),
        ),
        lastError: null,
      },
    }).request(
      "/plugins/crm/package",
      {
        method: "POST",
        body: crmPackageBody("export default { changed: true };"),
      },
      {
        APP_VERSION: "1.0.0",
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "PLUGIN_PACKAGE_ARCHIVE_MISMATCH",
    });
    expect(atomicSql).toEqual([]);
  });

  it("refuses to archive a legacy package containing a current Nexus credential", async () => {
    const parts = crmPackageParts();
    const credentialWorker =
      'const value = "runtime-secret-sentinel"; export default {};';
    const atomicSql: string[] = [];
    const response = await installerApp({
      atomicSql,
      plugin: {
        installedVersion: parts.manifest.version,
        status: "installed",
      },
      operation: {
        operationId: "pop_unsafe_legacy_restore",
        pluginId: "crm",
        type: "install",
        targetVersion: parts.manifest.version,
        state: "installed",
        manifestSha256: await sha256(stableJson(parts.manifest)),
        workerSha256: await sha256(credentialWorker),
        d1MigrationsSha256: await sha256(stableJson(parts.d1Migrations)),
        postgresMigrationsSha256: await sha256(
          stableJson(parts.postgresMigrations),
        ),
        lastError: null,
      },
    }).request(
      "/plugins/crm/package",
      { method: "POST", body: crmPackageBody(credentialWorker) },
      {
        APP_VERSION: "1.0.0",
        BETTER_AUTH_SECRET: "runtime-secret-sentinel",
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "PLUGIN_PACKAGE_CONTAINS_RUNTIME_VALUE",
    });
    expect(atomicSql).toEqual([]);
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

  it("adds Workers AI only when the strict manifest requests it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const metadata = (init?.body as FormData).get("metadata");
        expect(metadata).toBeInstanceOf(Blob);
        expect(JSON.parse(await (metadata as Blob).text())).toMatchObject({
          observability: {
            enabled: true,
            head_sampling_rate: 1,
            logs: {
              enabled: true,
              invocation_logs: true,
              head_sampling_rate: 1,
              persist: true,
            },
          },
          bindings: expect.arrayContaining([
            { type: "plain_text", name: "DATABASE_PROVIDER", text: "d1" },
            { type: "d1", name: "DB", database_id: "database-id" },
            { type: "ai", name: "AI" },
          ]),
        });
        return Response.json({ success: true, result: {} });
      }),
    );

    await uploadPluginWorker(
      {
        CF_API_TOKEN: "test-token",
        CF_ACCOUNT_ID: "test-account",
        DATABASE_PROVIDER: "d1",
        D1_DATABASE_ID: "database-id",
      } as CoreEnv,
      "app-plugin-soletrando",
      "export default {};",
      {
        compatibilityDate: "2026-08-25",
        compatibilityFlags: ["nodejs_compat"],
        runtimeBindings: ["ai"],
      },
    );
  });

  it("does not enable AI observability for plugins without an AI binding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const metadata = (init?.body as FormData).get("metadata");
        expect(metadata).toBeInstanceOf(Blob);
        expect(JSON.parse(await (metadata as Blob).text())).not.toHaveProperty(
          "observability",
        );
        return Response.json({ success: true, result: {} });
      }),
    );

    await uploadPluginWorker(
      {
        CF_API_TOKEN: "test-token",
        CF_ACCOUNT_ID: "test-account",
        DATABASE_PROVIDER: "d1",
        D1_DATABASE_ID: "database-id",
      } as CoreEnv,
      "app-plugin-crm",
      "export default {};",
      {
        compatibilityDate: "2026-08-25",
        compatibilityFlags: ["nodejs_compat"],
      },
    );
  });

  it("validates and stores the first-plugin token without returning it", async () => {
    const accountId = "a".repeat(32);
    const token = `test-${"x".repeat(48)}`;
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${token}`,
        );
        if (url.endsWith(`/accounts/${accountId}/tokens/verify`))
          return Response.json({
            success: true,
            result: { id: "c".repeat(32), status: "active" },
          });
        if (url.endsWith("/accounts?per_page=50"))
          return Response.json(
            {
              success: false,
              result: null,
              errors: [{ code: 10000, message: "Authentication error" }],
            },
            { status: 403 },
          );
        if (url.endsWith(`/accounts/${accountId}/workers/scripts`))
          return Response.json({
            success: true,
            result: [{ id: "nexus-customer-core" }],
          });
        if (url.includes("/d1/database"))
          return Response.json(
            {
              success: false,
              result: null,
              errors: [{ code: 10000, message: "Authentication error" }],
            },
            { status: 403 },
          );
        if (url.includes("/queues"))
          return Response.json({
            success: true,
            result: [{ queue_id: "queue-id", queue_name: "queue-name" }],
          });
        if (url.endsWith("/secrets"))
          return Response.json({ success: true, result: {} });
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const response = await installerApp({ executedSql: [] }).request(
      "/plugin-runtime-credential",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
      {
        CF_ACCOUNT_ID: accountId,
        CORE_WORKER_NAME: "nexus-customer-core",
      } as CoreEnv,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ configured: true, accountId });
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toEqual({
      name: "CF_API_TOKEN",
      text: token,
      type: "secret_text",
    });
  });

  it("rejects a plugin token that can access D1", async () => {
    const accountId = "a".repeat(32);
    const token = `test-${"x".repeat(48)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/accounts/${accountId}/tokens/verify`))
          return Response.json({
            success: true,
            result: { id: "c".repeat(32), status: "active" },
          });
        if (url.endsWith("/accounts?per_page=50"))
          return Response.json({
            success: true,
            result: [{ id: accountId }],
          });
        if (url.endsWith(`/accounts/${accountId}/workers/scripts`))
          return Response.json({
            success: true,
            result: [{ id: "nexus-customer-core" }],
          });
        if (url.includes("/d1/database"))
          return Response.json({ success: true, result: [] });
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const response = await installerApp({ executedSql: [] }).request(
      "/plugin-runtime-credential",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
      {
        CF_ACCOUNT_ID: accountId,
        CORE_WORKER_NAME: "nexus-customer-core",
      } as CoreEnv,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "PLUGIN_RUNTIME_CREDENTIAL_TOO_BROAD",
    });
  });

  it("reports the selected account without exposing a credential value", async () => {
    const accountId = "b".repeat(32);
    const response = await installerApp().request(
      "/plugin-runtime-credential",
      undefined,
      {
        CF_ACCOUNT_ID: accountId,
        CORE_WORKER_NAME: "nexus-customer-core",
      } as CoreEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, accountId });
  });

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

  it("writes, detects, and deletes Worker secrets without reading values", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (init?.method === "GET")
          return Response.json({
            success: true,
            result: {
              bindings: [{ name: "META_ACCESS_TOKEN", type: "secret_text" }],
            },
          });
        return Response.json({ success: true, result: {} });
      }),
    );
    const env = {
      CF_API_TOKEN: "test-token",
      CF_ACCOUNT_ID: "test-account",
    } as CoreEnv;

    await putPluginSecret(
      env,
      "app-plugin-meta-ads",
      "META_ACCESS_TOKEN",
      "private-meta-token",
    );
    expect(
      await pluginSecretConfigured(
        env,
        "app-plugin-meta-ads",
        "META_ACCESS_TOKEN",
      ),
    ).toBe(true);
    await deletePluginSecret(env, "app-plugin-meta-ads", "META_ACCESS_TOKEN");

    expect(requests).toEqual([
      expect.objectContaining({
        method: "PUT",
        body: {
          name: "META_ACCESS_TOKEN",
          text: "private-meta-token",
          type: "secret_text",
        },
      }),
      expect.objectContaining({ method: "GET", body: null }),
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/secrets/META_ACCESS_TOKEN"),
      }),
    ]);
  });
});
