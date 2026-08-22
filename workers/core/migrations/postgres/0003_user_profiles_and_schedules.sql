CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  phone TEXT, telegram_id TEXT, job_title TEXT, birth_date TEXT, cpf TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]', sectors_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT, status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','pending')),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS user_work_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  daily_hours_json TEXT NOT NULL, entry_times_json TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS user_work_schedules_user_effective_idx
  ON user_work_schedules(user_id, effective_at DESC, created_at DESC);

INSERT INTO user_profiles(user_id, status, created_at, updated_at)
SELECT id, CASE WHEN active THEN 'active' ELSE 'inactive' END, created_at, updated_at
FROM "user" ON CONFLICT (user_id) DO NOTHING;
