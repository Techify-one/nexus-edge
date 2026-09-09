import semver from "semver";
import { z } from "zod";
import { fromBase64url, sha256, stableJson } from "@app/webhook-contract";
import {
  pluginManifestSchema,
  validateManifestPolicy,
  type PluginManifest,
} from "./manifest.js";
import { MAX_PLUGIN_PACKAGE_BYTES, parsePluginArchive } from "./package-v2.js";

const githubName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u);
const releaseSchema = z
  .object({
    version: z
      .string()
      .refine((value) => Boolean(semver.valid(value)), "invalid SemVer"),
    channel: z.enum(["stable", "beta"]).default("stable"),
    manifest: pluginManifestSchema,
    artifact: z
      .object({
        url: z.url(),
        sha256: z.string().min(40).max(100),
        signature: z.string().min(40).max(200),
        bytes: z.number().int().positive().max(MAX_PLUGIN_PACKAGE_BYTES),
      })
      .strict(),
    publishedAt: z.iso.datetime().optional(),
  })
  .strict();
const catalogPluginSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/u),
    name: z.string().min(2).max(80),
    description: z.string().max(500).default(""),
    categories: z.array(z.string().min(1).max(50)).max(20).default([]),
    releases: z.array(releaseSchema).min(1).max(30),
  })
  .strict();
export const marketplaceCatalogSchema = z
  .object({
    catalogVersion: z.literal(1),
    name: z.string().min(2).max(100),
    revision: z.string().min(1).max(100),
    publisher: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u),
        name: z.string().min(2).max(100),
        keyId: z.string().min(1).max(100),
        publicKey: z.string().min(40).max(100),
      })
      .strict(),
    plugins: z.array(catalogPluginSchema).max(30),
    signature: z
      .object({
        algorithm: z.literal("Ed25519"),
        keyId: z.string().min(1).max(100),
        value: z.string().min(40).max(200),
      })
      .strict(),
  })
  .strict()
  .superRefine((catalog, context) => {
    if (catalog.signature.keyId !== catalog.publisher.keyId)
      context.addIssue({
        code: "custom",
        message: "catalog signature key does not match publisher key",
        path: ["signature", "keyId"],
      });
    if (
      new Set(catalog.plugins.map((plugin) => plugin.id)).size !==
      catalog.plugins.length
    )
      context.addIssue({
        code: "custom",
        message: "plugin IDs must be unique",
        path: ["plugins"],
      });
    if (
      catalog.plugins.reduce(
        (total, plugin) => total + plugin.releases.length,
        0,
      ) > 30
    )
      context.addIssue({
        code: "custom",
        message: "a catalog snapshot can contain at most 30 releases",
        path: ["plugins"],
      });
    for (const [pluginIndex, plugin] of catalog.plugins.entries()) {
      if (plugin.releases.some((release) => release.manifest.id !== plugin.id))
        context.addIssue({
          code: "custom",
          message: "release manifest ID must match catalog plugin ID",
          path: ["plugins", pluginIndex, "releases"],
        });
      if (
        plugin.releases.some(
          (release) => release.manifest.publisher?.id !== catalog.publisher.id,
        )
      )
        context.addIssue({
          code: "custom",
          message: "release publisher must match the catalog signing publisher",
          path: ["plugins", pluginIndex, "releases"],
        });
      if (
        new Set(
          plugin.releases.map(
            (release) => `${release.channel}:${release.version}`,
          ),
        ).size !== plugin.releases.length
      )
        context.addIssue({
          code: "custom",
          message: "release versions must be unique per channel",
          path: ["plugins", pluginIndex, "releases"],
        });
    }
  });

export type MarketplaceCatalog = z.infer<typeof marketplaceCatalogSchema>;
export type MarketplaceRelease = z.infer<typeof releaseSchema>;

const withoutSignature = (catalog: MarketplaceCatalog): string => {
  const { signature: _signature, ...payload } = catalog;
  return stableJson(payload);
};

const importPublisherKey = (publicKey: string): Promise<CryptoKey> => {
  const bytes = fromBase64url(publicKey);
  if (bytes.byteLength !== 32)
    throw new Error("MARKETPLACE_PUBLIC_KEY_INVALID");
  return crypto.subtle.importKey(
    "raw",
    bytes as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
};

export async function verifyCatalogSignature(
  catalog: MarketplaceCatalog,
): Promise<void> {
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    await importPublisherKey(catalog.publisher.publicKey),
    fromBase64url(catalog.signature.value) as BufferSource,
    new TextEncoder().encode(withoutSignature(catalog)),
  );
  if (!verified) throw new Error("MARKETPLACE_SIGNATURE_INVALID");
}

export const publisherKeyFingerprint = (publicKey: string): Promise<string> => {
  const bytes = fromBase64url(publicKey);
  if (bytes.byteLength !== 32)
    throw new Error("MARKETPLACE_PUBLIC_KEY_INVALID");
  return sha256(bytes);
};

export async function verifyReleaseArtifact(
  bytes: Uint8Array,
  release: MarketplaceRelease,
  publicKey: string,
): Promise<void> {
  if (
    bytes.byteLength !== release.artifact.bytes ||
    (await sha256(bytes)) !== release.artifact.sha256
  )
    throw new Error("MARKETPLACE_ARTIFACT_HASH_MISMATCH");
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    await importPublisherKey(publicKey),
    fromBase64url(release.artifact.signature) as BufferSource,
    bytes as BufferSource,
  );
  if (!verified) throw new Error("MARKETPLACE_ARTIFACT_SIGNATURE_INVALID");
  const parsed = await parsePluginArchive(bytes);
  if (
    parsed.manifest.packageFormat !== 2 ||
    parsed.manifest.id !== release.manifest.id ||
    parsed.manifest.version !== release.version ||
    stableJson(parsed.manifest) !== stableJson(release.manifest)
  )
    throw new Error("MARKETPLACE_ARTIFACT_MANIFEST_MISMATCH");
}

export const marketplaceReleaseCompatibility = (
  manifest: PluginManifest,
  coreVersion: string,
  compatibilityFlags: string | undefined,
  provider: "d1" | "postgres",
): { compatible: boolean; reason?: string } => {
  try {
    if (manifest.packageFormat !== 2)
      return { compatible: false, reason: "package_format_unsupported" };
    validateManifestPolicy(manifest, coreVersion, compatibilityFlags);
    if (!manifest.databaseDialects.includes(provider))
      return { compatible: false, reason: "database_provider_unsupported" };
    return { compatible: true };
  } catch (error) {
    return {
      compatible: false,
      reason: error instanceof Error ? error.message : "contract_unsupported",
    };
  }
};

export const assertGitHubArtifactUrl = (
  urlValue: string,
  owner: string,
  repository: string,
): URL => {
  const url = new URL(urlValue);
  const prefix = `/${owner}/${repository}/releases/download/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(prefix) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("MARKETPLACE_ARTIFACT_URL_INVALID");
  return url;
};

export const parseGitHubRepository = (
  value: string,
): { owner: string; repository: string } => {
  const normalized = value.trim().replace(/\.git$/u, "");
  let owner: string | undefined;
  let repository: string | undefined;
  if (/^https:\/\/github\.com\//iu.test(normalized)) {
    const url = new URL(normalized);
    if (url.hostname !== "github.com" || url.search || url.hash)
      throw new Error("MARKETPLACE_REPOSITORY_INVALID");
    [, owner, repository] = url.pathname.split("/");
  } else [owner, repository] = normalized.split("/");
  if (
    !githubName.safeParse(owner).success ||
    !githubName.safeParse(repository).success
  )
    throw new Error("MARKETPLACE_REPOSITORY_INVALID");
  return { owner: owner!, repository: repository! };
};
