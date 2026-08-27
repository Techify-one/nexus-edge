import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  installerReleaseSchema,
  isWorkerModuleContentType,
  splitSqlStatements,
  staticAssetContentType,
  verifyReleaseSignature,
  verifyReleaseSignatureWithKeys,
  workerModuleContentType,
  type InstallerRelease,
} from "@app/installer-release-schema";

const release = installerReleaseSchema.parse({
  schemaVersion: 1,
  appVersion: "1.0.0",
  sourceCommit: "a".repeat(40),
  createdAt: "2026-08-26T00:00:00.000Z",
  compatibilityDate: "2026-08-21",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "index.js",
  modules: [
    {
      path: "index.js",
      objectKey: "releases/1.0.0/modules/a",
      mimeType: "application/javascript+module",
      size: 1,
      sha256: "a".repeat(64),
    },
  ],
  assets: [
    {
      path: "index.html",
      objectKey: "releases/1.0.0/assets/b",
      mimeType: "text/html",
      size: 1,
      sha256: "b".repeat(64),
      uploadHash: "b".repeat(32),
    },
  ],
  d1Migrations: [
    {
      id: "0001_init",
      path: "migrations/d1/0001_init.json",
      objectKey: "releases/1.0.0/migrations/d1/0001_init.json",
      mimeType: "application/json",
      size: 1,
      sha256: "c".repeat(64),
      statementCount: 1,
    },
  ],
  databaseSchemaVersion: 1,
  requiredBindings: ["ASSETS", "DB", "WEBHOOK_QUEUE"],
  cron: ["* * * * *"],
  healthChecks: ["/health", "/api/v1/setup/status"],
  minimumInstallerVersion: "1.0.0",
}) satisfies InstallerRelease;

describe("installer release contract", () => {
  it("packages the current Vite Core environment, never the obsolete bundle", () => {
    const repositoryRoot = resolve(import.meta.dirname, "..");
    for (const path of [
      "scripts/build-installer-release.ts",
      "scripts/direct-deploy.mjs",
    ]) {
      const source = readFileSync(resolve(repositoryRoot, path), "utf8");
      expect(source).toContain("frontend/dist/nexus_edge_core");
      expect(source).not.toContain("frontend/dist/app_core");
    }
  });

  it("keeps legacy signed manifests unchanged when schema version is absent", () => {
    const { databaseSchemaVersion: _databaseSchemaVersion, ...legacy } =
      release;
    const parsed = installerReleaseSchema.parse(legacy);

    expect(parsed.databaseSchemaVersion).toBeUndefined();
    expect(canonicalJson(parsed)).toBe(canonicalJson(legacy));
  });

  it("canonicalizes object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"d":2},"z":1}',
    );
  });

  it("splits SQL without breaking quoted semicolons", () => {
    expect(
      splitSqlStatements(
        "-- comment\nCREATE TABLE x(v TEXT); INSERT INTO x VALUES ('a;b');",
      ),
    ).toEqual(["CREATE TABLE x(v TEXT)", "INSERT INTO x VALUES ('a;b')"]);
  });

  it("includes only Cloudflare-supported Worker module content types", () => {
    expect(workerModuleContentType("index.js")).toBe(
      "application/javascript+module",
    );
    expect(workerModuleContentType("module.wasm")).toBe("application/wasm");
    expect(workerModuleContentType("wrangler.json")).toBeUndefined();
    expect(isWorkerModuleContentType("application/javascript+module")).toBe(
      true,
    );
    expect(isWorkerModuleContentType("application/json")).toBe(false);
  });

  it("keeps Worker module MIME separate from browser asset MIME", () => {
    expect(workerModuleContentType("index.js")).toBe(
      "application/javascript+module",
    );
    expect(staticAssetContentType("assets/index.js")).toBe("text/javascript");
    expect(staticAssetContentType("assets/chunk.mjs")).toBe("text/javascript");
  });

  it("verifies an Ed25519 signature over the canonical manifest hash", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(release)),
    );
    const signature = sign(null, Buffer.from(digest), privateKey).toString(
      "base64",
    );
    const spki = publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    await expect(
      verifyReleaseSignature(release, signature, spki),
    ).resolves.toBe(true);
    await expect(
      verifyReleaseSignature(
        { ...release, appVersion: "1.0.1" },
        signature,
        spki,
      ),
    ).resolves.toBe(false);
  });

  it("accepts either configured key during an installer signing-key rotation", async () => {
    const previous = generateKeyPairSync("ed25519");
    const next = generateKeyPairSync("ed25519");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(release)),
    );
    const signature = sign(null, Buffer.from(digest), next.privateKey).toString(
      "base64",
    );
    const keys = [previous.publicKey, next.publicKey].map((key) =>
      key.export({ type: "spki", format: "der" }).toString("base64"),
    );

    await expect(
      verifyReleaseSignatureWithKeys(release, signature, keys),
    ).resolves.toBe(true);
    await expect(
      verifyReleaseSignatureWithKeys(release, signature, [keys[0]!]),
    ).resolves.toBe(false);
  });
});
