import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePort } from "../packages/database/src/index.js";
import { sha256, base64url } from "../packages/webhook-contract/src/index.js";
import type { CoreEnv, HonoEnv } from "../workers/core/src/env.js";
import { AppError, errorResponse } from "../workers/core/src/lib/http.js";
import {
  requirePrincipal,
  enforceCookieOrigin,
} from "../workers/core/src/middleware/auth.js";
import { mcpRoutes } from "../workers/core/src/routes/mcp.js";
import { mcpSettingsRoutes } from "../workers/core/src/routes/mcp-settings.js";
import {
  mcpConsentRoutes,
  mcpDiscoveryRoutes,
  mcpOAuthRoutes,
  validRedirect,
} from "../workers/core/src/mcp/oauth.js";
import {
  actionsFromOpenApi,
  actionRequest,
} from "../workers/core/src/mcp/tools.js";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const origin = "https://hub.example.com";
const cookieHeaders = {
  Cookie: "better-auth.session_token=test",
  Origin: origin,
};
const permissions = [
  "demo.record.read",
  "demo.record.create",
  "demo.record.delete",
];
const declaration = (name: string, permission: string) => ({
  name: `demo_${name}`,
  permissions: [permission],
});
const document = {
  paths: {
    "/api/v1/p/demo/records": {
      get: {
        summary: "List records",
        "x-nexus-mcp": declaration("list", permissions[0]!),
      },
      post: {
        summary: "Create record",
        "x-nexus-mcp": declaration("create", permissions[1]!),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { name: { type: "string", minLength: 2 } },
                required: ["name"],
              },
            },
          },
        },
      },
    },
    "/api/v1/p/demo/records/{recordId}": {
      delete: { "x-nexus-mcp": declaration("delete", permissions[2]!) },
    },
    "/api/v1/public/p/demo/webhook": {
      post: { "x-nexus-mcp": declaration("webhook", permissions[1]!) },
    },
  },
};

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  for (const migration of readdirSync("workers/core/migrations/d1")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(
      readFileSync(`workers/core/migrations/d1/${migration}`, "utf8"),
    );
  sqlite.exec(`INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES ('owner','Owner','owner@example.com',1,1);
    INSERT INTO groups(id,name,is_admin,created_at,updated_at) VALUES ('admin','Admin',1,1,1);
    INSERT INTO group_members(group_id,user_id,created_at) VALUES ('admin','owner',1);`);
  for (const key of permissions)
    sqlite
      .prepare("INSERT INTO permissions(id,key,created_at) VALUES (?, ?, 1)")
      .run(key, key);
  const manifest = JSON.stringify({ permissions });
  sqlite
    .prepare(
      `INSERT INTO plugins(id,name,installed_version,api_version,database_dialects_json,active_database_provider,worker_name,status,manifest_json,installed_at,updated_at,package_format,release_hash) VALUES ('demo','Demo','1.0.0',1,'["d1"]','d1','demo-worker','installed',?,1,1,2,'release')`,
    )
    .run(manifest);
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  sqlite
    .prepare(
      `INSERT INTO plugin_assets(plugin_id,release_hash,path,content_type,operation_id,sha256,byte_length,active,created_at) VALUES ('demo','release','openapi.json','application/json','op',?,?,1,1)`,
    )
    .run(await sha256(bytes), bytes.byteLength);
  // Package chunks have no FK to an installer operation so historical assets stay portable.
  sqlite
    .prepare(
      `INSERT INTO plugin_package_chunks(operation_id,path,chunk_index,content,created_at) VALUES ('op','openapi.json',0,?,1)`,
    )
    .run(`base64:${Buffer.from(bytes).toString("base64url")}`);
  const database = {
    provider: "d1",
    orm: {},
    query: async (sql: string, params: SQLInputValue[] = []) =>
      sqlite.prepare(sql).all(...params),
    first: async (sql: string, params: SQLInputValue[] = []) =>
      sqlite.prepare(sql).get(...params) ?? null,
    execute: async (sql: string, params: SQLInputValue[] = []) => ({
      rowsAffected: Number(sqlite.prepare(sql).run(...params).changes),
    }),
    close: async () => {},
    atomic: async () => [],
  } as unknown as DatabasePort;
  const pluginFetch = vi.fn(async (request: Request) => {
    expect(request.headers.has("Authorization")).toBe(false);
    expect(request.headers.has("Cookie")).toBe(false);
    expect(request.headers.has("X-API-Key")).toBe(false);
    const context = JSON.parse(
      Buffer.from(
        request.headers.get("X-Plugin-Context")!,
        "base64url",
      ).toString(),
    );
    expect(context.userId).toBe("owner");
    return Response.json({
      method: request.method,
      path: new URL(request.url).pathname,
      permissions: context.permissions,
      ...(request.method === "POST" ? { input: await request.json() } : {}),
    });
  });
  const env = {
    APP_VERSION: "test",
    APP_INSTALLATION_ID: "test",
    BETTER_AUTH_URL: origin,
    TRUSTED_ORIGINS: origin,
    DATABASE_PROVIDER: "d1",
    PLUGIN_DEMO: { fetch: pluginFetch },
  } as unknown as CoreEnv;
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("db", database);
    c.set("requestId", "req_test");
    c.set("auth", {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => ({
          headers: new Headers(),
          response:
            headers.get("Cookie") === cookieHeaders.Cookie ||
            headers.get("X-API-Key") === "app_readonly"
              ? { user: { id: "owner" }, session: { id: "session" } }
              : null,
        }),
        verifyApiKey: async ({ body }: { body: { key: string } }) => ({
          valid: body.key === "app_readonly",
          key: { id: "key_readonly", permissions: { "demo.record": ["read"] } },
        }),
      },
    } as never);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof AppError) return errorResponse(c, error);
    throw error;
  });
  app.route("/", mcpDiscoveryRoutes);
  app.route("/oauth", mcpOAuthRoutes);
  app.route("/mcp", mcpRoutes);
  const protectedRoutes = new Hono<HonoEnv>();
  protectedRoutes.use("*", requirePrincipal, enforceCookieOrigin);
  protectedRoutes.route("/", mcpSettingsRoutes);
  protectedRoutes.route("/", mcpConsentRoutes);
  app.route("/api/v1", protectedRoutes);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`${origin}${path}`, init, env);
  const rpc = async (
    method: string,
    params: unknown = {},
    headers = cookieHeaders,
  ) =>
    request("/mcp", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const settings = async (enabled: boolean, allowedActions: string[]) =>
    request("/api/v1/plugins/demo/mcp", {
      method: "PUT",
      headers: { ...cookieHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, allowedActions }),
    });
  return { sqlite, request, rpc, settings, pluginFetch };
}

describe("MCP authorization and persistence", () => {
  it("starts closed and preserves selected actions across disable, update and re-enable", async () => {
    const f = await fixture();
    expect((await (await f.rpc("tools/list")).json()).result.tools).toEqual([]);
    expect((await f.settings(true, ["demo_list"])).status).toBe(200);
    expect(
      (await (await f.rpc("tools/list")).json()).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(["demo_list"]);
    f.sqlite.exec("UPDATE plugins SET installed_version = '1.0.1'");
    expect(
      (
        await (
          await f.request("/api/v1/plugins/demo/mcp", {
            headers: cookieHeaders,
          })
        ).json()
      ).enabled,
    ).toBe(true);
    await f.settings(false, ["demo_list"]);
    expect((await (await f.rpc("tools/list")).json()).result.tools).toEqual([]);
    await f.settings(true, ["demo_list"]);
    f.sqlite.exec("UPDATE plugins SET status = 'disabled'");
    expect((await (await f.rpc("tools/list")).json()).result.tools).toEqual([]);
    f.sqlite.exec("UPDATE plugins SET status = 'installed'");
    expect(
      (await (await f.rpc("tools/list")).json()).result.tools,
    ).toHaveLength(1);
    expect((await f.settings(true, ["not_declared"])).status).toBe(422);
  });
  it("intersects API-key scopes with plugin actions and delegates no credentials", async () => {
    const f = await fixture();
    await f.settings(true, ["demo_list", "demo_create"]);
    const headers = {
      Authorization: "Bearer app_readonly",
    } as typeof cookieHeaders;
    const listed = await (await f.rpc("tools/list", {}, headers)).json();
    expect(
      listed.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["demo_list"]);
    const denied = await (
      await f.rpc(
        "tools/call",
        {
          name: "demo_create",
          arguments: {
            body: { name: "Test" },
            idempotencyKey: "mcp-request-123456",
          },
        },
        headers,
      )
    ).json();
    expect(denied.error.code).toBe(-32602);
    expect(f.pluginFetch).not.toHaveBeenCalled();
    const called = await (
      await f.rpc("tools/call", { name: "demo_list" }, headers)
    ).json();
    expect(JSON.parse(called.result.content[0].text).permissions).toEqual([
      "demo.record.read",
    ]);
    expect(f.pluginFetch).toHaveBeenCalledOnce();
    f.sqlite.exec("UPDATE groups SET is_admin = 0");
    expect(
      (await (await f.rpc("tools/list", {}, headers)).json()).result.tools,
    ).toEqual([]);
    expect(f.pluginFetch).toHaveBeenCalledOnce();
  });
  it("validates arguments, blocks unsafe paths, rechecks revocations and reuses POST idempotency", async () => {
    const f = await fixture();
    await f.settings(true, ["demo_create", "demo_delete"]);
    expect(
      (
        await (
          await f.rpc("tools/call", {
            name: "demo_create",
            arguments: { body: { name: "x" } },
          })
        ).json()
      ).result.isError,
    ).toBe(true);
    expect(
      (
        await (
          await f.rpc("tools/call", {
            name: "demo_delete",
            arguments: { path: { recordId: ".." } },
          })
        ).json()
      ).result.isError,
    ).toBe(true);
    const args = {
      name: "demo_create",
      arguments: {
        body: { name: "Test" },
        idempotencyKey: "mcp-request-123456",
      },
    };
    expect(
      (await (await f.rpc("tools/call", args)).json()).result.isError,
    ).toBe(false);
    expect(
      (await (await f.rpc("tools/call", args)).json()).result.isError,
    ).toBe(false);
    expect(f.pluginFetch).toHaveBeenCalledOnce();
    await f.settings(false, []);
    expect((await (await f.rpc("tools/call", args)).json()).error.code).toBe(
      -32602,
    );
    expect(f.pluginFetch).toHaveBeenCalledOnce();
    const audit = f.sqlite.prepare("SELECT metadata_json FROM audit_log").all();
    expect(JSON.stringify(audit)).not.toContain("mcp-request-123456");
    expect(JSON.stringify(audit)).not.toContain('"name":"Test"');
  });
  it("exposes discovery and a standards-compatible stateless transport", async () => {
    const f = await fixture();
    const unauthenticated = await f.request("/mcp", { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")).toContain(
      "oauth-protected-resource/mcp",
    );
    expect(
      (
        await (
          await f.request("/.well-known/oauth-authorization-server")
        ).json()
      ).code_challenge_methods_supported,
    ).toEqual(["S256"]);
    expect(
      (
        await (
          await f.rpc("initialize", { protocolVersion: "2025-06-18" })
        ).json()
      ).result.protocolVersion,
    ).toBe("2025-06-18");
    expect((await f.request("/mcp", { headers: cookieHeaders })).status).toBe(
      405,
    );
    expect(
      (
        await f.rpc(
          "ping",
          {},
          { ...cookieHeaders, Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request("/mcp", {
          method: "POST",
          headers: { ...cookieHeaders, "Content-Type": "application/json" },
          body: "[1,2]",
        })
      ).status,
    ).toBe(400);
  });
  it("runs PKCE consent, single-use codes, refresh rotation, scope snapshots and revocation", async () => {
    const f = await fixture();
    await f.settings(true, ["demo_list"]);
    const client = await (
      await f.request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test assistant",
          redirect_uris: ["http://127.0.0.1:8123/callback"],
        }),
      })
    ).json();
    const verifier = "v".repeat(43);
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    const auth = {
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
      scope: "mcp:tools",
      state: "expected-state",
    };
    const authorize = async (input = auth, approve = true) =>
      f.request("/api/v1/mcp/oauth/authorize", {
        method: "POST",
        headers: { ...cookieHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ request: input, approve }),
      });
    expect(
      (await authorize({ ...auth, redirect_uri: "https://evil.example/cb" }))
        .status,
    ).toBe(400);
    const refused = new URL(
      (await (await authorize(auth, false)).json()).redirect,
    );
    expect(refused.searchParams.get("error")).toBe("access_denied");
    const redirect = new URL((await (await authorize()).json()).redirect);
    expect(redirect.searchParams.get("state")).toBe("expected-state");
    const tokenForm = {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: auth.redirect_uri,
      resource: auth.resource,
      code: redirect.searchParams.get("code")!,
      code_verifier: verifier,
    };
    const token = (form: Record<string, string>) =>
      f.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
    expect(
      (await token({ ...tokenForm, code_verifier: "x".repeat(43) })).status,
    ).toBe(400);
    const granted = await (await token(tokenForm)).json();
    expect(granted.token_type).toBe("Bearer");
    expect((await token(tokenForm)).status).toBe(400);
    await f.settings(true, ["demo_list", "demo_create"]);
    const bearerHeaders = {
      Authorization: `Bearer ${granted.access_token}`,
    } as typeof cookieHeaders;
    expect(
      (
        await (await f.rpc("tools/list", {}, bearerHeaders)).json()
      ).result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["demo_list"]);
    const refreshForm = {
      grant_type: "refresh_token",
      client_id: client.client_id,
      resource: auth.resource,
      refresh_token: granted.refresh_token,
    };
    const renewed = await (await token(refreshForm)).json();
    expect(renewed.access_token).not.toBe(granted.access_token);
    expect((await token(refreshForm)).status).toBe(400);
    expect((await f.rpc("tools/list", {}, bearerHeaders)).status).toBe(401);
    const connections = await (
      await f.request("/api/v1/me/mcp-connections", { headers: cookieHeaders })
    ).json();
    expect(connections.items).toHaveLength(1);
    await f.request(`/api/v1/me/mcp-connections/${connections.items[0].id}`, {
      method: "DELETE",
      headers: cookieHeaders,
    });
    expect(
      (
        await f.rpc("tools/list", {}, {
          Authorization: `Bearer ${renewed.access_token}`,
        } as typeof cookieHeaders)
      ).status,
    ).toBe(401);
    const stored = JSON.stringify(
      f.sqlite.prepare("SELECT * FROM mcp_oauth_grants").all(),
    );
    expect(stored).not.toContain(renewed.access_token);
    expect(stored).not.toContain(renewed.refresh_token);
  });
});

describe("MCP declarations", () => {
  it("treats explicit action declarations as authoritative over legacy metadata", () => {
    const source = {
      paths: {
        "/api/v1/p/demo/records": {
          get: { "x-nexus-mcp": declaration("list", "demo.record.read") },
        },
        "/api/v1/p/demo/private-file": {
          get: {
            operationId: "download",
            "x-required-permissions": ["demo.record.read"],
            responses: {
              200: { description: "Private binary stream" },
              400: { content: { "application/json": {} } },
            },
          },
        },
      },
    };
    expect(
      actionsFromOpenApi("demo", permissions, source).map(
        (action) => action.name,
      ),
    ).toEqual(["demo_list"]);
  });
  it("adapts published permission extensions without exposing public or binary routes", () => {
    const source = {
      paths: {
        "/api/v1/p/demo/records": {
          get: {
            operationId: "list_records",
            "x-nexus-permission": "demo.record.read",
          },
        },
        "/api/v1/p/demo/download": {
          get: {
            operationId: "download",
            "x-nexus-permission": "demo.record.read",
            responses: {
              200: { content: { "application/octet-stream": {} } },
              400: { content: { "application/json": {} } },
            },
          },
        },
        "/api/v1/p/demo/upload": {
          post: {
            operationId: "upload",
            "x-nexus-permission": "demo.record.create",
            requestBody: { content: { "audio/webm": {} } },
          },
        },
        "/api/v1/public/p/demo/webhook": {
          post: {
            operationId: "webhook",
            "x-nexus-permission": "demo.record.create",
          },
        },
      },
    };
    expect(
      actionsFromOpenApi("demo", permissions, source).map(
        (action) => action.name,
      ),
    ).toEqual(["demo_list_records"]);
  });
  it("requires explicit actions, permissions and JSON schemas; excludes public routes", () => {
    const actions = actionsFromOpenApi("demo", permissions, document);
    expect(actions).toHaveLength(3);
    expect(() => actionsFromOpenApi("demo", [], document)).toThrow();
    expect(() =>
      actionRequest(
        actions.find((action) => action.name === "demo_delete")!,
        { path: { recordId: "%2e%2e" } },
      ),
    ).toThrow();
  });
  it.each([
    "https://client.example/callback",
    "http://127.0.0.1:9876/cb",
    "http://localhost:1234/cb",
  ])("accepts a secure or loopback redirect %s", (redirect) =>
    expect(validRedirect(redirect)).toBe(true),
  );
  it.each([
    "http://client.example/cb",
    "https://user:secret@client.example/cb",
    "javascript:alert(1)",
    "https://client.example/cb#fragment",
  ])("rejects an unsafe redirect %s", (redirect) =>
    expect(validRedirect(redirect)).toBe(false),
  );
});
