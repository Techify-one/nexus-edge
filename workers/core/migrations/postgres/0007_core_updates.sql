CREATE TABLE IF NOT EXISTS core_update_operations (
  operation_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  target_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('migrating','deploying','verifying','installed','failed')),
  restore_timestamp TIMESTAMPTZ,
  last_error TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS core_update_operations_state_idx
  ON core_update_operations(state, updated_at);

INSERT INTO permissions(id, key, created_at) VALUES
  ('perm_core_settings_read', 'core.settings.read', NOW()),
  ('perm_core_settings_update', 'core.settings.update', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO group_permissions(group_id, permission_id, created_at)
SELECT groups.id, permissions.id, NOW()
FROM groups CROSS JOIN permissions
WHERE groups.is_admin = TRUE
  AND permissions.key IN ('core.settings.read', 'core.settings.update')
ON CONFLICT (group_id, permission_id) DO NOTHING;
