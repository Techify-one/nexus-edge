import { createMongoAbility } from "@casl/ability";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type {
  DatabasePort,
  SqlStatement,
} from "../packages/database/src/index.js";
import type { CoreEnv } from "../workers/core/src/env.js";
import type { HonoEnv } from "../workers/core/src/env.js";
import { AppError } from "../workers/core/src/lib/http.js";
import { requirePermission } from "../workers/core/src/middleware/auth.js";
import { managementRoutes } from "../workers/core/src/routes/management.js";

describe("granular authorization", () => {
  it("allows only the explicitly granted CRUD action", async () => {
    let ability = createMongoAbility<[string, string]>([
      { action: "read", subject: "core.user" },
    ]);
    const app = new Hono<HonoEnv>();
    app.use("*", async (context, next) => {
      context.set("ability", ability);
      await next();
    });
    app.get("/users", requirePermission("core.user.read"), (context) =>
      context.json({ allowed: "read" }),
    );
    app.post("/users", requirePermission("core.user.create"), (context) =>
      context.json({ allowed: "create" }),
    );
    app.patch("/users", requirePermission("core.user.update"), (context) =>
      context.json({ allowed: "update" }),
    );
    app.delete("/users", requirePermission("core.user.delete"), (context) =>
      context.json({ allowed: "delete" }),
    );
    app.onError((error, context) =>
      context.json(
        { code: error instanceof AppError ? error.code : "UNEXPECTED" },
        error instanceof AppError ? error.status : 500,
      ),
    );

    expect((await app.request("/users")).status).toBe(200);
    expect((await app.request("/users", { method: "POST" })).status).toBe(403);
    expect((await app.request("/users", { method: "PATCH" })).status).toBe(403);
    expect((await app.request("/users", { method: "DELETE" })).status).toBe(
      403,
    );

    ability = createMongoAbility<[string, string]>([
      { action: "update", subject: "core.user" },
    ]);
    expect((await app.request("/users")).status).toBe(403);
    expect((await app.request("/users", { method: "PATCH" })).status).toBe(200);
  });

  it("stores table preferences only under the authenticated user", async () => {
    const executions: Array<{
      sql: string;
      params: unknown[] | undefined;
    }> = [];
    const database = {
      provider: "d1",
      orm: {},
      query: async () => [],
      first: async (_sql: string, params?: unknown[]) => {
        expect(params).toEqual(["usr_actor", "core.users"]);
        return {
          configJson: JSON.stringify({
            version: 1,
            columnOrder: ["name"],
            columnVisibility: { name: true },
            columnSizing: { name: 240 },
            sorting: [],
          }),
          schemaVersion: 1,
          updatedAt: 123,
        };
      },
      execute: async (sql: string, params?: unknown[]) => {
        executions.push({ sql, params });
        return { rowsAffected: 1 };
      },
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;
    const app = new Hono<HonoEnv>();
    app.use("*", async (context, next) => {
      context.set("db", database);
      context.set("principal", {
        userId: "usr_actor",
        authMethod: "cookie",
      });
      await next();
    });
    app.route("/", managementRoutes);

    const getResponse = await app.request("/me/table-preferences/core.users");
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      tableId: "core.users",
      config: { columnOrder: ["name"] },
    });

    const config = {
      version: 1,
      columnOrder: ["email", "name"],
      columnVisibility: { email: true, name: false },
      columnSizing: { email: 320, name: 240 },
      sorting: [{ id: "email", desc: false }],
    };
    const putResponse = await app.request("/me/table-preferences/core.users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    expect(putResponse.status).toBe(200);
    expect(executions[0]?.params?.slice(0, 4)).toEqual([
      "usr_actor",
      "core.users",
      1,
      JSON.stringify(config),
    ]);

    const deleteResponse = await app.request(
      "/me/table-preferences/core.users",
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(204);
    expect(executions[1]?.params).toEqual(["usr_actor", "core.users"]);
  });

  it("updates all editable user fields and hashes the password atomically", async () => {
    const atomicBatches: SqlStatement[][] = [];
    const database = {
      provider: "d1",
      orm: {},
      query: async () => [],
      first: async (sql: string) => {
        if (sql.includes("FROM api_reauth_tokens"))
          return {
            userId: "usr_actor",
            authMethod: "cookie",
            credentialId: null,
            expiresAt: Date.now() + 60_000,
          };
        if (sql.includes('FROM "user" u'))
          return {
            id: "usr_target",
            name: "Old Name",
            email: "old@example.com",
            active: 1,
            isAdmin: 0,
          };
        if (sql.includes("lower(email) = lower(?)")) return null;
        if (sql.includes("FROM account")) return { id: "acc_target" };
        if (sql.includes("FROM api_idempotency_keys")) return null;
        return null;
      },
      execute: async () => ({ rowsAffected: 1 }),
      atomic: async (statements: SqlStatement[]) => {
        atomicBatches.push(statements);
        return statements.map(() => ({ rowsAffected: 1 }));
      },
      close: async () => undefined,
    } as DatabasePort;
    const app = new Hono<HonoEnv>();
    app.use("*", async (context, next) => {
      context.set("db", database);
      context.set("requestId", "req_test");
      context.set("principal", {
        userId: "usr_actor",
        authMethod: "cookie",
      });
      context.set(
        "ability",
        createMongoAbility<[string, string]>([
          { action: "update", subject: "core.user" },
        ]),
      );
      context.set("auth", {
        $context: Promise.resolve({
          password: { hash: async () => "secure_password_hash" },
        }),
      } as never);
      await next();
    });
    app.route("/", managementRoutes);
    app.onError((error, context) =>
      context.json(
        { code: error instanceof AppError ? error.code : String(error) },
        error instanceof AppError ? error.status : 500,
      ),
    );
    const environment = {
      WEBHOOK_QUEUE: { send: async () => undefined },
    } as unknown as CoreEnv;
    const executionContext = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const response = await app.fetch(
      new Request("https://app.example/users/usr_target", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem_user_update_123456",
          "X-Reauth-Token": "reauth_token_1234567890",
        },
        body: JSON.stringify({
          name: "New Name",
          email: "NEW@example.com",
          password: "newpass8",
          active: false,
          groupIds: [],
        }),
      }),
      environment,
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "usr_target",
      name: "New Name",
      email: "new@example.com",
      active: false,
      passwordChanged: true,
      groupIds: [],
    });
    const statements = atomicBatches[0] ?? [];
    expect(statements.some(({ sql }) => sql.includes('UPDATE "user"'))).toBe(
      true,
    );
    expect(
      statements.some(
        ({ sql, params }) =>
          sql.includes("UPDATE account SET password") &&
          params?.[0] === "secure_password_hash",
      ),
    ).toBe(true);
    expect(
      statements.some(({ sql }) => sql.includes("DELETE FROM session")),
    ).toBe(true);
    expect(JSON.stringify(statements)).not.toContain("newpass8");
  });

  it("creates a complete user account and removes the signup session", async () => {
    const atomicBatches: SqlStatement[][] = [];
    let signupBody: Record<string, unknown> | undefined;
    const database = {
      provider: "d1",
      orm: {},
      query: async () => [],
      first: async (sql: string) => {
        if (sql.includes("FROM api_idempotency_keys")) return null;
        if (sql.includes("lower(email) = lower(?)")) return null;
        return null;
      },
      execute: async () => ({ rowsAffected: 1 }),
      atomic: async (statements: SqlStatement[]) => {
        atomicBatches.push(statements);
        return statements.map(() => ({ rowsAffected: 1 }));
      },
      close: async () => undefined,
    } as DatabasePort;
    const app = new Hono<HonoEnv>();
    app.use("*", async (context, next) => {
      context.set("db", database);
      context.set("requestId", "req_create_user");
      context.set("principal", {
        userId: "usr_actor",
        authMethod: "cookie",
      });
      context.set(
        "ability",
        createMongoAbility<[string, string]>([
          { action: "create", subject: "core.user" },
        ]),
      );
      context.set("auth", {
        api: {
          signUpEmail: async ({ body }: { body: Record<string, unknown> }) => {
            signupBody = body;
            return { user: { id: "usr_created" } };
          },
        },
      } as never);
      await next();
    });
    app.route("/", managementRoutes);
    app.onError((error, context) =>
      context.json(
        { code: error instanceof AppError ? error.code : String(error) },
        error instanceof AppError ? error.status : 500,
      ),
    );
    const response = await app.fetch(
      new Request("https://app.example/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem_user_create_123456",
        },
        body: JSON.stringify({
          name: "New User",
          email: "NEW@example.com",
          password: "newpass8",
          active: false,
          groupIds: [],
        }),
      }),
      {
        WEBHOOK_QUEUE: { send: async () => undefined },
      } as unknown as CoreEnv,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: "usr_created",
      name: "New User",
      email: "new@example.com",
      active: false,
      groupIds: [],
    });
    expect(signupBody).toEqual({
      name: "New User",
      email: "new@example.com",
      password: "newpass8",
    });
    const statements = atomicBatches[0] ?? [];
    expect(statements.some(({ sql }) => sql.includes('UPDATE "user"'))).toBe(
      true,
    );
    expect(
      statements.some(({ sql }) => sql.includes("DELETE FROM session")),
    ).toBe(true);
    expect(
      statements.some(({ sql }) => sql.includes("INSERT INTO core_events")),
    ).toBe(true);
    expect(JSON.stringify(statements)).not.toContain("newpass8");
  });
});
