CREATE TABLE IF NOT EXISTS soletrando_settings (
  id TEXT PRIMARY KEY NOT NULL,
  transcription_model TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
