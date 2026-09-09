import { Hono, type Context } from "hono";
import type { HonoEnv } from "../env.js";
import { sha256 } from "@app/webhook-contract";
import { canPermission } from "../lib/ability.js";
import { AppError, noStore } from "../lib/http.js";
import { parseJson } from "../lib/values.js";
import { requirePermission } from "../middleware/auth.js";
import {
  pluginManifestSchema,
  type PluginManifest,
} from "../installer/manifest.js";
import { decodePackageFile } from "../installer/package-v2.js";

type RuntimePluginRow = {
  id: string;
  name: string;
  installedVersion: string;
  manifest: unknown;
  releaseHash: string | null;
};

const manifestFromRow = (row: RuntimePluginRow): PluginManifest | null => {
  const parsed = pluginManifestSchema.safeParse(
    parseJson<unknown>(row.manifest, null),
  );
  return parsed.success ? parsed.data : null;
};

const visibleToUser = (
  c: Context<HonoEnv>,
  manifest: PluginManifest,
): boolean =>
  manifest.permissions.length === 0 ||
  manifest.permissions.some((permission) =>
    canPermission(c.get("ability"), permission),
  );

const publicRouteMatches = (template: string, pathname: string): boolean => {
  const expected = template.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index]!;
    if (segment === "*") return index === expected.length - 1;
    if (!actual[index]) return false;
    if (!segment.startsWith(":") && segment !== actual[index]) return false;
  }
  return expected.length === actual.length;
};

const archivedAssetBytes = async (
  c: Context<HonoEnv>,
  operationId: string,
  path: string,
): Promise<Uint8Array> => {
  const chunks = await c.get("db").query<{
    chunkIndex: number | string;
    content: string;
  }>(
    `SELECT chunk_index AS "chunkIndex", content
       FROM plugin_package_chunks
      WHERE operation_id = ? AND path = ? ORDER BY chunk_index`,
    [operationId, path],
  );
  if (
    !chunks.length ||
    chunks.some((chunk, index) => Number(chunk.chunkIndex) !== index)
  )
    throw new AppError(
      500,
      "PLUGIN_ASSET_CORRUPT",
      "Plugin asset is unavailable.",
    );
  const archived = chunks.map((chunk) => chunk.content).join("");
  if (!archived.startsWith("base64:"))
    throw new AppError(
      500,
      "PLUGIN_ASSET_CORRUPT",
      "Plugin asset is unavailable.",
    );
  return decodePackageFile(archived.slice("base64:".length));
};

export const pluginRuntimeRoutes = new Hono<HonoEnv>();
export const publicPluginRuntimeRoutes = new Hono<HonoEnv>();

publicPluginRuntimeRoutes.get("/plugin-runtime", async (c) => {
  const pathname = c.req.query("path") ?? "";
  if (
    pathname.length > 500 ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//")
  )
    throw new AppError(
      404,
      "PUBLIC_PLUGIN_ROUTE_NOT_FOUND",
      "Public plugin page not found.",
    );
  const locale = /^en(?:-|,|;|$)/iu.test(c.req.header("Accept-Language") ?? "")
    ? "en"
    : "pt-BR";
  const rows = await c.get("db").query<RuntimePluginRow>(
    `SELECT id, name, installed_version AS "installedVersion",
            manifest_json AS "manifest", release_hash AS "releaseHash"
       FROM plugins
      WHERE status = 'installed' AND package_format = 2 AND release_hash IS NOT NULL
      ORDER BY id`,
  );
  for (const row of rows) {
    const manifest = manifestFromRow(row);
    const route = manifest?.frontend?.publicRoutes.find((candidate) =>
      publicRouteMatches(candidate.path, pathname),
    );
    if (!manifest?.frontend || !row.releaseHash || !route) continue;
    const assetBase = `/api/v1/public/plugin-assets/${encodeURIComponent(row.id)}/${encodeURIComponent(row.releaseHash)}`;
    return c.json(
      {
        hostApi: 1,
        plugin: {
          pluginId: row.id,
          name: manifest.localizedMetadata?.[locale]?.name ?? row.name,
          version: row.installedVersion,
          releaseHash: row.releaseHash,
          entryUrl: `${assetBase}/${manifest.frontend.entry}`,
          styleUrls: manifest.frontend.styles.map(
            (path) => `${assetBase}/${path}`,
          ),
          isolation: manifest.frontend.isolation,
          route,
        },
      },
      200,
      noStore,
    );
  }
  throw new AppError(
    404,
    "PUBLIC_PLUGIN_ROUTE_NOT_FOUND",
    "Public plugin page not found.",
  );
});

publicPluginRuntimeRoutes.get(
  "/plugin-assets/:pluginId/:releaseHash/*",
  async (c) => {
    const pluginId = c.req.param("pluginId");
    const releaseHash = c.req.param("releaseHash");
    const assetPrefix = `/plugin-assets/${pluginId}/${releaseHash}/`;
    const path = c.req.path.includes(assetPrefix)
      ? c.req.path.slice(c.req.path.indexOf(assetPrefix) + assetPrefix.length)
      : "";
    if (
      !/^[a-z][a-z0-9_]{1,31}$/u.test(pluginId) ||
      !/^[A-Za-z0-9_-]{40,100}$/u.test(releaseHash) ||
      !/^frontend\/[A-Za-z0-9_.@/-]+$/u.test(path) ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    )
      throw new AppError(
        404,
        "PLUGIN_ASSET_NOT_FOUND",
        "Plugin asset not found.",
      );
    const asset = await c.get("db").first<{
      contentType: string;
      operationId: string;
      sha256: string;
      byteLength: number | string;
      manifest: unknown;
    }>(
      `SELECT pa.content_type AS "contentType",
              pa.operation_id AS "operationId", pa.sha256,
              pa.byte_length AS "byteLength", p.manifest_json AS manifest
         FROM plugin_assets pa
         JOIN plugins p ON p.id = pa.plugin_id
        WHERE pa.plugin_id = ? AND pa.release_hash = ? AND pa.path = ?
          AND p.status = 'installed' AND p.package_format = 2`,
      [pluginId, releaseHash, path],
    );
    const manifest = asset
      ? pluginManifestSchema.safeParse(parseJson<unknown>(asset.manifest, null))
      : undefined;
    if (
      !asset ||
      !manifest?.success ||
      !manifest.data.frontend?.publicRoutes.length
    )
      throw new AppError(
        404,
        "PLUGIN_ASSET_NOT_FOUND",
        "Plugin asset not found.",
      );
    const bytes = await archivedAssetBytes(c, asset.operationId, path);
    if (
      bytes.byteLength !== Number(asset.byteLength) ||
      (await sha256(bytes)) !== asset.sha256
    )
      throw new AppError(
        500,
        "PLUGIN_ASSET_CORRUPT",
        "Plugin asset is unavailable.",
      );
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body.buffer, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(bytes.byteLength),
        "Content-Type": asset.contentType,
        ETag: `"${asset.sha256}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);

pluginRuntimeRoutes.get(
  "/plugin-openapi",
  requirePermission("core.plugin.read"),
  async (c) => {
    const rows = await c.get("db").query<RuntimePluginRow>(
      `SELECT p.id, p.name, p.installed_version AS "installedVersion",
              p.manifest_json AS manifest, p.release_hash AS "releaseHash"
         FROM plugins p
        WHERE p.status = 'installed' AND p.package_format = 2
          AND p.release_hash IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM plugin_assets pa
             WHERE pa.plugin_id = p.id AND pa.release_hash = p.release_hash
               AND pa.path = 'openapi.json'
          )
        ORDER BY p.name`,
    );
    return c.json(
      {
        items: rows.flatMap((row) => {
          const manifest = manifestFromRow(row);
          return manifest && visibleToUser(c, manifest)
            ? [
                {
                  pluginId: row.id,
                  name: row.name,
                  version: row.installedVersion,
                  url: `/api/v1/plugins/${encodeURIComponent(row.id)}/openapi.json`,
                },
              ]
            : [];
        }),
      },
      200,
      noStore,
    );
  },
);

pluginRuntimeRoutes.get("/plugins/:pluginId/openapi.json", async (c) => {
  const pluginId = c.req.param("pluginId");
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(pluginId))
    throw new AppError(
      404,
      "PLUGIN_OPENAPI_NOT_FOUND",
      "Plugin OpenAPI document not found.",
    );
  const row = await c.get("db").first<{
    operationId: string;
    path: string;
    sha256: string;
    byteLength: number | string;
    manifest: unknown;
  }>(
    `SELECT pa.operation_id AS "operationId", pa.path, pa.sha256,
            pa.byte_length AS "byteLength", p.manifest_json AS manifest
       FROM plugins p JOIN plugin_assets pa
         ON pa.plugin_id = p.id AND pa.release_hash = p.release_hash
      WHERE p.id = ? AND p.status = 'installed' AND p.package_format = 2
        AND pa.path = 'openapi.json'`,
    [pluginId],
  );
  if (!row)
    throw new AppError(
      404,
      "PLUGIN_OPENAPI_NOT_FOUND",
      "Plugin OpenAPI document not found.",
    );
  const manifest = pluginManifestSchema.safeParse(
    parseJson<unknown>(row.manifest, null),
  );
  if (!manifest.success || !visibleToUser(c, manifest.data))
    throw new AppError(
      404,
      "PLUGIN_OPENAPI_NOT_FOUND",
      "Plugin OpenAPI document not found.",
    );
  const bytes = await archivedAssetBytes(c, row.operationId, row.path);
  if (
    bytes.byteLength !== Number(row.byteLength) ||
    (await sha256(bytes)) !== row.sha256
  )
    throw new AppError(
      500,
      "PLUGIN_ASSET_CORRUPT",
      "Plugin asset is unavailable.",
    );
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

pluginRuntimeRoutes.get(
  "/plugin-platform",
  requirePermission("core.plugin.read"),
  (c) =>
    c.json(
      {
        packageFormats: [1, 2],
        manifestVersions: [1, 2],
        hostApis: [1],
        coreApis: [1],
        catalogVersions: [1],
        capabilities: {
          database: [1],
          worker: [1],
          r2: [1],
          kv: [1],
          queue: [1],
          durable_object: [1],
          cron: [1],
          ai: [1],
        },
      },
      200,
      noStore,
    ),
);

pluginRuntimeRoutes.get("/plugin-runtime", async (c) => {
  const locale = /^en(?:-|,|;|$)/iu.test(c.req.header("Accept-Language") ?? "")
    ? "en"
    : "pt-BR";
  const rows = await c.get("db").query<RuntimePluginRow>(
    `SELECT id, name, installed_version AS "installedVersion",
            manifest_json AS "manifest", release_hash AS "releaseHash"
       FROM plugins
      WHERE status = 'installed' AND package_format = 2 AND release_hash IS NOT NULL
      ORDER BY name`,
  );
  const plugins = rows.flatMap((row) => {
    const manifest = manifestFromRow(row);
    if (!manifest?.frontend || !row.releaseHash || !visibleToUser(c, manifest))
      return [];
    const assetBase = `/api/v1/plugin-assets/${encodeURIComponent(row.id)}/${encodeURIComponent(row.releaseHash)}`;
    const routes = manifest.frontend.routes.map((route) => ({
      routeKey: route.routeKey,
      path: route.path,
    }));
    const pathByKey = new Map(
      routes.map((route) => [route.routeKey, route.path]),
    );
    const localized = manifest.localizedMetadata?.[locale];
    return [
      {
        pluginId: row.id,
        name: localized?.name ?? row.name,
        version: row.installedVersion,
        releaseHash: row.releaseHash,
        entryUrl: `${assetBase}/${manifest.frontend.entry}`,
        styleUrls: manifest.frontend.styles.map(
          (path) => `${assetBase}/${path}`,
        ),
        isolation: manifest.frontend.isolation,
        persistentSurface: manifest.frontend.persistentSurface,
        permissions: manifest.permissions.filter((permission) =>
          canPermission(c.get("ability"), permission),
        ),
        localeUrl: `${assetBase}/locales/{locale}.json`,
        routes,
        menu: manifest.menu.map((item) => ({
          title: localized?.menuTitles[item.routeKey] ?? item.title,
          routeKey: item.routeKey,
          path: item.path ?? pathByKey.get(item.routeKey) ?? `/app/p/${row.id}`,
        })),
      },
    ];
  });
  return c.json({ hostApi: 1, plugins }, 200, noStore);
});

pluginRuntimeRoutes.get(
  "/plugin-assets/:pluginId/:releaseHash/*",
  async (c) => {
    const pluginId = c.req.param("pluginId");
    const releaseHash = c.req.param("releaseHash");
    const assetPrefix = `/plugin-assets/${pluginId}/${releaseHash}/`;
    const path = c.req.path.includes(assetPrefix)
      ? c.req.path.slice(c.req.path.indexOf(assetPrefix) + assetPrefix.length)
      : "";
    if (
      !/^[a-z][a-z0-9_]{1,31}$/u.test(pluginId) ||
      !/^[A-Za-z0-9_-]{40,100}$/u.test(releaseHash) ||
      !/^(?:frontend|locales)\/[A-Za-z0-9_.@/-]+$|^openapi\.json$/u.test(
        path,
      ) ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    )
      throw new AppError(
        404,
        "PLUGIN_ASSET_NOT_FOUND",
        "Plugin asset not found.",
      );
    const asset = await c.get("db").first<{
      contentType: string;
      operationId: string;
      sha256: string;
      byteLength: number | string;
      manifest: unknown;
    }>(
      `SELECT pa.content_type AS "contentType",
              pa.operation_id AS "operationId", pa.sha256,
              pa.byte_length AS "byteLength", p.manifest_json AS manifest
         FROM plugin_assets pa
         JOIN plugins p ON p.id = pa.plugin_id
        WHERE pa.plugin_id = ? AND pa.release_hash = ? AND pa.path = ?
          AND p.status = 'installed'`,
      [pluginId, releaseHash, path],
    );
    if (!asset)
      throw new AppError(
        404,
        "PLUGIN_ASSET_NOT_FOUND",
        "Plugin asset not found.",
      );
    const parsedManifest = pluginManifestSchema.safeParse(
      parseJson<unknown>(asset.manifest, null),
    );
    if (!parsedManifest.success || !visibleToUser(c, parsedManifest.data))
      throw new AppError(
        404,
        "PLUGIN_ASSET_NOT_FOUND",
        "Plugin asset not found.",
      );
    const bytes = await archivedAssetBytes(c, asset.operationId, path);
    if (
      bytes.byteLength !== Number(asset.byteLength) ||
      (await sha256(bytes)) !== asset.sha256
    )
      throw new AppError(
        500,
        "PLUGIN_ASSET_CORRUPT",
        "Plugin asset is unavailable.",
      );
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body.buffer, {
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(bytes.byteLength),
        "Content-Type": asset.contentType,
        ETag: `"${asset.sha256}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);
