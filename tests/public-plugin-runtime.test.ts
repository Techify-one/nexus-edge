import { strToU8 } from "fflate";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DatabasePort } from "../packages/database/src/index.js";
import { sha256 } from "../packages/webhook-contract/src/index.js";
import type { HonoEnv } from "../workers/core/src/env.js";
import { publicPluginRuntimeRoutes } from "../workers/core/src/routes/plugin-runtime.js";

const releaseHash = "r".repeat(43);
const entry = strToU8("export default { mountPublicPage(){} };");
const manifest = {
  manifestVersion: 2,
  packageFormat: 2,
  id: "unknown_plugin",
  name: "Unknown plugin",
  publisher: { id: "unknown_publisher", name: "Unknown Publisher" },
  version: "1.0.0",
  apiVersion: 1,
  coreMinVersion: "1.0.0",
  compatibilityDate: "2026-09-08",
  compatibilityFlags: ["nodejs_compat"],
  databaseDialects: ["d1"],
  engines: { hostApi: 1, coreApi: 1 },
  frontend: {
    entry: "frontend/entry.js",
    styles: [],
    isolation: "shadow",
    routes: [
      { routeKey: "unknown_plugin.home", path: "/app/p/unknown_plugin" },
    ],
    publicRoutes: [
      { routeKey: "unknown_plugin.share", path: "/shared/unknown/:token" },
    ],
  },
  tablePrefix: "unknown_plugin_",
  permissions: [],
  menu: [],
};

const appWithDatabase = (database: DatabasePort) => {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req_public_runtime");
    c.set("db", database);
    await next();
  });
  app.route("/api/v1/public", publicPluginRuntimeRoutes);
  return app;
};

describe("public plugin page runtime", () => {
  it("discovers an unknown installed plugin route from its manifest", async () => {
    const database = {
      provider: "d1",
      orm: {},
      query: async () => [
        {
          id: manifest.id,
          name: manifest.name,
          installedVersion: manifest.version,
          manifest: JSON.stringify(manifest),
          releaseHash,
        },
      ],
      first: async () => null,
      execute: async () => ({ rowsAffected: 0 }),
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;
    const response = await appWithDatabase(database).request(
      "/api/v1/public/plugin-runtime?path=%2Fshared%2Funknown%2Ftoken-1",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      hostApi: 1,
      plugin: {
        pluginId: "unknown_plugin",
        route: { routeKey: "unknown_plugin.share" },
        entryUrl: `/api/v1/public/plugin-assets/unknown_plugin/${releaseHash}/frontend/entry.js`,
      },
    });
  });

  it("serves only integrity-checked frontend assets for a public plugin", async () => {
    const digest = await sha256(entry);
    const encoded = Buffer.from(entry).toString("base64url");
    const database = {
      provider: "d1",
      orm: {},
      query: async () => [{ chunkIndex: 0, content: `base64:${encoded}` }],
      first: async () => ({
        contentType: "application/javascript+module",
        operationId: "pop_public_runtime",
        sha256: digest,
        byteLength: entry.byteLength,
        manifest: JSON.stringify(manifest),
      }),
      execute: async () => ({ rowsAffected: 0 }),
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;
    const response = await appWithDatabase(database).request(
      `/api/v1/public/plugin-assets/unknown_plugin/${releaseHash}/frontend/entry.js`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(new TextDecoder().decode(entry));
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });
});
