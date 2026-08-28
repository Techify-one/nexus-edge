CREATE TABLE IF NOT EXISTS meeting_recorder_recordings (
  id TEXT PRIMARY KEY,
  client_session_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ingest_source TEXT NOT NULL CHECK (ingest_source IN ('live','upload','telegram')),
  external_source_id TEXT,
  original_file_name TEXT,
  meeting_platform TEXT CHECK (meeting_platform IS NULL OR meeting_platform IN ('meet','zoom_web','teams_web','other')),
  source_type TEXT NOT NULL CHECK (source_type IN ('microphone','tab','display','microphone_tab','microphone_display','file_upload','telegram_voice','telegram_audio')),
  capture_status TEXT NOT NULL CHECK (capture_status IN ('recording','paused','interrupted','finalizing','complete','deleting')),
  transcription_status TEXT NOT NULL CHECK (transcription_status IN ('off','pending','processing','ready','partial','quota_wait','failed')),
  language TEXT NOT NULL CHECK (language IN ('pt-BR','en','auto')),
  mime_type TEXT NOT NULL,
  bitrate_bps INTEGER,
  segment_duration_ms INTEGER NOT NULL,
  auto_transcribe INTEGER NOT NULL DEFAULT 1 CHECK (auto_transcribe IN (0,1)),
  consent_version TEXT NOT NULL,
  consent_acknowledged_at INTEGER NOT NULL,
  expected_last_sequence INTEGER,
  has_gaps INTEGER NOT NULL DEFAULT 0 CHECK (has_gaps IN (0,1)),
  missing_segment_count INTEGER NOT NULL DEFAULT 0,
  stored_segment_count INTEGER NOT NULL DEFAULT 0,
  transcribed_segment_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  stored_duration_ms INTEGER NOT NULL DEFAULT 0,
  timeline_duration_ms INTEGER NOT NULL DEFAULT 0,
  paused_duration_ms INTEGER NOT NULL DEFAULT 0,
  gap_duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  last_segment_at INTEGER,
  last_heartbeat_at INTEGER,
  deletion_operation_id TEXT,
  deletion_requested_by_user_id TEXT,
  deleted_segment_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, client_session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_recorder_one_live_capture_idx
  ON meeting_recorder_recordings(owner_user_id)
  WHERE ingest_source = 'live' AND capture_status IN ('recording','paused');
CREATE INDEX IF NOT EXISTS meeting_recorder_recordings_owner_started_idx
  ON meeting_recorder_recordings(owner_user_id, started_at, id);
CREATE INDEX IF NOT EXISTS meeting_recorder_recordings_capture_idx
  ON meeting_recorder_recordings(capture_status, updated_at);
CREATE INDEX IF NOT EXISTS meeting_recorder_recordings_heartbeat_idx
  ON meeting_recorder_recordings(capture_status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS meeting_recorder_recordings_transcription_idx
  ON meeting_recorder_recordings(transcription_status, updated_at);

CREATE TABLE IF NOT EXISTS meeting_recorder_segments (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES meeting_recorder_recordings(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  r2_etag TEXT,
  r2_version TEXT,
  storage_status TEXT NOT NULL CHECK (storage_status IN ('uploading','stored','missing','failed','deleting')),
  transcription_status TEXT NOT NULL CHECK (transcription_status IN ('not_requested','pending','processing','ready','quota_wait','failed')),
  transcript_text TEXT,
  transcript_vtt TEXT,
  transcription_attempts INTEGER NOT NULL DEFAULT 0,
  transcription_lease_token TEXT,
  transcription_lease_expires_at INTEGER,
  transcription_next_retry_at INTEGER,
  transcription_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stored_at INTEGER,
  transcribed_at INTEGER,
  UNIQUE (recording_id, sequence)
);

CREATE INDEX IF NOT EXISTS meeting_recorder_segments_storage_idx
  ON meeting_recorder_segments(recording_id, storage_status, sequence);
CREATE INDEX IF NOT EXISTS meeting_recorder_segments_transcription_idx
  ON meeting_recorder_segments(recording_id, transcription_status, sequence);
CREATE INDEX IF NOT EXISTS meeting_recorder_segments_retry_idx
  ON meeting_recorder_segments(transcription_status, transcription_next_retry_at);

CREATE TABLE IF NOT EXISTS meeting_recorder_settings (
  scope TEXT PRIMARY KEY CHECK (scope = 'global'),
  default_language TEXT NOT NULL CHECK (default_language IN ('pt-BR','en','auto')),
  auto_transcribe INTEGER NOT NULL CHECK (auto_transcribe IN (0,1)),
  maximum_minutes INTEGER NOT NULL CHECK (maximum_minutes BETWEEN 1 AND 240),
  storage_limit_bytes INTEGER NOT NULL CHECK (storage_limit_bytes > 0),
  version INTEGER NOT NULL DEFAULT 1,
  updated_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_recorder_deletion_tombstones (
  recording_id TEXT PRIMARY KEY,
  owner_subject_hash TEXT NOT NULL,
  requester_subject_hash TEXT NOT NULL,
  deletion_operation_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meeting_recorder_tombstones_expiry_idx
  ON meeting_recorder_deletion_tombstones(expires_at);

CREATE TABLE IF NOT EXISTS meeting_recorder_ingest_events (
  source TEXT NOT NULL CHECK (source IN ('telegram')),
  external_event_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  owner_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing','stored','transcribed','ignored','failed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, external_event_id)
);
CREATE INDEX IF NOT EXISTS meeting_recorder_ingest_status_idx
  ON meeting_recorder_ingest_events(status, updated_at);
