CREATE TABLE IF NOT EXISTS research_lead_sessions (
  session_id UUID PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
