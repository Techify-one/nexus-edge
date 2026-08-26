import { afterEach, describe, expect, it, vi } from "vitest";
import { installerReleaseSchema } from "@app/installer-release-schema";
import { deployCoreUpdate } from "../workers/core/src/installer/cloudflare.js";
import type { CoreEnv } from "../workers/core/src/env.js";
import type { VerifiedCoreArchive } from "../workers/core/src/updates/release.js";

const release = installerReleaseSchema.parse({
  schemaVersion: 1,
  appVersion: "1.1.0-beta.2",
  sourceCommit: "a".repeat(40),
  createdAt: "2026-08-26T12:00:00.000Z",
  compatibilityDate: "2026-08-21",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "index.js",
  modules: [
    {
      path: "index.js",
      objectKey: "releases/1.1.0-beta.2/modules/index",
      mimeType: "application/javascript+module",
      size: 1,
      sha256: "a".repeat(64),
    },
  ],
  assets: [
    {
      path: "index.html",
      objectKey: "releases/1.1.0-beta.2/assets/index",
      mimeType: "text/html; charset=utf-8",
      size: 1,
      sha256: "b".repeat(64),
      uploadHash: "b".repeat(32),
    },
  ],
  d1Migrations: [
    {
      id: "0001_init",
      path: "migrations/d1/0001_init.json",
      objectKey: "releases/1.1.0-beta.2/migrations/d1/0001_init.json",
      mimeType: "application/json",
      size: 1,
      sha256: "c".repeat(64),
      statementCount: 1,
    },
  ],
  requiredBindings: ["ASSETS", "DB", "WEBHOOK_QUEUE"],
  cron: ["* * * * *"],
  healthChecks: ["/health"],
  minimumInstallerVersion: "1.0.0",
});

afterEach(() => vi.unstubAllGlobals());

describe("Core self deployment", () => {
  it("uses strict inheritance and preserves dynamic bindings and secrets", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/settings"))
          return Response.json({
            success: true,
            result: {
              bindings: [
                { type: "assets", name: "ASSETS" },
                { type: "d1", name: "DB" },
                { type: "queue", name: "WEBHOOK_QUEUE" },
                { type: "secret_text", name: "BETTER_AUTH_SECRET" },
                { type: "secret_text", name: "WEBHOOK_ENCRYPTION_KEY" },
                { type: "service", name: "PLUGIN_CRM" },
                { type: "plain_text", name: "APP_VERSION" },
              ],
            },
          });
        if (url.endsWith("/assets-upload-session"))
          return Response.json({
            success: true,
            result: { buckets: [], jwt: "asset-session" },
          });
        if (url.includes("bindings_inherit=strict") && init?.method === "PUT")
          return Response.json({ success: true, result: { id: "core" } });
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const archive = {
      object: () => new Uint8Array([1]),
      migration: () => {
        throw new Error("not used");
      },
    } as VerifiedCoreArchive;

    await deployCoreUpdate(
      {
        CF_API_TOKEN: "runtime-token",
        CF_ACCOUNT_ID: "a".repeat(32),
        CORE_WORKER_NAME: "nexus-edge-core",
      } as CoreEnv,
      release,
      archive,
    );

    const upload = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("bindings_inherit=strict"),
    );
    expect(upload).toBeDefined();
    const form = upload?.[1]?.body as FormData;
    const metadata = JSON.parse(
      await (form.get("metadata") as Blob).text(),
    ) as { bindings: Array<{ type: string; name: string; text?: string }> };
    expect(metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "inherit", name: "DB" },
        { type: "inherit", name: "WEBHOOK_QUEUE" },
        { type: "inherit", name: "BETTER_AUTH_SECRET" },
        { type: "inherit", name: "WEBHOOK_ENCRYPTION_KEY" },
        { type: "inherit", name: "PLUGIN_CRM" },
        { type: "assets", name: "ASSETS" },
        {
          type: "plain_text",
          name: "APP_VERSION",
          text: "1.1.0-beta.2",
        },
      ]),
    );
    expect(JSON.stringify(metadata)).not.toContain("runtime-token");
  });
});
