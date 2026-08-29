CREATE TABLE IF NOT EXISTS meeting_recorder_telegram_invitations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_telegram_id TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS meeting_recorder_telegram_invitations_owner_idx
  ON meeting_recorder_telegram_invitations(owner_user_id, created_at);

CREATE INDEX IF NOT EXISTS meeting_recorder_telegram_invitations_expires_idx
  ON meeting_recorder_telegram_invitations(expires_at);

CREATE TABLE IF NOT EXISTS meeting_recorder_telegram_members (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  telegram_display_name TEXT,
  label TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS meeting_recorder_telegram_members_owner_idx
  ON meeting_recorder_telegram_members(owner_user_id, revoked_at, linked_at);
