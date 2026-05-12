-- Bircan Migration: cleanup generic visa shells that share a Stripe session with a real subclass assessment.
-- Run once only if you want to clean historical rows immediately. The patched server also runs this repair during schema bootstrap.

BEGIN;

WITH pairs AS (
  SELECT generic.id AS dup_id, real.id AS keep_id
  FROM assessments generic
  JOIN assessments real
    ON real.stripe_session_id IS NOT NULL
   AND generic.stripe_session_id = real.stripe_session_id
   AND real.id <> generic.id
  WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
    AND real.visa_type ~ '^[0-9]{3}$'
), ranked AS (
  SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) rn FROM pairs
)
UPDATE service_sessions ss
SET service_ref = r.keep_id, updated_at = now()
FROM ranked r
WHERE r.rn=1 AND ss.service_type='visa_assessment' AND ss.service_ref = r.dup_id;

WITH pairs AS (
  SELECT generic.id AS dup_id, real.id AS keep_id
  FROM assessments generic
  JOIN assessments real
    ON real.stripe_session_id IS NOT NULL
   AND generic.stripe_session_id = real.stripe_session_id
   AND real.id <> generic.id
  WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
    AND real.visa_type ~ '^[0-9]{3}$'
), ranked AS (
  SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) rn FROM pairs
)
UPDATE payments p
SET service_ref = r.keep_id, updated_at = now()
FROM ranked r
WHERE r.rn=1 AND p.service_type='visa_assessment' AND p.service_ref = r.dup_id;

WITH pairs AS (
  SELECT generic.id AS dup_id, real.id AS keep_id
  FROM assessments generic
  JOIN assessments real
    ON real.stripe_session_id IS NOT NULL
   AND generic.stripe_session_id = real.stripe_session_id
   AND real.id <> generic.id
  WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
    AND real.visa_type ~ '^[0-9]{3}$'
), ranked AS (
  SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) rn FROM pairs
)
UPDATE assessments keep
SET payment_status = CASE WHEN dup.payment_status='paid' THEN 'paid' ELSE keep.payment_status END,
    status = CASE WHEN dup.payment_status='paid' AND keep.status NOT IN ('pdf_ready','release_scheduled','pdf_queued') THEN COALESCE(dup.status, keep.status) ELSE keep.status END,
    amount_cents = COALESCE(keep.amount_cents, dup.amount_cents),
    currency = COALESCE(keep.currency, dup.currency),
    release_at = COALESCE(keep.release_at, dup.release_at),
    pdf_bytes = COALESCE(keep.pdf_bytes, dup.pdf_bytes),
    pdf_mime = COALESCE(keep.pdf_mime, dup.pdf_mime),
    pdf_filename = COALESCE(keep.pdf_filename, dup.pdf_filename),
    pdf_sha256 = COALESCE(keep.pdf_sha256, dup.pdf_sha256),
    pdf_generated_at = COALESCE(keep.pdf_generated_at, dup.pdf_generated_at),
    updated_at = now()
FROM ranked r
JOIN assessments dup ON dup.id=r.dup_id
WHERE r.rn=1 AND keep.id=r.keep_id;

WITH pairs AS (
  SELECT generic.id AS dup_id, real.id AS keep_id
  FROM assessments generic
  JOIN assessments real
    ON real.stripe_session_id IS NOT NULL
   AND generic.stripe_session_id = real.stripe_session_id
   AND real.id <> generic.id
  WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
    AND real.visa_type ~ '^[0-9]{3}$'
), ranked AS (
  SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) rn FROM pairs
)
DELETE FROM assessments a USING ranked r WHERE r.rn=1 AND a.id=r.dup_id;

COMMIT;
