CREATE TABLE IF NOT EXISTS plugin_package_chunks (
  operation_id TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id, path, chunk_index)
);

INSERT OR IGNORE INTO permissions(id, key, created_at)
VALUES (
  'perm_core_plugin_export',
  'core.plugin.export',
  CAST(strftime('%s','now') AS INTEGER) * 1000
);

INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT g.id, p.id, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM groups g
JOIN permissions p ON p.key = 'core.plugin.export'
WHERE g.is_admin = 1;
