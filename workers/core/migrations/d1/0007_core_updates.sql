CREATE TABLE IF NOT EXISTS core_update_operations (
  operation_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  target_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('migrating','deploying','verifying','installed','failed')),
  restore_timestamp INTEGER,
  last_error TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES "user"(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS core_update_operations_state_idx
  ON core_update_operations(state, updated_at);

INSERT OR IGNORE INTO permissions(id, key, created_at) VALUES
  ('perm_core_settings_read', 'core.settings.read', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_settings_update', 'core.settings.update', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT groups.id, permissions.id, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM groups CROSS JOIN permissions
WHERE groups.is_admin = 1
  AND permissions.key IN ('core.settings.read', 'core.settings.update');
