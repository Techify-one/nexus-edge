CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  phone TEXT, telegram_id TEXT, job_title TEXT, birth_date TEXT, cpf TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  sectors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sectors_json)),
  notes TEXT, status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','pending')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_work_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  daily_hours_json TEXT NOT NULL CHECK (json_valid(daily_hours_json)),
  entry_times_json TEXT NOT NULL CHECK (json_valid(entry_times_json)),
  effective_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_work_schedules_user_effective_idx
  ON user_work_schedules(user_id, effective_at DESC, created_at DESC);

INSERT OR IGNORE INTO user_profiles(user_id, status, created_at, updated_at)
SELECT id, CASE WHEN active = 1 THEN 'active' ELSE 'inactive' END, created_at, updated_at
FROM "user";
