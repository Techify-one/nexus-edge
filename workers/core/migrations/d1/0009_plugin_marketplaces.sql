-- Runtime-discovered plugin UI, GitHub marketplaces, and extensible resources.
-- The default marketplace is soft-deleted so a later Core migration cannot
-- silently recreate an administrator-removed source.

CREATE TABLE IF NOT EXISTS plugin_marketplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  repository_id TEXT,
  source_ref TEXT NOT NULL DEFAULT 'main',
  catalog_path TEXT NOT NULL DEFAULT 'nexus-marketplace.json',
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  trust_state TEXT NOT NULL DEFAULT 'pending' CHECK (trust_state IN ('pending','trusted','error')),
  trusted_public_key TEXT,
  key_fingerprint TEXT,
  etag TEXT,
  catalog_json TEXT,
  catalog_expires_at INTEGER,
  retry_after_at INTEGER,
  credential_ref TEXT,
  last_synced_at INTEGER,
  last_error_code TEXT,
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner, repository, source_ref, catalog_path)
);

INSERT OR IGNORE INTO plugin_marketplaces(
  id, name, owner, repository, source_ref, catalog_path, enabled, is_default,
  trust_state, created_at, updated_at
) VALUES (
  'mkt_techify', 'Techify', 'Techify-one', 'nexus-edge-plugins', 'main',
  'nexus-marketplace.json', 1, 1, 'pending',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);

CREATE TABLE IF NOT EXISTS plugin_marketplace_keys (
  marketplace_id TEXT NOT NULL REFERENCES plugin_marketplaces(id),
  key_id TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','retired')),
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(marketplace_id, key_id)
);

CREATE TABLE IF NOT EXISTS plugin_catalog_snapshots (
  id TEXT PRIMARY KEY,
  marketplace_id TEXT NOT NULL REFERENCES plugin_marketplaces(id),
  revision TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  etag TEXT,
  catalog_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(marketplace_id, revision)
);

CREATE TABLE IF NOT EXISTS plugin_releases (
  id TEXT PRIMARY KEY,
  marketplace_id TEXT NOT NULL REFERENCES plugin_marketplaces(id),
  plugin_id TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  publisher_name TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable',
  description TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,
  artifact_url TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_signature TEXT NOT NULL,
  package_bytes INTEGER,
  compatible INTEGER NOT NULL DEFAULT 1,
  compatibility_reason TEXT,
  published_at INTEGER,
  discovered_at INTEGER NOT NULL,
  UNIQUE(marketplace_id, plugin_id, channel, version)
);
CREATE INDEX IF NOT EXISTS plugin_releases_catalog_idx
  ON plugin_releases(plugin_id, channel, discovered_at);

CREATE TABLE IF NOT EXISTS plugin_assets (
  plugin_id TEXT NOT NULL,
  release_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(plugin_id, release_hash, path)
);
CREATE INDEX IF NOT EXISTS plugin_assets_active_idx
  ON plugin_assets(plugin_id, active, path);
CREATE INDEX IF NOT EXISTS plugin_assets_operation_idx
  ON plugin_assets(operation_id, path);

CREATE TABLE IF NOT EXISTS plugin_contributions (
  plugin_id TEXT NOT NULL,
  release_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  contribution_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(plugin_id, release_hash, kind, contribution_id)
);

CREATE TABLE IF NOT EXISTS plugin_resources_v2 (
  plugin_id TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  capability_version INTEGER NOT NULL DEFAULT 1,
  binding_name TEXT NOT NULL,
  external_id TEXT,
  external_name TEXT,
  owner_worker_name TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  retention_policy TEXT NOT NULL DEFAULT 'preserve',
  declaration_json TEXT NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  preserved_at INTEGER,
  PRIMARY KEY(plugin_id, logical_name),
  UNIQUE(plugin_id, binding_name)
);

INSERT OR IGNORE INTO plugin_resources_v2(
  plugin_id, logical_name, resource_type, binding_name, external_name,
  required, status, retention_policy, declaration_json, created_at,
  updated_at, preserved_at
)
SELECT plugin_id, 'storage', 'r2', binding_name, external_name, 1, status,
       'preserve', '{"type":"r2","binding":"STORAGE"}', created_at,
       updated_at, preserved_at
  FROM plugin_runtime_resources;

CREATE TABLE IF NOT EXISTS plugin_dependency_locks (
  plugin_id TEXT NOT NULL,
  dependency_plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  marketplace_id TEXT,
  release_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(plugin_id, dependency_plugin_id)
);

ALTER TABLE plugins ADD COLUMN package_format INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plugins ADD COLUMN marketplace_id TEXT;
ALTER TABLE plugins ADD COLUMN publisher_id TEXT;
ALTER TABLE plugins ADD COLUMN release_id TEXT;
ALTER TABLE plugins ADD COLUMN release_hash TEXT;
ALTER TABLE plugin_operations ADD COLUMN source_release_id TEXT;
ALTER TABLE plugin_operations ADD COLUMN package_format INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plugin_operations ADD COLUMN assets_sha256 TEXT;

INSERT OR IGNORE INTO permissions(id, key, created_at) VALUES
  ('perm_core_marketplace_read', 'core.marketplace.read', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_marketplace_create', 'core.marketplace.create', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_marketplace_update', 'core.marketplace.update', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('perm_core_marketplace_delete', 'core.marketplace.delete', CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO group_permissions(group_id, permission_id, created_at)
SELECT g.id, p.id, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM groups g CROSS JOIN permissions p
 WHERE g.is_admin = 1 AND p.key LIKE 'core.marketplace.%';
