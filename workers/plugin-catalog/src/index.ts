import type { CatalogSource, Env, PublicCatalogPlugin } from "./env.js";
import { discoverCatalogSources } from "./github.js";
import { renderCatalogPage } from "./render.js";

const noStore = { "Cache-Control": "no-store" };
const pluginIdPattern = /^[a-z][a-z0-9_]{1,31}$/u;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: {
      ...noStore,
      "X-Content-Type-Options": "nosniff",
    },
  });

const repositoryUrl = (env: Env): string =>
  `https://github.com/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}`;

const cacheSeconds = (env: Env): number => {
  const parsed = Number.parseInt(env.CATALOG_CACHE_SECONDS, 10);
  return Number.isInteger(parsed) && parsed >= 30 && parsed <= 900
    ? parsed
    : 60;
};

const catalogCacheKey = (env: Env): Request =>
  new Request(
    `https://catalog-cache.invalid/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}/${encodeURIComponent(env.GITHUB_REF)}`,
  );

type CloudflareCacheStorage = CacheStorage & { default: Cache };

let memoryFallback:
  { cacheKey: string; expiresAt: number; sources: CatalogSource[] } | undefined;

export const loadCatalogSources = async (
  env: Env,
  context?: ExecutionContext,
): Promise<CatalogSource[]> => {
  const seconds = cacheSeconds(env);
  const edgeCache =
    typeof caches === "undefined"
      ? undefined
      : (caches as CloudflareCacheStorage).default;
  const key = catalogCacheKey(env);
  const cached = await edgeCache?.match(key);
  if (cached?.ok) return (await cached.json()) as CatalogSource[];
  if (
    memoryFallback?.cacheKey === key.url &&
    memoryFallback.expiresAt > Date.now()
  )
    return memoryFallback.sources;

  const sources = await discoverCatalogSources(env);
  memoryFallback = {
    cacheKey: key.url,
    expiresAt: Date.now() + seconds * 1_000,
    sources,
  };
  if (edgeCache && context) {
    const response = Response.json(sources, {
      headers: {
        "Cache-Control": `public, max-age=${seconds}, stale-while-revalidate=300`,
      },
    });
    context.waitUntil(edgeCache.put(key, response));
  }
  return sources;
};

const loadDownloadCounts = async (
  env: Env,
  ids: string[],
): Promise<Map<string, number>> => {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT plugin_id AS pluginId, download_count AS downloads
       FROM plugin_catalog_downloads
      WHERE plugin_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ pluginId: string; downloads: number }>();
  return new Map(
    result.results.map((row) => [row.pluginId, Number(row.downloads) || 0]),
  );
};

const toPublicPlugins = async (
  env: Env,
  sources: CatalogSource[],
): Promise<PublicCatalogPlugin[]> => {
  const counts = await loadDownloadCounts(
    env,
    sources.map(({ id }) => id),
  );
  return sources.map(({ archiveUrl: _archiveUrl, ...source }) => ({
    ...source,
    downloads: counts.get(source.id) ?? 0,
    downloadUrl: `/download/${source.id}`,
  }));
};

const incrementDownload = async (env: Env, pluginId: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO plugin_catalog_downloads(plugin_id, download_count, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(plugin_id) DO UPDATE SET
       download_count = plugin_catalog_downloads.download_count + 1,
       updated_at = excluded.updated_at`,
  )
    .bind(pluginId, Date.now())
    .run();
};

const serveDownload = async (
  plugin: CatalogSource,
  env: Env,
): Promise<Response> => {
  const upstream = await fetch(plugin.archiveUrl, {
    headers: {
      Accept: "application/zip, application/octet-stream",
      "User-Agent": "nexus-edge-plugin-catalog",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!upstream.ok || !upstream.body)
    return json(
      { error: "plugin_download_unavailable", status: upstream.status },
      502,
    );

  await incrementDownload(env, plugin.id);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${plugin.id}.plugin.zip"`,
    "Content-Type": "application/zip",
    "X-Content-Type-Options": "nosniff",
  });
  const contentLength = upstream.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  return new Response(upstream.body, { status: 200, headers });
};

const securityHeaders = (nonce: string): HeadersInit => ({
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
});

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD")
      return json({ error: "method_not_allowed" }, 405);

    if (url.pathname === "/health")
      return json({
        ok: true,
        service: "nexus-edge-plugin-catalog",
        source: `${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}@${env.GITHUB_REF}`,
      });

    try {
      const sources = await loadCatalogSources(env, context);
      if (url.pathname === "/api/plugins")
        return json({ plugins: await toPublicPlugins(env, sources) });

      const downloadMatch = /^\/download\/([^/]+)$/u.exec(url.pathname);
      if (downloadMatch) {
        if (request.method !== "GET")
          return json({ error: "method_not_allowed" }, 405);
        const id = downloadMatch[1] ?? "";
        if (!pluginIdPattern.test(id))
          return json({ error: "plugin_not_found" }, 404);
        const plugin = sources.find((candidate) => candidate.id === id);
        return plugin
          ? await serveDownload(plugin, env)
          : json({ error: "plugin_not_found" }, 404);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const plugins = await toPublicPlugins(env, sources);
        const nonce = crypto.randomUUID().replaceAll("-", "");
        return new Response(
          request.method === "HEAD"
            ? null
            : renderCatalogPage(plugins, repositoryUrl(env), nonce),
          { status: 200, headers: securityHeaders(nonce) },
        );
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("Plugin catalog request failed", error);
      return json({ error: "catalog_unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
