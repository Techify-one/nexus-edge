CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE, image TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, ip_address TEXT, user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL DEFAULT 'local:credential', account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  access_token TEXT, refresh_token TEXT, access_token_expires_at TIMESTAMPTZ, refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT, id_token TEXT, password TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(issuer, account_id)
);
CREATE INDEX IF NOT EXISTS account_user_idx ON account(user_id);
CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
CREATE TABLE IF NOT EXISTS "rateLimit" (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS apikey (
  id TEXT PRIMARY KEY, config_id TEXT NOT NULL DEFAULT 'default', name TEXT, start TEXT, prefix TEXT,
  key TEXT NOT NULL, reference_id TEXT NOT NULL, refill_interval INTEGER, refill_amount INTEGER,
  last_refill_at TIMESTAMPTZ, enabled BOOLEAN DEFAULT TRUE, rate_limit_enabled BOOLEAN DEFAULT TRUE,
  rate_limit_time_window INTEGER, rate_limit_max INTEGER, request_count INTEGER DEFAULT 0,
  remaining INTEGER, last_request TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, permissions TEXT, metadata TEXT
);
CREATE INDEX IF NOT EXISTS apikey_reference_idx ON apikey(reference_id);
CREATE INDEX IF NOT EXISTS apikey_config_idx ON apikey(config_id);

CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY CHECK (id = 'system'), installation_id TEXT NOT NULL,
  database_provider TEXT NOT NULL CHECK (database_provider IN ('d1','postgres')),
  schema_version INTEGER NOT NULL, bootstrap_state TEXT NOT NULL CHECK (bootstrap_state IN ('open','claimed','complete')),
  bootstrap_email TEXT, bootstrap_claimed_at TIMESTAMPTZ, first_admin_user_id TEXT, bootstrap_completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS user_invitations (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, invited_by_user_id TEXT NOT NULL,
  group_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb, expires_at TIMESTAMPTZ NOT NULL,
  reserved_at TIMESTAMPTZ, used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS invitation_state_idx ON user_invitations(email, used_at, revoked_at);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS permissions (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members(user_id);
CREATE TABLE IF NOT EXISTS group_permissions (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(group_id, permission_id)
);
CREATE INDEX IF NOT EXISTS group_permissions_group_idx ON group_permissions(group_id);

CREATE TABLE IF NOT EXISTS api_reauth_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, auth_method TEXT NOT NULL, credential_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS reauth_user_expiry_idx ON api_reauth_tokens(user_id, expires_at);
CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  user_id TEXT NOT NULL, method TEXT NOT NULL, route_key TEXT NOT NULL, idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL, response_status INTEGER NOT NULL, response_body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(user_id, method, route_key, idempotency_key_hash)
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON api_idempotency_keys(expires_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT, auth_method TEXT, credential_id TEXT,
  action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS audit_user_created_idx ON audit_log(user_id, created_at);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, installed_version TEXT, api_version INTEGER NOT NULL,
  database_dialects_json JSONB NOT NULL, active_database_provider TEXT NOT NULL, worker_name TEXT NOT NULL,
  status TEXT NOT NULL, manifest_json JSONB NOT NULL, installed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_operations (
  operation_id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, type TEXT NOT NULL, target_version TEXT NOT NULL,
  target_api_version INTEGER NOT NULL, database_provider TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
  worker_sha256 TEXT NOT NULL, d1_migrations_sha256 TEXT NOT NULL, postgres_migrations_sha256 TEXT NOT NULL,
  state TEXT NOT NULL, lock_acquired_at TIMESTAMPTZ, lock_expires_at TIMESTAMPTZ, last_error TEXT,
  created_by_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS plugin_operations_plugin_idx ON plugin_operations(plugin_id, created_at);
CREATE INDEX IF NOT EXISTS plugin_operations_state_idx ON plugin_operations(state, lock_expires_at);
CREATE TABLE IF NOT EXISTS plugin_migrations (
  plugin_id TEXT NOT NULL, dialect TEXT NOT NULL, migration_id TEXT NOT NULL,
  sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(plugin_id, dialect, migration_id)
);
CREATE TABLE IF NOT EXISTS installer_lock (
  id TEXT PRIMARY KEY CHECK (id = 'global'), operation_id TEXT, acquired_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
);
INSERT INTO installer_lock(id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS core_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, event_version INTEGER NOT NULL,
  resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, resource_version INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL, auth_method TEXT NOT NULL, request_id TEXT NOT NULL,
  payload_text TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ, enqueued_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS core_events_status_idx ON core_events(status, lease_expires_at, created_at);
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, host TEXT NOT NULL,
  url_ciphertext TEXT NOT NULL, event_types_json JSONB NOT NULL, secret_ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL, key_version INTEGER NOT NULL, previous_secret_ciphertext TEXT,
  previous_expires_at TIMESTAMPTZ, created_by_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, disabled_reason TEXT
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, last_status_code INTEGER,
  last_error TEXT, response_body_sha256 TEXT, response_size INTEGER, delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE(endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_delivery_status_idx ON webhook_deliveries(status, next_attempt_at);
