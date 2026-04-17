DO $$ BEGIN
  CREATE TYPE job_stage AS ENUM (
    'not_applied',
    'applied',
    'phone_screening',
    'interview',
    'booked',
    'offer_received',
    'accepted',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  job_title TEXT NOT NULL,
  company TEXT NOT NULL,
  link TEXT NOT NULL,
  stage job_stage NOT NULL DEFAULT 'not_applied',
  source TEXT,
  notes TEXT
);
