-- Only additive DDL is permitted.
CREATE TABLE IF NOT EXISTS template_records (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
