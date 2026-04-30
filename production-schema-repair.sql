-- Bircan Migration production schema repair — run once in Render PostgreSQL / psql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assessments (
  id text PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  client_email text NOT NULL,
  applicant_email text,
  applicant_name text,
  visa_type text NOT NULL,
  selected_plan text NOT NULL DEFAULT 'instant',
  active_plan text,
  status text NOT NULL DEFAULT 'payment_pending',
  payment_status text NOT NULL DEFAULT 'unpaid',
  stripe_session_id text,
  stripe_payment_intent text,
  amount_cents integer,
  currency text DEFAULT 'aud',
  form_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_bytes bytea,
  pdf_mime text,
  pdf_filename text,
  pdf_sha256 text,
  pdf_generated_at timestamptz,
  generation_attempts integer NOT NULL DEFAULT 0,
  generation_locked_at timestamptz,
  generation_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id bigserial PRIMARY KEY,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  client_email text NOT NULL,
  service_type text NOT NULL DEFAULT 'visa_assessment',
  service_ref text NOT NULL,
  visa_type text,
  plan text,
  stripe_session_id text UNIQUE,
  stripe_payment_intent text,
  amount_cents integer,
  currency text DEFAULT 'aud',
  status text NOT NULL DEFAULT 'paid',
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pdf_jobs (
  id bigserial PRIMARY KEY,
  assessment_id text UNIQUE NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE assessments ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS applicant_email text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS applicant_name text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS visa_type text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS selected_plan text DEFAULT 'instant';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS active_plan text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS status text DEFAULT 'payment_pending';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS stripe_session_id text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS stripe_payment_intent text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS amount_cents integer;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS form_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_bytes bytea;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_mime text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_filename text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_sha256 text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_generated_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generation_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generation_locked_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generation_error text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_type text DEFAULT 'visa_assessment';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_ref text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS visa_type text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_session_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status text DEFAULT 'paid';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw_payload jsonb;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique ON payments (stripe_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_jobs_assessment_id_unique ON pdf_jobs (assessment_id);
CREATE INDEX IF NOT EXISTS idx_assessments_client_email ON assessments (lower(client_email));
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_status_run_after ON pdf_jobs (status, run_after);
