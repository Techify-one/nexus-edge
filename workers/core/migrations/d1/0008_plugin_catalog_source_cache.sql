CREATE TABLE IF NOT EXISTS plugin_catalog_source_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at INTEGER NOT NULL
);
