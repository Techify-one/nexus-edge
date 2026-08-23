CREATE TABLE IF NOT EXISTS plugin_catalog_source_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
