CREATE TABLE IF NOT EXISTS plugin_catalog_downloads (
  plugin_id TEXT PRIMARY KEY,
  download_count BIGINT NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  updated_at BIGINT NOT NULL
);
