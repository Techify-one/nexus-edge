import type { CatalogSource, Env } from "./env.js";

type Fetcher = typeof fetch;

interface GitTreeEntry {
  path?: unknown;
  type?: unknown;
  size?: unknown;
  sha?: unknown;
}

interface GitTreeResponse {
  truncated?: unknown;
  tree?: unknown;
}

interface PluginManifestInput {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  coreMinVersion?: unknown;
}

interface PluginCatalogInput {
  category?: unknown;
  description?: unknown;
}

const pluginIdPattern = /^[a-z][a-z0-9_]{1,31}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const requiredString = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string => {
  if (
    typeof value !== "string" ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  )
    throw new Error(`${label} is invalid`);
  return value.trim();
};

const rawFileUrl = (env: Env, path: string, blobSha: string): string =>
  `https://raw.githubusercontent.com/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}/${encodeURIComponent(env.GITHUB_REF)}/${path}?blob=${encodeURIComponent(blobSha)}`;

const repositoryFileUrl = (env: Env, path: string): string =>
  `https://github.com/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}/tree/${encodeURIComponent(env.GITHUB_REF)}/${path}`;

const fetchJson = async <T>(
  fetcher: Fetcher,
  url: string,
  label: string,
): Promise<T> => {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "nexus-edge-plugin-catalog",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}`);
  return (await response.json()) as T;
};

export const discoverCatalogSources = async (
  env: Env,
  fetcher: Fetcher = fetch,
): Promise<CatalogSource[]> => {
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}/git/trees/${encodeURIComponent(env.GITHUB_REF)}?recursive=1`;
  const payload = await fetchJson<GitTreeResponse>(
    fetcher,
    treeUrl,
    "GitHub repository tree",
  );
  if (payload.truncated === true)
    throw new Error("GitHub repository tree is truncated");
  if (!Array.isArray(payload.tree))
    throw new Error("GitHub repository tree is invalid");

  const files = new Map<string, { size: number; sha: string }>();
  for (const candidate of payload.tree as GitTreeEntry[]) {
    if (
      candidate.type !== "blob" ||
      typeof candidate.path !== "string" ||
      typeof candidate.sha !== "string"
    )
      continue;
    files.set(candidate.path, {
      size:
        typeof candidate.size === "number" &&
        Number.isSafeInteger(candidate.size)
          ? candidate.size
          : 0,
      sha: candidate.sha,
    });
  }

  const pluginIds = [...files.keys()]
    .flatMap((path) => {
      const match = /^plugins\/([a-z][a-z0-9_]{1,31})\/catalog\.json$/u.exec(
        path,
      );
      return match?.[1] ? [match[1]] : [];
    })
    .sort();

  return Promise.all(
    pluginIds.map(async (id): Promise<CatalogSource> => {
      if (!pluginIdPattern.test(id)) throw new Error(`Invalid plugin ID ${id}`);
      const manifestPath = `plugins/${id}/manifest.json`;
      const catalogPath = `plugins/${id}/catalog.json`;
      const archivePath = `plugins/${id}/release/${id}.plugin.zip`;
      const manifestFile = files.get(manifestPath);
      const catalogFile = files.get(catalogPath);
      const archiveFile = files.get(archivePath);
      if (!manifestFile || !catalogFile || !archiveFile)
        throw new Error(`Plugin ${id} has an incomplete catalog contract`);

      const [manifest, catalog] = await Promise.all([
        fetchJson<PluginManifestInput>(
          fetcher,
          rawFileUrl(env, manifestPath, manifestFile.sha),
          `${id} manifest`,
        ),
        fetchJson<PluginCatalogInput>(
          fetcher,
          rawFileUrl(env, catalogPath, catalogFile.sha),
          `${id} catalog metadata`,
        ),
      ]);
      if (manifest.id !== id)
        throw new Error(
          `Plugin ${id} manifest ID does not match its directory`,
        );
      const version = requiredString(manifest.version, `${id} version`, 5, 40);
      const coreMinVersion = requiredString(
        manifest.coreMinVersion,
        `${id} Core minimum version`,
        5,
        40,
      );
      if (!versionPattern.test(version) || !versionPattern.test(coreMinVersion))
        throw new Error(`Plugin ${id} has an invalid version`);

      return {
        id,
        name: requiredString(manifest.name, `${id} name`, 2, 80),
        version,
        coreMinVersion,
        category: requiredString(catalog.category, `${id} category`, 2, 80),
        description: requiredString(
          catalog.description,
          `${id} description`,
          20,
          300,
        ),
        archiveSize: archiveFile.size,
        archiveUrl: rawFileUrl(env, archivePath, archiveFile.sha),
        sourceUrl: repositoryFileUrl(env, `plugins/${id}`),
      };
    }),
  );
};
