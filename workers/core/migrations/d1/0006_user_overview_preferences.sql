CREATE TABLE IF NOT EXISTS user_overview_preferences (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  updated_at INTEGER NOT NULL
);
