import {
  canonicalJson,
  installerReleaseSchema,
  migrationArtifactSchema,
  verifyReleaseSignature,
  type InstallerRelease,
  type MigrationArtifact,
  type ReleaseObject,
} from "@app/installer-release-schema";
import { unzipSync } from "fflate";
import semver from "semver";
import type { CoreEnv } from "../env.js";

const repository = "Techify-one/nexus-edge";
const githubApiOrigin = "https://api.github.com";
const githubDownloadOrigin = "https://github.com";
const manifestAssetName = "nexus-edge-release.json";
const signatureAssetName = "nexus-edge-release.sig";
const archiveAssetName = "nexus-edge-update.zip";
const maximumManifestBytes = 2 * 1024 * 1024;
const maximumArchiveBytes = 20 * 1024 * 1024;
const maximumExpandedBytes = 64 * 1024 * 1024;

type GitHubAsset = {
  name: string;
  size: number;
  browser_download_url: string;
};

type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GitHubAsset[];
};

export type VerifiedCoreRelease = {
  releaseId: string;
  tag: string;
  name: string;
  notes: string;
  pageUrl: string;
  publishedAt: string | null;
  archiveUrl: string;
  manifest: InstallerRelease;
  manifestHash: string;
};

export type CoreUpdateStatus = {
  channel: "beta";
  currentVersion: string;
  provider: CoreEnv["DATABASE_PROVIDER"];
  supported: boolean;
  credentialConfigured: boolean;
  updateAvailable: boolean;
  latest: null | {
    releaseId: string;
    version: string;
    tag: string;
    name: string;
    notes: string;
    pageUrl: string;
    publishedAt: string | null;
  };
  sourceError?: "unavailable";
};

const sha256Hex = async (value: Uint8Array | string): Promise<string> => {
  const bytes: Uint8Array<ArrayBuffer> =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

async function boundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maximumBytes) throw new Error("UPDATE_ASSET_TOO_LARGE");
  if (!response.ok || !response.body)
    throw new Error(`UPDATE_DOWNLOAD_HTTP_${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("UPDATE_ASSET_TOO_LARGE");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function githubJson<T>(path: string): Promise<T> {
  if (!path.startsWith("/repos/Techify-one/nexus-edge/releases"))
    throw new Error("UPDATE_GITHUB_PATH_REJECTED");
  const response = await fetch(`${githubApiOrigin}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Nexus-Edge-Updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`UPDATE_GITHUB_HTTP_${response.status}`);
  return response.json<T>();
}

function assetUrl(release: GitHubRelease, name: string): GitHubAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`UPDATE_ASSET_MISSING_${name}`);
  const url = new URL(asset.browser_download_url);
  const prefix = `/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/`;
  if (url.origin !== githubDownloadOrigin || !url.pathname.startsWith(prefix))
    throw new Error("UPDATE_ASSET_URL_REJECTED");
  return asset;
}

function validateReleaseEnvelope(release: GitHubRelease): string {
  if (release.draft || !release.prerelease)
    throw new Error("UPDATE_RELEASE_NOT_BETA");
  const match = /^nexus-v(.+)$/u.exec(release.tag_name);
  const version = match?.[1];
  if (!version || !semver.valid(version) || !semver.prerelease(version))
    throw new Error("UPDATE_RELEASE_TAG_INVALID");
  const page = new URL(release.html_url);
  if (
    page.origin !== githubDownloadOrigin ||
    !page.pathname.startsWith(`/${repository}/releases/tag/`)
  )
    throw new Error("UPDATE_RELEASE_URL_REJECTED");
  return version;
}

async function verifyGitHubRelease(
  env: CoreEnv,
  githubRelease: GitHubRelease,
): Promise<VerifiedCoreRelease> {
  const version = validateReleaseEnvelope(githubRelease);
  const manifestAsset = assetUrl(githubRelease, manifestAssetName);
  const signatureAsset = assetUrl(githubRelease, signatureAssetName);
  const archiveAsset = assetUrl(githubRelease, archiveAssetName);
  if (
    manifestAsset.size > maximumManifestBytes ||
    signatureAsset.size > 4_096 ||
    archiveAsset.size > maximumArchiveBytes
  )
    throw new Error("UPDATE_ASSET_TOO_LARGE");
  const [manifestBytes, signatureBytes] = await Promise.all([
    fetch(manifestAsset.browser_download_url).then((response) =>
      boundedBytes(response, maximumManifestBytes),
    ),
    fetch(signatureAsset.browser_download_url).then((response) =>
      boundedBytes(response, 4_096),
    ),
  ]);
  const manifest = installerReleaseSchema.parse(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  );
  const signature = new TextDecoder().decode(signatureBytes).trim();
  if (manifest.appVersion !== version)
    throw new Error("UPDATE_RELEASE_VERSION_MISMATCH");
  if (
    !(await verifyReleaseSignature(
      manifest,
      signature,
      env.CORE_UPDATE_PUBLIC_KEY,
    ))
  )
    throw new Error("UPDATE_RELEASE_SIGNATURE_INVALID");
  return {
    releaseId: String(githubRelease.id),
    tag: githubRelease.tag_name,
    name: (githubRelease.name || githubRelease.tag_name).slice(0, 200),
    notes: (githubRelease.body || "").slice(0, 10_000),
    pageUrl: githubRelease.html_url,
    publishedAt: githubRelease.published_at,
    archiveUrl: archiveAsset.browser_download_url,
    manifest,
    manifestHash: await sha256Hex(canonicalJson(manifest)),
  };
}

export async function discoverLatestCoreRelease(
  env: CoreEnv,
): Promise<VerifiedCoreRelease | null> {
  const releases = await githubJson<GitHubRelease[]>(
    `/repos/${repository}/releases?per_page=20`,
  );
  const candidates = releases
    .filter((release) => {
      try {
        validateReleaseEnvelope(release);
        return true;
      } catch {
        return false;
      }
    })
    .toSorted((left, right) => {
      const leftVersion = left.tag_name.slice("nexus-v".length);
      const rightVersion = right.tag_name.slice("nexus-v".length);
      return semver.rcompare(leftVersion, rightVersion);
    });
  return candidates[0] ? verifyGitHubRelease(env, candidates[0]) : null;
}

export async function readPinnedCoreRelease(
  env: CoreEnv,
  releaseId: string,
): Promise<VerifiedCoreRelease> {
  if (!/^\d{1,20}$/u.test(releaseId))
    throw new Error("UPDATE_RELEASE_ID_INVALID");
  return verifyGitHubRelease(
    env,
    await githubJson<GitHubRelease>(
      `/repos/${repository}/releases/${releaseId}`,
    ),
  );
}

export async function coreUpdateStatus(
  env: CoreEnv,
): Promise<CoreUpdateStatus> {
  const common = {
    channel: "beta" as const,
    currentVersion: env.APP_VERSION,
    provider: env.DATABASE_PROVIDER,
    supported: env.DATABASE_PROVIDER === "d1",
    credentialConfigured: Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
  };
  try {
    const latest = await discoverLatestCoreRelease(env);
    return {
      ...common,
      updateAvailable: Boolean(
        latest && semver.gt(latest.manifest.appVersion, env.APP_VERSION),
      ),
      latest: latest
        ? {
            releaseId: latest.releaseId,
            version: latest.manifest.appVersion,
            tag: latest.tag,
            name: latest.name,
            notes: latest.notes,
            pageUrl: latest.pageUrl,
            publishedAt: latest.publishedAt,
          }
        : null,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "core_update_discovery_failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return {
      ...common,
      updateAvailable: false,
      latest: null,
      sourceError: "unavailable",
    };
  }
}

export type VerifiedCoreArchive = {
  object(descriptor: ReleaseObject): Uint8Array<ArrayBuffer>;
  migration(
    descriptor: InstallerRelease["d1Migrations"][number],
  ): MigrationArtifact;
};

export async function downloadVerifiedCoreArchive(
  verified: VerifiedCoreRelease,
): Promise<VerifiedCoreArchive> {
  const descriptors: ReleaseObject[] = [
    ...verified.manifest.modules,
    ...verified.manifest.assets,
    ...verified.manifest.d1Migrations,
  ];
  const expected = new Map(descriptors.map((item) => [item.objectKey, item]));
  const declaredTotal = descriptors.reduce((sum, item) => sum + item.size, 0);
  if (declaredTotal > maximumExpandedBytes)
    throw new Error("UPDATE_ARCHIVE_EXPANDED_TOO_LARGE");
  const archive = await fetch(verified.archiveUrl).then((response) =>
    boundedBytes(response, maximumArchiveBytes),
  );
  const entries = unzipSync(archive, {
    filter: (file) =>
      expected.has(file.name) && file.originalSize <= maximumExpandedBytes,
  });
  for (const descriptor of descriptors) {
    const bytes = entries[descriptor.objectKey];
    if (
      !bytes ||
      bytes.byteLength !== descriptor.size ||
      (await sha256Hex(bytes)) !== descriptor.sha256
    )
      throw new Error("UPDATE_ARCHIVE_OBJECT_INVALID");
  }
  return {
    object(descriptor) {
      const bytes = entries[descriptor.objectKey];
      if (!bytes) throw new Error("UPDATE_ARCHIVE_OBJECT_MISSING");
      return bytes;
    },
    migration(descriptor) {
      const artifact = migrationArtifactSchema.parse(
        JSON.parse(new TextDecoder().decode(entries[descriptor.objectKey])),
      );
      if (
        artifact.id !== descriptor.id ||
        artifact.statements.length !== descriptor.statementCount
      )
        throw new Error("UPDATE_MIGRATION_DESCRIPTOR_MISMATCH");
      return artifact;
    },
  };
}
