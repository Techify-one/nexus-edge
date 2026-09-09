import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { canonicalPluginJson, sha256PluginBytes } from "./package.js";

export type GenerateMarketplaceOptions = {
  pluginsDirectory: string;
  output: string;
  repository: string;
  marketplaceName: string;
  publisherId: string;
  publisherName: string;
  keyId: string;
  privateKey: string;
};

/** Generate a signed GitHub marketplace index without importing Core code. */
export function generatePluginMarketplace(
  options: GenerateMarketplaceOptions,
): { revision: string; pluginCount: number } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository))
    throw new Error("The marketplace repository must be owner/repository.");
  if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(options.publisherId))
    throw new Error("The marketplace publisher ID is invalid.");
  const marketplaceRoot = lstatSync(options.pluginsDirectory);
  if (marketplaceRoot.isSymbolicLink() || !marketplaceRoot.isDirectory())
    throw new Error("The marketplace plugin root must be a regular directory.");
  const privateKey = createPrivateKey({
    key: Buffer.from(options.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("The marketplace signing key must be Ed25519.");
  const publicKeyDer = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publisher = {
    id: options.publisherId,
    name: options.publisherName,
    keyId: options.keyId,
    publicKey: Buffer.from(
      publicKeyDer.subarray(publicKeyDer.byteLength - 32),
    ).toString("base64url"),
  };
  const plugins: Array<{
    id: string;
    name: string;
    description: string;
    categories: string[];
    releases: Array<{
      version: string;
      channel: "stable";
      manifest: Record<string, unknown>;
      artifact: {
        url: string;
        sha256: string;
        signature: string;
        bytes: number;
      };
    }>;
  }> = [];
  for (const id of readdirSync(options.pluginsDirectory).sort()) {
    if (!/^[a-z][a-z0-9_]{1,31}$/u.test(id)) continue;
    const pluginRoot = join(options.pluginsDirectory, id);
    const rootMetadata = lstatSync(pluginRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) continue;
    const manifestPath = join(pluginRoot, "manifest.json");
    const catalogPath = join(pluginRoot, "catalog.json");
    const artifactPath = join(pluginRoot, "release", `${id}.plugin.zip`);
    if (!existsSync(manifestPath) || !existsSync(artifactPath)) continue;
    for (const path of [manifestPath, artifactPath]) {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isFile())
        throw new Error(`Marketplace input must be a regular file: ${path}`);
    }
    const sourceManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    const catalogMetadata = existsSync(catalogPath)
      ? (JSON.parse(readFileSync(catalogPath, "utf8")) as {
          category?: unknown;
          description?: unknown;
        })
      : undefined;
    if (
      catalogMetadata &&
      ((catalogMetadata.category !== undefined &&
        typeof catalogMetadata.category !== "string") ||
        (catalogMetadata.description !== undefined &&
          typeof catalogMetadata.description !== "string"))
    )
      throw new Error(`${catalogPath} has invalid marketplace metadata.`);
    if (sourceManifest.packageFormat !== 2) continue;
    if (
      sourceManifest.id !== id ||
      typeof sourceManifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
        sourceManifest.version,
      ) ||
      typeof sourceManifest.name !== "string" ||
      (sourceManifest.publisher as { id?: unknown } | undefined)?.id !==
        options.publisherId
    )
      throw new Error(`${manifestPath} has an invalid marketplace identity.`);
    const bytes = readFileSync(artifactPath);
    const archivedManifest = unzipSync(bytes)["manifest.json"];
    if (
      !archivedManifest ||
      canonicalPluginJson(JSON.parse(strFromU8(archivedManifest))) !==
        canonicalPluginJson(sourceManifest)
    )
      throw new Error(`${artifactPath} does not contain its source manifest.`);
    plugins.push({
      id,
      name: sourceManifest.name,
      description:
        typeof catalogMetadata?.description === "string"
          ? catalogMetadata.description
          : typeof sourceManifest.description === "string"
            ? sourceManifest.description
            : "",
      categories:
        typeof catalogMetadata?.category === "string"
          ? [catalogMetadata.category]
          : [],
      releases: [
        {
          version: sourceManifest.version,
          channel: "stable",
          manifest: sourceManifest,
          artifact: {
            url: `https://github.com/${options.repository}/releases/download/${encodeURIComponent(`${id}-v${sourceManifest.version}`)}/${id}.plugin.zip`,
            sha256: sha256PluginBytes(bytes),
            signature: Buffer.from(sign(null, bytes, privateKey)).toString(
              "base64url",
            ),
            bytes: bytes.byteLength,
          },
        },
      ],
    });
  }
  const revision = sha256PluginBytes(canonicalPluginJson(plugins)).slice(0, 32);
  const payload = {
    catalogVersion: 1 as const,
    name: options.marketplaceName,
    revision,
    publisher,
    plugins,
  };
  const catalog = {
    ...payload,
    signature: {
      algorithm: "Ed25519" as const,
      keyId: publisher.keyId,
      value: Buffer.from(
        sign(null, Buffer.from(canonicalPluginJson(payload)), privateKey),
      ).toString("base64url"),
    },
  };
  if (existsSync(options.output)) {
    const outputMetadata = lstatSync(options.output);
    if (outputMetadata.isSymbolicLink() || !outputMetadata.isFile())
      throw new Error("The marketplace output must be a regular file.");
  }
  writeFileSync(options.output, `${JSON.stringify(catalog, null, 2)}\n`);
  return { revision, pluginCount: plugins.length };
}
