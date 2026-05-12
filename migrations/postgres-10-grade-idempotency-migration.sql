-- Bircan Migration - 10-grade Postgres idempotency migration
-- Purpose: stop duplicate visa assessments at the database layer.
-- Run this once against the Render Postgres database before/with the patched server.js deploy.

BEGIN;

ALTER TABLE assessments ADD COLUMN IF NOT EXISTS submission_fingerprint text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS applicant_email text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS visa_type text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS selected_plan text DEFAULT 'instant';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS active_plan text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS stripe_session_id text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS stripe_payment_intent text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS amount_cents integer;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS release_at timestamptz;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS service_type text;
ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS service_ref text;
ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS selected_plan text;
ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid';
ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS stripe_session_id text;
ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_type text DEFAULT 'visa_assessment';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_ref text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_session_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Merge historical duplicate assessment records into the strongest canonical row.
WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
           ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                    updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS keep_id,
         row_number() OVER (
           PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
           ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                    updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM assessments
  WHERE submission_fingerprint IS NOT NULL
    AND COALESCE(client_email, applicant_email, '') <> ''
    AND visa_type IS NOT NULL
    AND selected_plan IS NOT NULL
)
UPDATE assessments keep
   SET payment_status = CASE WHEN dup.payment_status='paid' THEN 'paid' ELSE keep.payment_status END,
       status = CASE WHEN dup.payment_status='paid' AND keep.status NOT IN ('pdf_ready','release_scheduled','pdf_queued') THEN COALESCE(dup.status, keep.status) ELSE keep.status END,
       stripe_session_id = COALESCE(keep.stripe_session_id, dup.stripe_session_id),
       stripe_payment_intent = COALESCE(keep.stripe_payment_intent, dup.stripe_payment_intent),
       amount_cents = COALESCE(keep.amount_cents, dup.amount_cents),
       currency = COALESCE(keep.currency, dup.currency),
       active_plan = COALESCE(keep.active_plan, dup.active_plan),
       release_at = COALESCE(keep.release_at, dup.release_at),
       pdf_bytes = COALESCE(keep.pdf_bytes, dup.pdf_bytes),
       pdf_mime = COALESCE(keep.pdf_mime, dup.pdf_mime),
       pdf_filename = COALESCE(keep.pdf_filename, dup.pdf_filename),
       pdf_sha256 = COALESCE(keep.pdf_sha256, dup.pdf_sha256),
       pdf_generated_at = COALESCE(keep.pdf_generated_at, dup.pdf_generated_at),
       generation_error = CASE WHEN keep.pdf_bytes IS NOT NULL OR dup.pdf_bytes IS NOT NULL THEN NULL ELSE COALESCE(keep.generation_error, dup.generation_error) END,
       updated_at = now()
FROM ranked r
JOIN assessments dup ON dup.id=r.id
WHERE r.rn > 1 AND keep.id=r.keep_id;

WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
           ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                    updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS keep_id,
         row_number() OVER (
           PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
           ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                    updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM assessments
  WHERE submission_fingerprint IS NOT NULL
    AND COALESCE(client_email, applicant_email, '') <> ''
    AND visa_type IS NOT NULL
    AND selected_plan IS NOT NULL
)
UPDATE service_sessions ss SET service_ref=r.keep_id, updated_at=now()
FROM ranked r
WHERE r.rn > 1 AND ss.service_type='visa_assessment' AND ss.service_ref=r.id;

WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
           ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                    updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS keep_id,
         row_number() OVER (
           PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
           ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                    updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM assessments
  WHERE submission_fingerprint IS NOT NULL
    AND COALESCE(client_email, applicant_email, '') <> ''
    AND visa_type IS NOT NULL
    AND selected_plan IS NOT NULL
)
UPDATE payments p SET service_ref=r.keep_id, updated_at=now()
FROM ranked r
WHERE r.rn > 1 AND p.service_type='visa_assessment' AND p.service_ref=r.id;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY stripe_session_id
    ORDER BY CASE WHEN status='paid' THEN 2 ELSE 1 END DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id::text DESC
  ) rn
  FROM payments
  WHERE stripe_session_id IS NOT NULL AND stripe_session_id <> ''
)
DELETE FROM payments p USING ranked r WHERE p.id=r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY service_type, service_ref
    ORDER BY CASE WHEN payment_status='paid' THEN 3 WHEN stripe_session_id IS NOT NULL THEN 2 ELSE 1 END DESC,
             updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) rn
  FROM service_sessions
  WHERE service_ref IS NOT NULL AND service_ref <> ''
)
DELETE FROM service_sessions s USING ranked r WHERE s.id=r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
    ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
             updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS rn
  FROM assessments
  WHERE submission_fingerprint IS NOT NULL
    AND COALESCE(client_email, applicant_email, '') <> ''
    AND visa_type IS NOT NULL
    AND selected_plan IS NOT NULL
)
DELETE FROM assessments a USING ranked r WHERE a.id=r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assessments_idempotency_unique
ON assessments (lower(client_email), visa_type, selected_plan, submission_fingerprint)
WHERE submission_fingerprint IS NOT NULL AND client_email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_sessions_unique_service_ref
ON service_sessions (service_type, service_ref)
WHERE service_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique
ON payments (stripe_session_id)
WHERE stripe_session_id IS NOT NULL;

COMMIT;

-- Verification queries: all three should return zero rows.
SELECT lower(client_email) AS client_email, visa_type, selected_plan, submission_fingerprint, count(*)
FROM assessments
WHERE submission_fingerprint IS NOT NULL AND client_email IS NOT NULL
GROUP BY lower(client_email), visa_type, selected_plan, submission_fingerprint
HAVING count(*) > 1;

SELECT service_type, service_ref, count(*)
FROM service_sessions
WHERE service_ref IS NOT NULL
GROUP BY service_type, service_ref
HAVING count(*) > 1;

SELECT stripe_session_id, count(*)
FROM payments
WHERE stripe_session_id IS NOT NULL
GROUP BY stripe_session_id
HAVING count(*) > 1;
