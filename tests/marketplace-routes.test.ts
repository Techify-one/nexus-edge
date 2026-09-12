import { createMongoAbility } from "@casl/ability";
import type { DatabasePort, SqlStatement } from "@app/database";
import {
  base64url,
  stableJson,
} from "../packages/webhook-contract/src/index.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreEnv, HonoEnv } from "../workers/core/src/env.js";
import { AppError } from "../workers/core/src/lib/http.js";
import { marketplacesRoutes } from "../workers/core/src/routes/marketplaces.js";

afterEach(() => vi.restoreAllMocks());

describe("marketplace routes", () => {
  it("pins the first valid signing key and completes sync without manual trust", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = base64url(
      new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    );
    const unsigned = {
      catalogVersion: 1 as const,
      name: "Techfire Plugins",
      revision: "revision-1",
      publisher: {
        id: "techfire",
        name: "Techfire",
        keyId: "techfire-v1",
        publicKey,
      },
      plugins: [],
    };
    const catalog = {
      ...unsigned,
      signature: {
        algorithm: "Ed25519" as const,
        keyId: "techfire-v1",
        value: base64url(
          new Uint8Array(
            await crypto.subtle.sign(
              "Ed25519",
              keys.privateKey,
              new TextEncoder().encode(stableJson(unsigned)),
            ),
          ),
        ),
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(catalog)),
    );

    const atomicStatements: SqlStatement[] = [];
    const source = {
      id: "mkt_techfire",
      name: "Techfire Plugins",
      owner: "Techify-one",
      repository: "nexus-edge-plugins",
      repositoryId: null,
      sourceRef: "main",
      catalogPath: "nexus-marketplace.json",
      enabled: true,
      isDefault: true,
      trustState: "pending",
      trustedPublicKey: null,
      keyFingerprint: null,
      etag: null,
      retryAfterAt: null,
      lastSyncedAt: null,
      lastErrorCode: null,
      removedAt: null,
    };
    const db: DatabasePort = {
      provider: "d1",
      orm: {},
      query: async <T extends Record<string, unknown>>() => [] as T[],
      first: async <T extends Record<string, unknown>>(sql: string) =>
        (sql.includes("FROM plugin_marketplaces") ? source : null) as T | null,
      execute: async () => ({ rowsAffected: 1 }),
      atomic: async (statements) => {
        atomicStatements.push(...statements);
        return statements.map(() => ({ rowsAffected: 1 }));
      },
      close: async () => undefined,
    };
    const app = new Hono<HonoEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "req_marketplace_test");
      context.set("db", db);
      context.set("principal", {
        userId: "usr_admin",
        authMethod: "cookie",
      });
      context.set(
        "ability",
        createMongoAbility<[string, string]>([
          { action: "manage", subject: "all" },
        ]),
      );
      await next();
    });
    app.route("/", marketplacesRoutes);
    app.onError((error, context) =>
      context.json(
        { code: error instanceof AppError ? error.code : "UNEXPECTED" },
        error instanceof AppError ? error.status : 500,
      ),
    );

    const response = await app.request(
      "/plugin-marketplaces/mkt_techfire/sync",
      { method: "POST" },
      {
        APP_VERSION: "1.1.0-beta.10",
        DATABASE_PROVIDER: "d1",
        PLUGIN_COMPATIBILITY_FLAGS: "nodejs_compat",
      } as CoreEnv,
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      id: "mkt_techfire",
      revision: "revision-1",
      plugins: 0,
    });
    expect(result).not.toHaveProperty("requiresTrust");
    expect(atomicStatements).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining("trusted_public_key = ?"),
        params: expect.arrayContaining([publicKey, "mkt_techfire"]),
      }),
    );
    expect(atomicStatements).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining("plugin_marketplace_keys"),
        params: expect.arrayContaining(["techfire-v1", publicKey]),
      }),
    );
  });

  it("rejects downloading a marketplace version that is already installed", async () => {
    const db: DatabasePort = {
      provider: "d1",
      orm: {},
      query: async <T extends Record<string, unknown>>() => [] as T[],
      first: async <T extends Record<string, unknown>>(sql: string) => {
        if (sql.includes("FROM plugin_releases"))
          return {
            id: "rel_meta_ads",
            pluginId: "meta_ads",
            version: "2.0.0",
            artifactUrl:
              "https://github.com/Techify-one/nexus-edge-plugins/releases/download/meta_ads-v2.0.0/meta_ads.plugin.zip",
            manifest: {},
            artifactSha256: "x".repeat(43),
            artifactSignature: "x".repeat(86),
            packageBytes: 1024,
            owner: "Techify-one",
            repository: "nexus-edge-plugins",
            publicKey: "x".repeat(43),
            compatible: true,
            enabled: true,
            channel: "stable",
            trustState: "trusted",
            catalogExpiresAt: Date.now() + 60_000,
          } as T;
        if (sql.includes("FROM plugins"))
          return { version: "2.0.0", status: "installed" } as T;
        return null;
      },
      execute: async () => ({ rowsAffected: 1 }),
      atomic: async (statements) => statements.map(() => ({ rowsAffected: 1 })),
      close: async () => {},
    };
    const app = new Hono<HonoEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "req_marketplace_duplicate");
      context.set("db", db);
      context.set("principal", {
        userId: "usr_admin",
        authMethod: "cookie",
      });
      context.set(
        "ability",
        createMongoAbility<[string, string]>([
          { action: "manage", subject: "all" },
        ]),
      );
      await next();
    });
    app.route("/", marketplacesRoutes);
    app.onError((error, context) =>
      context.json(
        { code: error instanceof AppError ? error.code : "UNEXPECTED" },
        error instanceof AppError ? error.status : 500,
      ),
    );

    const response = await app.request(
      "/plugin-catalog/rel_meta_ads/package",
      { method: "POST" },
      { DATABASE_PROVIDER: "d1" } as CoreEnv,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "PLUGIN_ALREADY_INSTALLED",
    });
  });
});
