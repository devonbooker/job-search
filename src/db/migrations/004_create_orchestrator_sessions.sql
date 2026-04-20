CREATE TABLE IF NOT EXISTS orchestrator_sessions (
  session_id UUID PRIMARY KEY,
  stage TEXT NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
