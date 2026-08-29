CREATE TABLE IF NOT EXISTS meeting_recorder_telegram_invitations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_telegram_id TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
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
  linked_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS meeting_recorder_telegram_members_owner_idx
  ON meeting_recorder_telegram_members(owner_user_id, revoked_at, linked_at);
