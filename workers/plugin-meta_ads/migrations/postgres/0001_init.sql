CREATE TABLE IF NOT EXISTS meta_ads_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ad_account_id TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  account_status INTEGER,
  currency TEXT,
  timezone_name TEXT,
  created_by_user_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS meta_ads_accounts_enabled_idx
  ON meta_ads_accounts(enabled, name);
