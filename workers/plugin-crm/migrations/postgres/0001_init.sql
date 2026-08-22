CREATE TABLE IF NOT EXISTS crm_leads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, company TEXT,
  status TEXT NOT NULL CHECK (status IN ('new','qualified','won','lost')), notes TEXT,
  owner_user_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_leads_status_idx ON crm_leads(status, updated_at);
CREATE INDEX IF NOT EXISTS crm_leads_owner_idx ON crm_leads(owner_user_id, updated_at);
CREATE TABLE IF NOT EXISTS crm_activities (
  id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL, body TEXT, actor_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_activities_lead_idx ON crm_activities(lead_id, created_at);
