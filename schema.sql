-- Bircan Migration PostgreSQL single source of truth schema
-- Run once against your Render PostgreSQL database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_email TEXT NOT NULL,
  applicant_email TEXT NOT NULL,
  applicant_name TEXT,
  visa_type TEXT NOT NULL,
  selected_plan TEXT NOT NULL CHECK (selected_plan IN ('instant','24h','3d')),
  active_plan TEXT NOT NULL CHECK (active_plan IN ('instant','24h','3d')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','payment_pending','paid','preparing','ready','failed')),
  form_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  analysis_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  amount_cents INTEGER,
  currency TEXT DEFAULT 'aud',
  payment_status TEXT DEFAULT 'unpaid',
  pdf_bytes BYTEA,
  pdf_mime TEXT,
  pdf_filename TEXT,
  pdf_sha256 TEXT,
  pdf_generated_at TIMESTAMPTZ,
  generation_attempts INTEGER NOT NULL DEFAULT 0,
  generation_error TEXT,
  generation_locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessments_client_email ON assessments (lower(client_email));
CREATE INDEX IF NOT EXISTS idx_assessments_applicant_email ON assessments (lower(applicant_email));
CREATE INDEX IF NOT EXISTS idx_assessments_status ON assessments (status);
CREATE INDEX IF NOT EXISTS idx_assessments_stripe_session ON assessments (stripe_session_id);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_email TEXT NOT NULL,
  service_type TEXT NOT NULL,
  service_ref TEXT,
  visa_type TEXT,
  plan TEXT,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent TEXT,
  amount_cents INTEGER,
  currency TEXT DEFAULT 'aud',
  status TEXT NOT NULL DEFAULT 'paid',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pdf_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdf_jobs_queue ON pdf_jobs (status, run_after, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_jobs_one_active_per_assessment
ON pdf_jobs (assessment_id)
WHERE status IN ('queued','processing');
