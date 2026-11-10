ALTER TABLE mcp_oauth_codes ADD COLUMN auto_sync_actions INTEGER NOT NULL DEFAULT 0 CHECK (auto_sync_actions IN (0,1));
ALTER TABLE mcp_oauth_grants ADD COLUMN auto_sync_actions INTEGER NOT NULL DEFAULT 0 CHECK (auto_sync_actions IN (0,1));
