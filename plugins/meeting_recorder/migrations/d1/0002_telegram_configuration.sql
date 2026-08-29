CREATE TABLE IF NOT EXISTS meeting_recorder_telegram_configuration (
  id TEXT PRIMARY KEY CHECK (id = 'bot'),
  bot_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
