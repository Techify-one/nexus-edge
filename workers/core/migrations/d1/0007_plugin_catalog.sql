CREATE TABLE IF NOT EXISTS plugin_catalog_downloads (
  plugin_id TEXT PRIMARY KEY,
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  updated_at INTEGER NOT NULL
);
