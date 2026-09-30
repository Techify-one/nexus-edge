import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  installerReleaseSchema,
} from "@app/installer-release-schema";
import type { CoreEnv } from "../workers/core/src/env.js";
import { discoverLatestCoreRelease } from "../workers/core/src/updates/release.js";

const hex = (character: string, length: number) => character.repeat(length);

const manifest = installerReleaseSchema.parse({
  schemaVersion: 1,
  appVersion: "1.1.0-beta.2",
  sourceCommit: hex("a", 40),
  createdAt: "2026-08-26T12:00:00.000Z",
  compatibilityDate: "2026-08-21",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "index.js",
  modules: [
    {
      path: "index.js",
      objectKey: "releases/1.1.0-beta.2/modules/a",
      mimeType: "application/javascript+module",
      size: 1,
      sha256: hex("a", 64),
    },
  ],
  assets: [
    {
      path: "index.html",
      objectKey: "releases/1.1.0-beta.2/assets/b",
      mimeType: "text/html; charset=utf-8",
      size: 1,
      sha256: hex("b", 64),
      uploadHash: hex("b", 32),
    },
  ],
  d1Migrations: [
    {
      id: "0001_init",
      path: "migrations/d1/0001_init.json",
      objectKey: "releases/1.1.0-beta.2/migrations/d1/0001_init.json",
      mimeType: "application/json",
      size: 1,
      sha256: hex("c", 64),
      statementCount: 1,
    },
  ],
  requiredBindings: ["ASSETS", "DB", "WEBHOOK_QUEUE"],
  cron: ["* * * * *"],
  healthChecks: ["/health"],
  minimumInstallerVersion: "1.0.0",
});

const releaseUrl = "https://github.com/Techify-one/nexus-edge/releases";

function fixture(signature: string, version = "1.1.0-beta.2") {
  const download = `${releaseUrl}/download/nexus-v${version}`;
  return {
    id: 42,
    tag_name: `nexus-v${version}`,
    name: "Beta 2",
    body: "Notas seguras",
    html_url: `${releaseUrl}/tag/nexus-v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    published_at: "2026-08-26T12:00:00Z",
    assets: [
      {
        name: "nexus-edge-release.json",
        size: canonicalJson(manifest).length,
        browser_download_url: `${download}/nexus-edge-release.json`,
      },
      {
        name: "nexus-edge-release.sig",
        size: signature.length,
        browser_download_url: `${download}/nexus-edge-release.sig`,
      },
      {
        name: "nexus-edge-update.zip",
        size: 100,
        browser_download_url: `${download}/nexus-edge-update.zip`,
      },
    ],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("signed GitHub Core updates", () => {
  it("accepts a correctly signed beta from the fixed repository", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const digest = createHash("sha256")
      .update(canonicalJson(manifest))
      .digest();
    const signature = sign(null, digest, privateKey).toString("base64");
    const githubRelease = fixture(signature);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/"))
          return Response.json([githubRelease]);
        if (url.endsWith("nexus-edge-release.json"))
          return new Response(`${canonicalJson(manifest)}\n`);
        if (url.endsWith("nexus-edge-release.sig"))
          return new Response(`${signature}\n`);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const result = await discoverLatestCoreRelease({
      APP_VERSION: "1.1.0-beta.1",
      CORE_UPDATE_PUBLIC_KEY: publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    } as CoreEnv);
    expect(result).toMatchObject({
      releaseId: "42",
      tag: "nexus-v1.1.0-beta.2",
      manifest: { appVersion: "1.1.0-beta.2" },
    });
  });

  it("rejects a release signed by a different key", async () => {
    const trusted = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const digest = createHash("sha256")
      .update(canonicalJson(manifest))
      .digest();
    const signature = sign(null, digest, attacker.privateKey).toString(
      "base64",
    );
    const githubRelease = fixture(signature);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/"))
          return Response.json([githubRelease]);
        if (url.endsWith("nexus-edge-release.json"))
          return new Response(canonicalJson(manifest));
        if (url.endsWith("nexus-edge-release.sig"))
          return new Response(signature);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    await expect(
      discoverLatestCoreRelease({
        APP_VERSION: "1.1.0-beta.1",
        CORE_UPDATE_PUBLIC_KEY: trusted.publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
      } as CoreEnv),
    ).rejects.toThrow("UPDATE_RELEASE_SIGNATURE_INVALID");
  });
  const stubGitHub = (
    releases: unknown[],
    signedManifest: typeof manifest,
    signature: string,
  ) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/"))
          return Response.json(releases);
        if (url.endsWith("nexus-edge-release.json"))
          return new Response(canonicalJson(signedManifest));
        if (url.endsWith("nexus-edge-release.sig"))
          return new Response(signature);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
  const signed = (version: string) => {
    const keys = generateKeyPairSync("ed25519");
    const versioned = installerReleaseSchema.parse({
      ...manifest,
      appVersion: version,
    });
    const digest = createHash("sha256")
      .update(canonicalJson(versioned))
      .digest();
    return {
      versioned,
      signature: sign(null, digest, keys.privateKey).toString("base64"),
      publicKey: keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    };
  };

  it("offers a stable release to a beta installation", async () => {
    const { versioned, signature, publicKey } = signed("1.1.0");
    stubGitHub([fixture(signature, "1.1.0")], versioned, signature);
    const result = await discoverLatestCoreRelease({
      APP_VERSION: "1.1.0-beta.14",
      CORE_UPDATE_PUBLIC_KEY: publicKey,
    } as CoreEnv);
    expect(result).toMatchObject({
      tag: "nexus-v1.1.0",
      manifest: { appVersion: "1.1.0" },
    });
  });

  it("ranks a stable release above the beta it follows", async () => {
    const { versioned, signature, publicKey } = signed("1.1.0");
    stubGitHub(
      [fixture(signature, "1.1.0-beta.9"), fixture(signature, "1.1.0")],
      versioned,
      signature,
    );
    const result = await discoverLatestCoreRelease({
      APP_VERSION: "1.1.0-beta.8",
      CORE_UPDATE_PUBLIC_KEY: publicKey,
    } as CoreEnv);
    expect(result?.tag).toBe("nexus-v1.1.0");
  });

  it("keeps a stable installation on the stable channel", async () => {
    const { versioned, signature, publicKey } = signed("1.2.0-beta.1");
    stubGitHub([fixture(signature, "1.2.0-beta.1")], versioned, signature);
    await expect(
      discoverLatestCoreRelease({
        APP_VERSION: "1.1.0",
        CORE_UPDATE_PUBLIC_KEY: publicKey,
      } as CoreEnv),
    ).resolves.toBeNull();
  });

  it("rejects a release whose prerelease flag disagrees with its version", async () => {
    const { versioned, signature, publicKey } = signed("1.1.0");
    const mislabeled = { ...fixture(signature, "1.1.0"), prerelease: true };
    stubGitHub([mislabeled], versioned, signature);
    await expect(
      discoverLatestCoreRelease({
        APP_VERSION: "1.1.0-beta.14",
        CORE_UPDATE_PUBLIC_KEY: publicKey,
      } as CoreEnv),
    ).resolves.toBeNull();
  });
});
