-- Bircan Migration: HARD STOP duplicate paid visa matters
-- Purpose:
-- 1) Keep only ONE active paid visa assessment per client/account + subclass + plan.
-- 2) Mark older matching paid records as superseded_duplicate.
-- 3) Prevent the same duplicate pattern from being treated as active again.
--
-- Run once in Render Postgres.
-- This does not delete records; it preserves audit trail.

BEGIN;

-- 1. Mark older duplicate paid visa assessments as superseded.
-- Keeps the most recently updated/created paid matter for each account/email + subclass + plan.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        lower(COALESCE(client_email, applicant_email, '')),
        lower(COALESCE(visa_type, '')),
        lower(COALESCE(selected_plan, active_plan, 'instant'))
      ORDER BY
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST,
        id DESC
    ) AS rn
  FROM assessments
  WHERE payment_status = 'paid'
    AND lower(COALESCE(status, '')) NOT IN ('superseded_duplicate', 'archived_test_duplicate', 'superseded_generic_shell')
    AND COALESCE(client_email, applicant_email, '') <> ''
    AND COALESCE(visa_type, '') <> ''
    AND lower(COALESCE(visa_type, '')) <> 'visa'
)
UPDATE assessments a
SET
  status = 'superseded_duplicate',
  generation_error = COALESCE(a.generation_error, 'Superseded duplicate paid matter: same account/email, subclass and plan. Preserved for audit; not active on dashboard.'),
  updated_at = now()
FROM ranked r
WHERE a.id = r.id
  AND r.rn > 1;

-- 2. Mark matching service sessions as superseded too.
UPDATE service_sessions s
SET
  status = 'superseded_duplicate',
  payment_status = 'superseded',
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'superseded_reason', 'Duplicate paid visa matter for same account/email, subclass and plan',
    'superseded_at', now()
  ),
  updated_at = now()
FROM assessments a
WHERE a.id = s.service_ref
  AND s.service_type = 'visa_assessment'
  AND a.status = 'superseded_duplicate';

-- 3. Add a partial unique index so two ACTIVE paid matters of the same account/subclass/plan cannot coexist.
-- This is the hard database stop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_paid_visa_per_account_subclass_plan
ON assessments (
  lower(COALESCE(client_email, applicant_email, '')),
  lower(COALESCE(visa_type, '')),
  lower(COALESCE(selected_plan, active_plan, 'instant'))
)
WHERE payment_status = 'paid'
  AND lower(COALESCE(status, '')) NOT IN ('superseded_duplicate', 'archived_test_duplicate', 'superseded_generic_shell')
  AND COALESCE(client_email, applicant_email, '') <> ''
  AND COALESCE(visa_type, '') <> ''
  AND lower(COALESCE(visa_type, '')) <> 'visa';

COMMIT;

-- Verify remaining active paid visa matters.
SELECT
  lower(COALESCE(client_email, applicant_email, '')) AS email,
  visa_type,
  COALESCE(selected_plan, active_plan, 'instant') AS plan,
  count(*) AS active_paid_count
FROM assessments
WHERE payment_status = 'paid'
  AND lower(COALESCE(status, '')) NOT IN ('superseded_duplicate', 'archived_test_duplicate', 'superseded_generic_shell')
  AND lower(COALESCE(visa_type, '')) <> 'visa'
GROUP BY 1,2,3
HAVING count(*) > 1;
