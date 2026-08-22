CREATE TABLE IF NOT EXISTS user_table_preferences (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, table_id)
);
