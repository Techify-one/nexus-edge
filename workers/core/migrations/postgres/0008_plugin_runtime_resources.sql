CREATE TABLE IF NOT EXISTS plugin_runtime_resources (
  plugin_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('r2')),
  binding_name TEXT NOT NULL CHECK (binding_name = 'STORAGE'),
  external_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('provisioning','ready','preserving','preserved','missing','error')),
  created_by_operation_id TEXT NOT NULL,
  last_verified_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  preserved_at TIMESTAMPTZ,
  PRIMARY KEY (plugin_id, binding_name)
);

CREATE INDEX IF NOT EXISTS plugin_runtime_resources_status_idx
  ON plugin_runtime_resources(status, updated_at);
