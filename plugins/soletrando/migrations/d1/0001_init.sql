CREATE TABLE IF NOT EXISTS soletrando_children (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS soletrando_children_token_idx ON soletrando_children(token);
CREATE UNIQUE INDEX IF NOT EXISTS soletrando_children_name_idx ON soletrando_children(lower(name));

CREATE TABLE IF NOT EXISTS soletrando_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  child_id TEXT NOT NULL REFERENCES soletrando_children(id) ON DELETE CASCADE,
  phase INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  score INTEGER,
  correct_count INTEGER NOT NULL DEFAULT 0,
  total_time_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS soletrando_sessions_child_idx ON soletrando_sessions(child_id);
CREATE INDEX IF NOT EXISTS soletrando_sessions_child_phase_idx ON soletrando_sessions(child_id, phase);
CREATE UNIQUE INDEX IF NOT EXISTS soletrando_sessions_one_active_idx ON soletrando_sessions(child_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS soletrando_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES soletrando_sessions(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES soletrando_children(id) ON DELETE CASCADE,
  phase INTEGER NOT NULL,
  position INTEGER NOT NULL,
  word TEXT NOT NULL,
  transcript TEXT NOT NULL,
  normalized TEXT NOT NULL,
  is_correct INTEGER NOT NULL,
  accuracy_score REAL NOT NULL,
  speed_score REAL NOT NULL,
  total_score INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS soletrando_attempts_session_position_idx ON soletrando_attempts(session_id, position);
CREATE INDEX IF NOT EXISTS soletrando_attempts_child_idx ON soletrando_attempts(child_id);
