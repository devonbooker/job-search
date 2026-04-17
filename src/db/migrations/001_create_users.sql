CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  goals TEXT,
  resume_raw TEXT,
  resume_built JSONB,
  target_job_titles TEXT[]
);
