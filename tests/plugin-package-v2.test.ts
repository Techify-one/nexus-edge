import { zipSync, strToU8, unzipSync } from "fflate";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildPluginPackage } from "../packages/plugin-sdk/src/package.js";
import { generatePluginMarketplace } from "../packages/plugin-sdk/src/marketplace.js";
import { sha256, stableJson } from "../packages/webhook-contract/src/index.js";
import {
  marketplaceCatalogSchema,
  verifyCatalogSignature,
  verifyReleaseArtifact,
} from "../workers/core/src/installer/marketplace.js";
import { pluginManifestSchema } from "../workers/core/src/installer/manifest.js";
import { parsePluginArchive } from "../workers/core/src/installer/package-v2.js";

const encoded = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const manifest = pluginManifestSchema.parse({
  manifestVersion: 2,
  packageFormat: 2,
  id: "external_demo",
  name: "External demo",
  description: "A plugin unknown to the Core build.",
  publisher: { id: "demo_publisher", name: "Demo Publisher" },
  version: "1.2.3",
  apiVersion: 1,
  coreMinVersion: "1.0.0",
  compatibilityDate: "2026-09-08",
  compatibilityFlags: ["nodejs_compat"],
  databaseDialects: ["d1", "postgres"],
  engines: { hostApi: 1, coreApi: 1 },
  frontend: {
    entry: "frontend/entry.js",
    styles: ["frontend/styles.css"],
    isolation: "shadow",
    routes: [{ routeKey: "external_demo.home", path: "/app/p/external_demo" }],
    publicRoutes: [
      {
        routeKey: "external_demo.shared",
        path: "/shared/external-demo/:token",
      },
    ],
  },
  resources: [
    {
      name: "state",
      type: "durable_object",
      binding: "STATE",
      required: true,
      retention: "preserve",
      configuration: { className: "PluginState", storage: "sqlite" },
    },
    {
      name: "nightly",
      type: "cron",
      binding: "NIGHTLY",
      configuration: { schedules: ["0 3 * * *"] },
    },
  ],
  tablePrefix: "external_demo_",
  permissions: ["external_demo.item.read"],
  menu: [
    {
      title: "External demo",
      routeKey: "external_demo.home",
      path: "/app/p/external_demo",
    },
  ],
});

const contentType = (path: string): string =>
  path.endsWith(".json")
    ? "application/json"
    : path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".sql")
        ? "text/plain"
        : "application/javascript+module";

const packageArchive = async (): Promise<Uint8Array> => {
  const payload: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "backend/worker.mjs": strToU8(
      "export class PluginState {}; export default {}",
    ),
    "frontend/entry.js": strToU8(
      "export default { mountPage(){ return { dispose(){} } } }",
    ),
    "frontend/styles.css": strToU8(":host{display:block}"),
    "migrations/d1/0001_init.sql": strToU8(
      "CREATE TABLE IF NOT EXISTS external_demo_items (id TEXT PRIMARY KEY);",
    ),
    "migrations/postgres/0001_init.sql": strToU8(
      "CREATE TABLE IF NOT EXISTS external_demo_items (id TEXT PRIMARY KEY);",
    ),
  };
  const integrity = {
    algorithm: "sha256" as const,
    files: Object.fromEntries(
      await Promise.all(
        Object.entries(payload).map(async ([path, bytes]) => [
          path,
          {
            sha256: await sha256(bytes),
            size: bytes.byteLength,
            contentType: contentType(path),
          },
        ]),
      ),
    ),
  };
  return zipSync(
    {
      ...payload,
      "integrity.json": strToU8(JSON.stringify(integrity)),
      "signature.json": strToU8(
        JSON.stringify({
          algorithm: "Ed25519",
          keyId: "demo-v1",
          signature: encoded(new Uint8Array(64)),
        }),
      ),
    },
    { level: 9 },
  );
};

describe("plugin package format 2", () => {
  it("loads an independent frontend/backend package and verifies every payload", async () => {
    const parsed = await parsePluginArchive(await packageArchive());
    expect(parsed.manifest.id).toBe("external_demo");
    expect(parsed.manifest.resources?.map((resource) => resource.type)).toEqual(
      ["durable_object", "cron"],
    );
    expect(parsed.files).toHaveProperty("frontend/entry.js");
    expect(parsed.worker).toContain("PluginState");
  });

  it("rejects bytes that no longer match integrity.json", async () => {
    const files = unzipSync(await packageArchive());
    files["frontend/entry.js"] = strToU8("export default {};");
    await expect(parsePluginArchive(zipSync(files))).rejects.toThrow(
      "PLUGIN_PACKAGE_INTEGRITY_MISMATCH",
    );
  });

  it("rejects duplicate paths before object-map extraction can hide one", async () => {
    const duplicate = zipSync({
      "frontend/a.js": strToU8("a"),
      "frontend/b.js": strToU8("b"),
    });
    const from = strToU8("frontend/b.js");
    const to = strToU8("frontend/a.js");
    let replacements = 0;
    for (
      let offset = 0;
      offset <= duplicate.byteLength - from.byteLength;
      offset += 1
    ) {
      if (from.every((byte, index) => duplicate[offset + index] === byte)) {
        duplicate.set(to, offset);
        replacements += 1;
      }
    }
    expect(replacements).toBe(2);
    await expect(parsePluginArchive(duplicate)).rejects.toThrow(
      "PLUGIN_PACKAGE_DUPLICATE_PATH",
    );
  });

  it("rejects unsafe declarative resource lifecycle changes", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...manifest,
        resources: [
          {
            name: "state",
            type: "durable_object",
            binding: "STATE",
            retention: "delete_on_purge",
            configuration: { className: "PluginState" },
          },
        ],
      }),
    ).toThrow();
  });

  it("reserves Core paths while accepting unknown public plugin pages", () => {
    expect(manifest.frontend?.publicRoutes).toEqual([
      {
        routeKey: "external_demo.shared",
        path: "/shared/external-demo/:token",
      },
    ]);
    expect(() =>
      pluginManifestSchema.parse({
        ...manifest,
        frontend: {
          ...manifest.frontend,
          publicRoutes: [
            { routeKey: "external_demo.bad", path: "/api/v1/escape" },
          ],
        },
      }),
    ).toThrow();
  });

  it("builds a portable package with the public SDK packager", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexus-plugin-"));
    const root = join(workspace, manifest.id);
    try {
      for (const directory of [
        "dist/frontend",
        "migrations/d1",
        "migrations/postgres",
      ])
        mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(
        join(root, "dist/index.js"),
        "export class PluginState {}; export default {};",
      );
      writeFileSync(
        join(root, "dist/frontend/entry.js"),
        "export default { mountPage(){ return { dispose(){} } } };",
      );
      writeFileSync(join(root, "dist/frontend/styles.css"), ":host{}\n");
      for (const dialect of ["d1", "postgres"])
        writeFileSync(
          join(root, `migrations/${dialect}/0001_init.sql`),
          "CREATE TABLE IF NOT EXISTS external_demo_items (id TEXT PRIMARY KEY);",
        );
      const { privateKey } = generateKeyPairSync("ed25519");
      const output = await buildPluginPackage({
        root,
        privateKey: privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64url"),
        keyId: "demo-v1",
      });
      const parsed = await parsePluginArchive(readFileSync(output));
      expect(parsed.manifest.id).toBe("external_demo");
      expect(parsed.files).toHaveProperty("frontend/entry.js");
      const catalogOutput = join(workspace, "nexus-marketplace.json");
      const key = privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url");
      const generated = generatePluginMarketplace({
        pluginsDirectory: workspace,
        output: catalogOutput,
        repository: "demo/plugins",
        marketplaceName: "Demo marketplace",
        publisherId: "demo_publisher",
        publisherName: "Demo Publisher",
        keyId: "demo-v1",
        privateKey: key,
      });
      expect(generated.pluginCount).toBe(1);
      const catalog = marketplaceCatalogSchema.parse(
        JSON.parse(readFileSync(catalogOutput, "utf8")),
      );
      await expect(verifyCatalogSignature(catalog)).resolves.toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("marketplace signatures", () => {
  it("verifies the signed catalog and the exact signed ZIP", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = encoded(
      new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    );
    const archive = await packageArchive();
    const artifactSignature = encoded(
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, archive),
      ),
    );
    const release = {
      version: manifest.version,
      channel: "stable" as const,
      manifest,
      artifact: {
        url: "https://github.com/demo/plugins/releases/download/v1/external_demo.plugin.zip",
        sha256: await sha256(archive),
        signature: artifactSignature,
        bytes: archive.byteLength,
      },
      publishedAt: "2026-09-08T12:00:00.000Z",
    };
    const unsigned = {
      catalogVersion: 1 as const,
      name: "Demo marketplace",
      revision: "revision-1",
      publisher: {
        id: "demo_publisher",
        name: "Demo Publisher",
        keyId: "demo-v1",
        publicKey,
      },
      plugins: [
        {
          id: manifest.id,
          name: manifest.name,
          description: manifest.description ?? "",
          categories: ["demo"],
          releases: [release],
        },
      ],
    };
    const catalog = marketplaceCatalogSchema.parse({
      ...unsigned,
      signature: {
        algorithm: "Ed25519",
        keyId: "demo-v1",
        value: encoded(
          new Uint8Array(
            await crypto.subtle.sign(
              "Ed25519",
              keys.privateKey,
              strToU8(stableJson(unsigned)),
            ),
          ),
        ),
      },
    });
    await expect(verifyCatalogSignature(catalog)).resolves.toBeUndefined();
    await expect(
      verifyReleaseArtifact(archive, release, publicKey),
    ).resolves.toBeUndefined();
    const tampered = archive.slice();
    tampered[10] ^= 1;
    await expect(
      verifyReleaseArtifact(tampered, release, publicKey),
    ).rejects.toThrow("MARKETPLACE_ARTIFACT_HASH_MISMATCH");
  });
});
