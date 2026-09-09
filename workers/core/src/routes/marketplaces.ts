import { Hono, type Context } from "hono";
import semver from "semver";
import { createId } from "@app/core-contract";
import type { SqlStatement } from "@app/database";
import { sha256, stableJson } from "@app/webhook-contract";
import type { HonoEnv } from "../env.js";
import { canPermission } from "../lib/ability.js";
import { AppError, noStore } from "../lib/http.js";
import { dbTime, numberTime, parseJson } from "../lib/values.js";
import { requirePermission } from "../middleware/auth.js";
import { validateRecentReauth } from "../middleware/reauth.js";
import { audit } from "../services/audit.js";
import { MAX_PLUGIN_PACKAGE_BYTES } from "../installer/package-v2.js";
import { pluginManifestSchema } from "../installer/manifest.js";
import {
  assertGitHubArtifactUrl,
  marketplaceCatalogSchema,
  marketplaceReleaseCompatibility,
  parseGitHubRepository,
  publisherKeyFingerprint,
  verifyCatalogSignature,
  verifyReleaseArtifact,
  type MarketplaceCatalog,
} from "../installer/marketplace.js";

type MarketplaceRow = {
  id: string;
  name: string;
  owner: string;
  repository: string;
  repositoryId: string | null;
  sourceRef: string;
  catalogPath: string;
  enabled: number | boolean;
  isDefault: number | boolean;
  trustState: string;
  trustedPublicKey: string | null;
  keyFingerprint: string | null;
  etag: string | null;
  retryAfterAt: unknown;
  lastSyncedAt: unknown;
  lastErrorCode: string | null;
  removedAt: unknown;
};

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

const readBoundedBytes = async (
  response: Response,
  maximum: number,
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > maximum) throw new Error("REMOTE_RESPONSE_TOO_LARGE");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("REMOTE_RESPONSE_TOO_LARGE");
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
};

const githubDownloadHosts = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

const fetchGitHubArtifact = async (initialUrl: URL): Promise<Response> => {
  let url = initialUrl;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (
      url.protocol !== "https:" ||
      !githubDownloadHosts.has(url.hostname) ||
      url.username ||
      url.password
    )
      throw new AppError(
        502,
        "PLUGIN_DOWNLOAD_REDIRECT_REJECTED",
        "The package download destination was rejected.",
      );
    const response = await fetch(url, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "Nexus-Edge-Plugin-Marketplace/1",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location || redirect === 5)
      throw new AppError(
        502,
        "PLUGIN_DOWNLOAD_REDIRECT_REJECTED",
        "The package download redirect chain was rejected.",
      );
    url = new URL(location, url);
  }
  throw new AppError(
    502,
    "PLUGIN_DOWNLOAD_REDIRECT_REJECTED",
    "The package download redirect chain was rejected.",
  );
};

const marketplaceSelect = `SELECT id, name, owner, repository,
  repository_id AS "repositoryId", source_ref AS "sourceRef",
  catalog_path AS "catalogPath", enabled, is_default AS "isDefault",
  trust_state AS "trustState", trusted_public_key AS "trustedPublicKey",
  key_fingerprint AS "keyFingerprint", etag,
  retry_after_at AS "retryAfterAt",
  last_synced_at AS "lastSyncedAt", last_error_code AS "lastErrorCode",
  removed_at AS "removedAt" FROM plugin_marketplaces`;

const marketplace = async (c: Context<HonoEnv>): Promise<MarketplaceRow> => {
  const row = await c
    .get("db")
    .first<MarketplaceRow>(
      `${marketplaceSelect} WHERE id = ? AND removed_at IS NULL`,
      [c.req.param("marketplaceId") ?? ""],
    );
  if (!row)
    throw new AppError(404, "MARKETPLACE_NOT_FOUND", "Marketplace not found.");
  return row;
};

const validateRef = (value: unknown): string => {
  const ref = typeof value === "string" && value.trim() ? value.trim() : "main";
  if (!/^[A-Za-z0-9_.\/-]{1,120}$/u.test(ref) || ref.includes(".."))
    throw new AppError(
      422,
      "MARKETPLACE_REF_INVALID",
      "The GitHub reference is invalid.",
    );
  return ref;
};
const validateCatalogPath = (value: unknown): string => {
  const path =
    typeof value === "string" && value.trim()
      ? value.trim()
      : "nexus-marketplace.json";
  if (
    !/^[A-Za-z0-9_.\/-]{1,180}$/u.test(path) ||
    path.startsWith("/") ||
    path.includes("..")
  )
    throw new AppError(
      422,
      "MARKETPLACE_PATH_INVALID",
      "The catalog path is invalid.",
    );
  return path;
};

class GitHubFetchError extends Error {
  constructor(
    message: string,
    readonly retryAfterAt?: number,
  ) {
    super(message);
  }
}

const githubJson = async <T>(
  url: URL,
  maximum: number,
  etag?: string | null,
): Promise<
  | { value: T; etag: string | null; notModified: false }
  | { etag: string | null; notModified: true }
> => {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "Nexus-Edge-Plugin-Marketplace/1",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (etag) headers.set("If-None-Match", etag);
  const response = await fetch(url, {
    headers,
    // Cloudflare Workers implements `follow` and `manual`, but not the
    // browser-only `error` mode. Keeping redirects manual means a 3xx still
    // reaches the non-success branch below and is rejected.
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 304)
    return {
      etag: response.headers.get("ETag") ?? etag ?? null,
      notModified: true,
    };
  if (!response.ok) {
    const retrySeconds = Number(response.headers.get("Retry-After") ?? 0);
    const resetSeconds = Number(response.headers.get("X-RateLimit-Reset") ?? 0);
    const retryAfterAt =
      retrySeconds > 0
        ? Date.now() + retrySeconds * 1000
        : resetSeconds > 0
          ? resetSeconds * 1000
          : undefined;
    throw new GitHubFetchError(`GITHUB_HTTP_${response.status}`, retryAfterAt);
  }
  const bytes = await readBoundedBytes(response, maximum);
  try {
    return {
      value: JSON.parse(new TextDecoder().decode(bytes)) as T,
      etag: response.headers.get("ETag"),
      notModified: false,
    };
  } catch {
    throw new Error("GITHUB_JSON_INVALID");
  }
};

export const marketplacesRoutes = new Hono<HonoEnv>();

marketplacesRoutes.get(
  "/plugin-marketplaces",
  requirePermission("core.marketplace.read"),
  async (c) =>
    c.json(
      {
        items: await c
          .get("db")
          .query<MarketplaceRow>(
            `${marketplaceSelect} WHERE removed_at IS NULL ORDER BY is_default DESC, name`,
          ),
      },
      200,
      noStore,
    ),
);

marketplacesRoutes.post(
  "/plugin-marketplaces",
  requirePermission("core.marketplace.create"),
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      repository?: unknown;
      ref?: unknown;
      catalogPath?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 100)
      throw new AppError(
        422,
        "MARKETPLACE_NAME_INVALID",
        "The marketplace name is invalid.",
      );
    let github: { owner: string; repository: string };
    try {
      github = parseGitHubRepository(String(body?.repository ?? ""));
    } catch {
      throw new AppError(
        422,
        "MARKETPLACE_REPOSITORY_INVALID",
        "Use a GitHub owner/repository URL.",
      );
    }
    const sourceRef = validateRef(body?.ref);
    const catalogPath = validateCatalogPath(body?.catalogPath);
    const removed = await c.get("db").first<{ id: string }>(
      `SELECT id FROM plugin_marketplaces
        WHERE owner = ? AND repository = ? AND source_ref = ?
          AND catalog_path = ? AND removed_at IS NOT NULL`,
      [github.owner, github.repository, sourceRef, catalogPath],
    );
    const id = removed?.id ?? createId("mkt");
    const now = dbTime(c.get("db"));
    try {
      if (removed) {
        await c.get("db").atomic([
          {
            sql: `UPDATE plugin_marketplaces
                    SET name = ?, enabled = ?, removed_at = NULL,
                        trust_state = 'pending', trusted_public_key = NULL,
                        key_fingerprint = NULL, etag = NULL,
                        catalog_json = NULL, catalog_expires_at = NULL,
                        retry_after_at = NULL, last_synced_at = NULL,
                        last_error_code = NULL, updated_at = ?
                  WHERE id = ?`,
            params: [name, true, now, id],
          },
          {
            sql: "DELETE FROM plugin_releases WHERE marketplace_id = ?",
            params: [id],
          },
        ]);
      } else
        await c.get("db").execute(
          `INSERT INTO plugin_marketplaces(id, name, owner, repository, source_ref, catalog_path,
            enabled, is_default, trust_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [
            id,
            name,
            github.owner,
            github.repository,
            sourceRef,
            catalogPath,
            true,
            false,
            now,
            now,
          ],
        );
    } catch {
      throw new AppError(
        409,
        "MARKETPLACE_ALREADY_EXISTS",
        "This marketplace is already configured.",
      );
    }
    await audit(c, "core.marketplace.created", "core.marketplace", id, {
      owner: github.owner,
      repository: github.repository,
      restored: Boolean(removed),
    });
    return c.json(
      { id, name, ...github, sourceRef, catalogPath, enabled: true },
      201,
      noStore,
    );
  },
);

marketplacesRoutes.patch(
  "/plugin-marketplaces/:marketplaceId",
  requirePermission("core.marketplace.update"),
  async (c) => {
    const current = await marketplace(c);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      enabled?: unknown;
    } | null;
    const name =
      typeof body?.name === "string" ? body.name.trim() : current.name;
    const enabled =
      typeof body?.enabled === "boolean"
        ? body.enabled
        : Boolean(current.enabled);
    if (name.length < 2 || name.length > 100)
      throw new AppError(
        422,
        "MARKETPLACE_NAME_INVALID",
        "The marketplace name is invalid.",
      );
    await c
      .get("db")
      .execute(
        "UPDATE plugin_marketplaces SET name = ?, enabled = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL",
        [name, enabled, dbTime(c.get("db")), current.id],
      );
    await audit(c, "core.marketplace.updated", "core.marketplace", current.id, {
      enabled,
    });
    return c.json({ id: current.id, name, enabled }, 200, noStore);
  },
);

marketplacesRoutes.delete(
  "/plugin-marketplaces/:marketplaceId",
  requirePermission("core.marketplace.delete"),
  async (c) => {
    const current = await marketplace(c);
    const now = dbTime(c.get("db"));
    await c
      .get("db")
      .execute(
        "UPDATE plugin_marketplaces SET enabled = ?, removed_at = ?, updated_at = ? WHERE id = ?",
        [false, now, now, current.id],
      );
    await audit(c, "core.marketplace.removed", "core.marketplace", current.id, {
      installedPluginsPreserved: true,
    });
    return c.body(null, 204);
  },
);

marketplacesRoutes.post(
  "/plugin-marketplaces/:marketplaceId/trust-key",
  requirePermission("core.marketplace.update"),
  async (c) => {
    const source = await marketplace(c);
    await validateRecentReauth(c);
    const body = (await c.req.json().catch(() => null)) as {
      publicKey?: unknown;
      keyId?: unknown;
      publisherId?: unknown;
      expectedFingerprint?: unknown;
    } | null;
    const publicKey =
      typeof body?.publicKey === "string" ? body.publicKey.trim() : "";
    const keyId = typeof body?.keyId === "string" ? body.keyId.trim() : "";
    const publisherId =
      typeof body?.publisherId === "string" ? body.publisherId.trim() : "";
    const expectedFingerprint =
      typeof body?.expectedFingerprint === "string"
        ? body.expectedFingerprint.trim()
        : "";
    if (
      !/^[A-Za-z0-9_.-]{1,100}$/u.test(keyId) ||
      !/^[a-z][a-z0-9_.-]{1,63}$/u.test(publisherId)
    )
      throw new AppError(
        422,
        "MARKETPLACE_KEY_INVALID",
        "The publisher key identity is invalid.",
      );
    let fingerprint: string;
    try {
      fingerprint = await publisherKeyFingerprint(publicKey);
    } catch {
      throw new AppError(
        422,
        "MARKETPLACE_KEY_INVALID",
        "The Ed25519 public key is invalid.",
      );
    }
    if (fingerprint !== expectedFingerprint)
      throw new AppError(
        422,
        "MARKETPLACE_KEY_FINGERPRINT_MISMATCH",
        "The confirmed fingerprint does not match this public key.",
      );
    const now = dbTime(c.get("db"));
    await c.get("db").atomic([
      {
        sql: `UPDATE plugin_marketplace_keys SET status = 'retired', valid_until = ?
               WHERE marketplace_id = ? AND status = 'active'`,
        params: [now, source.id],
      },
      {
        sql: `INSERT INTO plugin_marketplace_keys(
                marketplace_id, key_id, publisher_id, public_key,
                fingerprint, status, valid_from, created_at)
              VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
              ON CONFLICT(marketplace_id, key_id) DO UPDATE SET
                publisher_id=excluded.publisher_id,
                public_key=excluded.public_key,
                fingerprint=excluded.fingerprint,
                status='active', valid_from=excluded.valid_from,
                valid_until=NULL`,
        params: [
          source.id,
          keyId,
          publisherId,
          publicKey,
          fingerprint,
          now,
          now,
        ],
      },
      {
        sql: `UPDATE plugin_marketplaces
                 SET trusted_public_key = ?, key_fingerprint = ?,
                     trust_state = 'pending', etag = NULL,
                     catalog_json = NULL, catalog_expires_at = NULL,
                     last_error_code = NULL, updated_at = ?
               WHERE id = ?`,
        params: [publicKey, fingerprint, now, source.id],
      },
      {
        sql: "DELETE FROM plugin_releases WHERE marketplace_id = ?",
        params: [source.id],
      },
    ]);
    await audit(
      c,
      "core.marketplace.key_reassociated",
      "core.marketplace",
      source.id,
      {
        keyId,
        publisherId,
        fingerprint,
      },
    );
    return c.json(
      { id: source.id, keyId, fingerprint, trustState: "pending" },
      200,
      noStore,
    );
  },
);

marketplacesRoutes.post(
  "/plugin-marketplaces/:marketplaceId/keys/:keyId/revoke",
  requirePermission("core.marketplace.update"),
  async (c) => {
    const source = await marketplace(c);
    await validateRecentReauth(c);
    const keyId = c.req.param("keyId") ?? "";
    const key = await c.get("db").first<{ publicKey: string }>(
      `SELECT public_key AS "publicKey" FROM plugin_marketplace_keys
        WHERE marketplace_id = ? AND key_id = ?`,
      [source.id, keyId],
    );
    if (!key)
      throw new AppError(
        404,
        "MARKETPLACE_KEY_NOT_FOUND",
        "Marketplace key not found.",
      );
    const now = dbTime(c.get("db"));
    await c.get("db").atomic([
      {
        sql: `UPDATE plugin_marketplace_keys
                 SET status = 'revoked', valid_until = ?
               WHERE marketplace_id = ? AND key_id = ?`,
        params: [now, source.id, keyId],
      },
      ...(source.trustedPublicKey === key.publicKey
        ? [
            {
              sql: `UPDATE plugin_marketplaces
                       SET enabled = ?, trust_state = 'error',
                           last_error_code = 'MARKETPLACE_KEY_REVOKED',
                           updated_at = ? WHERE id = ?`,
              params: [false, now, source.id],
            },
            {
              sql: "DELETE FROM plugin_releases WHERE marketplace_id = ?",
              params: [source.id],
            },
          ]
        : []),
    ]);
    await audit(
      c,
      "core.marketplace.key_revoked",
      "core.marketplace",
      source.id,
      {
        keyId,
        installedPluginsPreserved: true,
      },
    );
    return c.body(null, 204);
  },
);

marketplacesRoutes.post(
  "/plugin-marketplaces/:marketplaceId/sync",
  requirePermission("core.marketplace.update"),
  async (c) => {
    const source = await marketplace(c);
    if (!Boolean(source.enabled))
      throw new AppError(
        409,
        "MARKETPLACE_DISABLED",
        "Enable the marketplace before syncing it.",
      );
    if (source.retryAfterAt && numberTime(source.retryAfterAt) > Date.now())
      throw new AppError(
        429,
        "MARKETPLACE_SYNC_BACKOFF",
        "GitHub asked this marketplace to wait before synchronizing again.",
      );
    try {
      const repositoryUrl = new URL(
        `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`,
      );
      const repository = await githubJson<{ id?: number; archived?: boolean }>(
        repositoryUrl,
        256 * 1024,
      );
      if (repository.notModified)
        throw new Error("GITHUB_REPOSITORY_RESPONSE_INVALID");
      if (
        !Number.isSafeInteger(repository.value.id) ||
        repository.value.archived
      )
        throw new Error("GITHUB_REPOSITORY_UNAVAILABLE");
      if (
        source.repositoryId &&
        source.repositoryId !== String(repository.value.id)
      )
        throw new Error("GITHUB_REPOSITORY_ID_CHANGED");
      const rawPath = [
        source.owner,
        source.repository,
        source.sourceRef,
        ...source.catalogPath.split("/"),
      ]
        .map(encodeURIComponent)
        .join("/");
      const catalogResponse = await githubJson<unknown>(
        new URL(`https://raw.githubusercontent.com/${rawPath}`),
        MAX_CATALOG_BYTES,
        source.etag,
      );
      if (catalogResponse.notModified) {
        const now = dbTime(c.get("db"));
        await c.get("db").execute(
          `UPDATE plugin_marketplaces SET last_synced_at = ?,
                  catalog_expires_at = ?, retry_after_at = NULL,
                  last_error_code = NULL, updated_at = ? WHERE id = ?`,
          [
            now,
            dbTime(c.get("db"), Date.now() + 6 * 60 * 60_000),
            now,
            source.id,
          ],
        );
        return c.json({ id: source.id, notModified: true }, 200, noStore);
      }
      const parsed = marketplaceCatalogSchema.safeParse(catalogResponse.value);
      if (!parsed.success) throw new Error("MARKETPLACE_CATALOG_INVALID");
      const catalog = parsed.data;
      await verifyCatalogSignature(catalog);
      if (
        source.trustedPublicKey &&
        source.trustedPublicKey !== catalog.publisher.publicKey
      )
        throw new Error("MARKETPLACE_SIGNING_KEY_CHANGED");
      const fingerprint = await publisherKeyFingerprint(
        catalog.publisher.publicKey,
      );
      const knownKey = await c
        .get("db")
        .first<{ status: string; publicKey: string }>(
          `SELECT status, public_key AS "publicKey"
           FROM plugin_marketplace_keys
          WHERE marketplace_id = ? AND key_id = ?`,
          [source.id, catalog.publisher.keyId],
        );
      if (
        knownKey?.status === "revoked" ||
        (knownKey && knownKey.publicKey !== catalog.publisher.publicKey)
      )
        throw new Error("MARKETPLACE_SIGNING_KEY_REJECTED");
      const now = dbTime(c.get("db"));
      if (!source.trustedPublicKey) {
        await c.get("db").execute(
          `UPDATE plugin_marketplaces
              SET name = ?, repository_id = ?, trust_state = 'pending',
                  key_fingerprint = ?, etag = NULL, catalog_json = NULL,
                  catalog_expires_at = NULL, last_error_code = NULL,
                  updated_at = ?
            WHERE id = ?`,
          [
            catalog.name,
            String(repository.value.id),
            fingerprint,
            now,
            source.id,
          ],
        );
        await audit(
          c,
          "core.marketplace.key_confirmation_requested",
          "core.marketplace",
          source.id,
          { keyId: catalog.publisher.keyId, fingerprint },
        );
        return c.json(
          {
            id: source.id,
            requiresTrust: true,
            publisherId: catalog.publisher.id,
            publisherName: catalog.publisher.name,
            keyId: catalog.publisher.keyId,
            publicKey: catalog.publisher.publicKey,
            fingerprint,
          },
          200,
          noStore,
        );
      }
      const catalogSha = await sha256(stableJson(catalog));
      const previousReleases = await c.get("db").query<{
        pluginId: string;
        version: string;
        channel: string;
        artifactSha256: string;
      }>(
        `SELECT plugin_id AS "pluginId", version, channel,
                artifact_sha256 AS "artifactSha256"
           FROM plugin_releases WHERE marketplace_id = ?`,
        [source.id],
      );
      const previousByVersion = new Map(
        previousReleases.map((release) => [
          `${release.pluginId}:${release.channel}:${release.version}`,
          release.artifactSha256,
        ]),
      );
      const statements: SqlStatement[] = [
        {
          sql: `UPDATE plugin_marketplaces SET name = ?, repository_id = ?, trust_state = 'trusted',
                  trusted_public_key = ?, key_fingerprint = ?, etag = ?, catalog_json = ?,
                  catalog_expires_at = ?, retry_after_at = NULL,
                  last_synced_at = ?, last_error_code = NULL, updated_at = ? WHERE id = ?`,
          params: [
            catalog.name,
            String(repository.value.id),
            catalog.publisher.publicKey,
            fingerprint,
            catalogResponse.etag,
            JSON.stringify(catalog),
            dbTime(c.get("db"), Date.now() + 6 * 60 * 60_000),
            now,
            now,
            source.id,
          ],
        },
        {
          sql: `INSERT INTO plugin_marketplace_keys(marketplace_id, key_id, publisher_id, public_key,
                  fingerprint, status, valid_from, created_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
                ON CONFLICT(marketplace_id, key_id) DO UPDATE SET
                  public_key=excluded.public_key, fingerprint=excluded.fingerprint, status='active'`,
          params: [
            source.id,
            catalog.publisher.keyId,
            catalog.publisher.id,
            catalog.publisher.publicKey,
            fingerprint,
            now,
            now,
          ],
        },
        {
          sql: `INSERT INTO plugin_catalog_snapshots(id, marketplace_id, revision, sha256, etag, catalog_json, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(marketplace_id, revision) DO UPDATE SET
                  sha256=excluded.sha256, etag=excluded.etag,
                  catalog_json=excluded.catalog_json, fetched_at=excluded.fetched_at`,
          params: [
            `snap_${catalogSha.slice(0, 40)}`,
            source.id,
            catalog.revision,
            catalogSha,
            catalogResponse.etag,
            JSON.stringify(catalog),
            now,
          ],
        },
        {
          sql: "DELETE FROM plugin_releases WHERE marketplace_id = ?",
          params: [source.id],
        },
      ];
      for (const plugin of catalog.plugins)
        for (const release of plugin.releases) {
          assertGitHubArtifactUrl(
            release.artifact.url,
            source.owner,
            source.repository,
          );
          const previousSha = previousByVersion.get(
            `${plugin.id}:${release.channel}:${release.version}`,
          );
          if (previousSha && previousSha !== release.artifact.sha256)
            throw new Error("MARKETPLACE_RELEASE_IMMUTABILITY_VIOLATION");
          const compatibility = marketplaceReleaseCompatibility(
            release.manifest,
            c.env.APP_VERSION,
            c.env.PLUGIN_COMPATIBILITY_FLAGS,
            c.env.DATABASE_PROVIDER,
          );
          const releaseId = `rel_${(await sha256(`${source.id}:${plugin.id}:${release.channel}:${release.version}`)).slice(0, 40)}`;
          statements.push({
            sql: `INSERT INTO plugin_releases(id, marketplace_id, plugin_id, publisher_id,
                    publisher_name, version, channel, description, manifest_json, artifact_url,
                    artifact_sha256, artifact_signature, package_bytes, compatible,
                    compatibility_reason, published_at, discovered_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              releaseId,
              source.id,
              plugin.id,
              catalog.publisher.id,
              catalog.publisher.name,
              release.version,
              release.channel,
              plugin.description,
              JSON.stringify(release.manifest),
              release.artifact.url,
              release.artifact.sha256,
              release.artifact.signature,
              release.artifact.bytes,
              compatibility.compatible,
              compatibility.reason ?? null,
              release.publishedAt
                ? dbTime(c.get("db"), Date.parse(release.publishedAt))
                : null,
              now,
            ],
          });
        }
      await c.get("db").atomic(statements);
      await audit(c, "core.marketplace.synced", "core.marketplace", source.id, {
        revision: catalog.revision,
        plugins: catalog.plugins.length,
      });
      return c.json(
        {
          id: source.id,
          revision: catalog.revision,
          plugins: catalog.plugins.length,
          fingerprint,
        },
        200,
        noStore,
      );
    } catch (error) {
      const code =
        error instanceof Error
          ? error.message.slice(0, 100)
          : "MARKETPLACE_SYNC_FAILED";
      await c.get("db").execute(
        `UPDATE plugin_marketplaces SET trust_state = 'error',
                last_error_code = ?, retry_after_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          code,
          error instanceof GitHubFetchError && error.retryAfterAt
            ? dbTime(c.get("db"), error.retryAfterAt)
            : null,
          dbTime(c.get("db")),
          source.id,
        ],
      );
      throw new AppError(
        502,
        "MARKETPLACE_SYNC_FAILED",
        "The marketplace could not be synchronized safely.",
      );
    }
  },
);

marketplacesRoutes.get(
  "/plugin-catalog",
  requirePermission("core.plugin.read"),
  async (c) => {
    const rows = await c.get("db").query<{
      id: string;
      marketplaceId: string;
      marketplaceName: string;
      pluginId: string;
      publisherId: string;
      publisherName: string;
      version: string;
      channel: string;
      description: string;
      manifest: unknown;
      compatible: number | boolean;
      compatibilityReason: string | null;
      packageBytes: number | string | null;
      installedVersion: string | null;
      installedMarketplaceId: string | null;
      trustState: string;
      catalogExpiresAt: unknown;
    }>(
      `SELECT r.id, r.marketplace_id AS "marketplaceId", m.name AS "marketplaceName",
              r.plugin_id AS "pluginId", r.publisher_id AS "publisherId",
              r.publisher_name AS "publisherName", r.version, r.channel, r.description,
              r.manifest_json AS manifest, r.compatible,
              r.compatibility_reason AS "compatibilityReason", r.package_bytes AS "packageBytes",
              m.trust_state AS "trustState", m.catalog_expires_at AS "catalogExpiresAt",
              p.installed_version AS "installedVersion", p.marketplace_id AS "installedMarketplaceId"
         FROM plugin_releases r
         JOIN plugin_marketplaces m ON m.id = r.marketplace_id
         LEFT JOIN plugins p ON p.id = r.plugin_id AND p.status = 'installed'
        WHERE m.enabled = ? AND m.removed_at IS NULL
        ORDER BY r.plugin_id, r.channel, r.version`,
      [true],
    );
    const best = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (row.channel !== "stable") continue;
      const key = `${row.marketplaceId}:${row.pluginId}`;
      const current = best.get(key);
      if (!current || semver.gt(row.version, current.version))
        best.set(key, row);
    }
    return c.json(
      {
        items: [...best.values()].map((row) => {
          const manifest = pluginManifestSchema.safeParse(
            parseJson<unknown>(row.manifest, null),
          );
          const compatibility = manifest.success
            ? marketplaceReleaseCompatibility(
                manifest.data,
                c.env.APP_VERSION,
                c.env.PLUGIN_COMPATIBILITY_FLAGS,
                c.env.DATABASE_PROVIDER,
              )
            : { compatible: false, reason: "manifest_invalid" };
          const available =
            row.trustState === "trusted" &&
            Boolean(row.catalogExpiresAt) &&
            numberTime(row.catalogExpiresAt) >= Date.now();
          return {
            ...row,
            manifest: manifest.success ? manifest.data : {},
            packageBytes:
              row.packageBytes === null ? null : Number(row.packageBytes),
            compatible: available && compatibility.compatible,
            compatibilityReason: available
              ? (compatibility.reason ?? null)
              : "marketplace_revalidation_required",
            updateAvailable: Boolean(
              row.installedVersion &&
              semver.gt(row.version, row.installedVersion),
            ),
            sourceMatches:
              !row.installedMarketplaceId ||
              row.installedMarketplaceId === row.marketplaceId,
          };
        }),
      },
      200,
      noStore,
    );
  },
);

marketplacesRoutes.get(
  "/plugin-catalog/:marketplaceId/:pluginId",
  requirePermission("core.plugin.read"),
  async (c) => {
    const marketplaceId = c.req.param("marketplaceId") ?? "";
    const pluginId = c.req.param("pluginId") ?? "";
    if (!/^[a-z][a-z0-9_]{1,31}$/u.test(pluginId))
      throw new AppError(
        404,
        "PLUGIN_CATALOG_ENTRY_NOT_FOUND",
        "Catalog entry not found.",
      );
    const items = await c.get("db").query<{
      id: string;
      version: string;
      channel: string;
      manifest: unknown;
      compatible: number | boolean;
      compatibilityReason: string | null;
      packageBytes: number | string | null;
      publishedAt: unknown;
      trustState: string;
      catalogExpiresAt: unknown;
    }>(
      `SELECT r.id, r.version, r.channel, r.manifest_json AS manifest,
              r.compatible, r.compatibility_reason AS "compatibilityReason",
              r.package_bytes AS "packageBytes", r.published_at AS "publishedAt",
              m.trust_state AS "trustState", m.catalog_expires_at AS "catalogExpiresAt"
         FROM plugin_releases r JOIN plugin_marketplaces m
           ON m.id = r.marketplace_id
        WHERE r.marketplace_id = ? AND r.plugin_id = ?
          AND m.enabled = ? AND m.removed_at IS NULL
        ORDER BY r.published_at DESC, r.version DESC`,
      [marketplaceId, pluginId, true],
    );
    if (!items.length)
      throw new AppError(
        404,
        "PLUGIN_CATALOG_ENTRY_NOT_FOUND",
        "Catalog entry not found.",
      );
    return c.json(
      {
        marketplaceId,
        pluginId,
        releases: items.map((item) => {
          const manifest = pluginManifestSchema.safeParse(
            parseJson<unknown>(item.manifest, null),
          );
          const compatibility = manifest.success
            ? marketplaceReleaseCompatibility(
                manifest.data,
                c.env.APP_VERSION,
                c.env.PLUGIN_COMPATIBILITY_FLAGS,
                c.env.DATABASE_PROVIDER,
              )
            : { compatible: false, reason: "manifest_invalid" };
          const available =
            item.trustState === "trusted" &&
            Boolean(item.catalogExpiresAt) &&
            numberTime(item.catalogExpiresAt) >= Date.now();
          return {
            ...item,
            manifest: manifest.success ? manifest.data : {},
            compatible: available && compatibility.compatible,
            compatibilityReason: available
              ? (compatibility.reason ?? null)
              : "marketplace_revalidation_required",
            packageBytes:
              item.packageBytes === null ? null : Number(item.packageBytes),
          };
        }),
      },
      200,
      noStore,
    );
  },
);

marketplacesRoutes.post("/plugin-catalog/:releaseId/package", async (c) => {
  const release = await c.get("db").first<{
    id: string;
    pluginId: string;
    version: string;
    artifactUrl: string;
    manifest: unknown;
    artifactSha256: string;
    artifactSignature: string;
    packageBytes: number | string;
    owner: string;
    repository: string;
    publicKey: string;
    compatible: number | boolean;
    enabled: number | boolean;
    channel: "stable" | "beta";
    trustState: string;
    catalogExpiresAt: unknown;
  }>(
    `SELECT r.id, r.plugin_id AS "pluginId", r.version,
            r.artifact_url AS "artifactUrl", r.manifest_json AS manifest,
            r.artifact_sha256 AS "artifactSha256", r.artifact_signature AS "artifactSignature",
            r.package_bytes AS "packageBytes", r.channel, m.owner, m.repository,
            m.trusted_public_key AS "publicKey", r.compatible, m.enabled,
            m.trust_state AS "trustState",
            m.catalog_expires_at AS "catalogExpiresAt"
       FROM plugin_releases r JOIN plugin_marketplaces m ON m.id = r.marketplace_id
      WHERE r.id = ? AND m.removed_at IS NULL`,
    [c.req.param("releaseId") ?? ""],
  );
  if (!release)
    throw new AppError(
      404,
      "PLUGIN_RELEASE_NOT_FOUND",
      "Plugin release not found.",
    );
  const installed = await c
    .get("db")
    .first<{ version: string }>(
      `SELECT installed_version AS version FROM plugins WHERE id = ? AND status = 'installed'`,
      [release.pluginId],
    );
  const permission = installed ? "core.plugin.update" : "core.plugin.create";
  if (!canPermission(c.get("ability"), permission))
    throw new AppError(
      403,
      "FORBIDDEN",
      "You do not have permission for this plugin operation.",
    );
  if (
    !Boolean(release.enabled) ||
    release.trustState !== "trusted" ||
    !release.publicKey ||
    !release.catalogExpiresAt ||
    numberTime(release.catalogExpiresAt) < Date.now()
  )
    throw new AppError(
      409,
      "PLUGIN_RELEASE_UNAVAILABLE",
      "This plugin release is not available for this Core.",
    );
  if (installed && semver.lt(release.version, installed.version))
    throw new AppError(
      409,
      "PLUGIN_DOWNGRADE_NOT_AUTOMATIC",
      "A plugin downgrade requires a manual procedure.",
    );
  const artifactUrl = assertGitHubArtifactUrl(
    release.artifactUrl,
    release.owner,
    release.repository,
  );
  const response = await fetchGitHubArtifact(artifactUrl);
  if (!response.ok)
    throw new AppError(
      502,
      "PLUGIN_DOWNLOAD_FAILED",
      "GitHub did not return the plugin package.",
    );
  const bytes = await readBoundedBytes(response, MAX_PLUGIN_PACKAGE_BYTES);
  const manifest = pluginManifestSchema.parse(
    parseJson<unknown>(release.manifest, null),
  );
  const compatibility = marketplaceReleaseCompatibility(
    manifest,
    c.env.APP_VERSION,
    c.env.PLUGIN_COMPATIBILITY_FLAGS,
    c.env.DATABASE_PROVIDER,
  );
  if (!compatibility.compatible)
    throw new AppError(
      409,
      "PLUGIN_RELEASE_INCOMPATIBLE",
      "This plugin release is not compatible with this Core.",
    );
  try {
    await verifyReleaseArtifact(
      bytes,
      {
        version: release.version,
        channel: release.channel,
        manifest,
        artifact: {
          url: release.artifactUrl,
          sha256: release.artifactSha256,
          signature: release.artifactSignature,
          bytes: Number(release.packageBytes),
        },
      },
      release.publicKey,
    );
  } catch {
    throw new AppError(
      422,
      "PLUGIN_RELEASE_VERIFICATION_FAILED",
      "The downloaded plugin failed signature or integrity verification.",
    );
  }
  await audit(
    c,
    "core.marketplace.package_verified",
    "core.plugin",
    release.pluginId,
    {
      releaseId: release.id,
      version: release.version,
    },
  );
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.byteLength),
      "X-Plugin-Release-Id": release.id,
      "X-Plugin-SHA256": await sha256(bytes),
    },
  });
});
