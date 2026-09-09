-- Only additive DDL is permitted.
CREATE TABLE IF NOT EXISTS template_records (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
