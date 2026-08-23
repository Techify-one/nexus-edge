export interface Env {
  DB: D1Database;
  GITHUB_OWNER: string;
  GITHUB_REPOSITORY: string;
  GITHUB_REF: string;
  CATALOG_CACHE_SECONDS: string;
}

export interface CatalogSource {
  id: string;
  name: string;
  version: string;
  coreMinVersion: string;
  category: string;
  description: string;
  archiveSize: number;
  archiveUrl: string;
  sourceUrl: string;
}

export interface PublicCatalogPlugin extends Omit<CatalogSource, "archiveUrl"> {
  downloads: number;
  downloadUrl: string;
}
