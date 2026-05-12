-- Preview: recent same client/email + subclass + plan records where one paid matter should win.
WITH ranked AS (
  SELECT
    id,
    client_email,
    applicant_email,
    visa_type,
    COALESCE(active_plan, selected_plan, 'instant') AS plan,
    payment_status,
    stripe_session_id,
    created_at,
    updated_at,
    first_value(id) OVER (
      PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, COALESCE(active_plan, selected_plan, 'instant')
      ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 ELSE 1 END DESC,
               updated_at DESC NULLS LAST,
               created_at DESC NULLS LAST
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, COALESCE(active_plan, selected_plan, 'instant')
      ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 ELSE 1 END DESC,
               updated_at DESC NULLS LAST,
               created_at DESC NULLS LAST
    ) AS rn
  FROM assessments
  WHERE created_at > now() - interval '72 hours'
    AND visa_type ~ '^[0-9]{3}$'
)
SELECT * FROM ranked WHERE rn > 1 ORDER BY visa_type, plan, created_at DESC;

-- Safe cleanup: mark duplicate service sessions superseded, do not delete assessment audit records.
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, COALESCE(active_plan, selected_plan, 'instant')
      ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 ELSE 1 END DESC,
               updated_at DESC NULLS LAST,
               created_at DESC NULLS LAST
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, COALESCE(active_plan, selected_plan, 'instant')
      ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 ELSE 1 END DESC,
               updated_at DESC NULLS LAST,
               created_at DESC NULLS LAST
    ) AS rn
  FROM assessments
  WHERE created_at > now() - interval '72 hours'
    AND visa_type ~ '^[0-9]{3}$'
)
UPDATE service_sessions s
SET status='superseded_duplicate_checkout',
    payment_status='superseded',
    metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
      'superseded_reason','Recent same client/subclass/plan duplicate; paid matter retained',
      'superseded_by_assessment_id', r.keep_id,
      'superseded_at', now()
    ),
    updated_at=now()
FROM ranked r
WHERE r.rn > 1
  AND s.service_type='visa_assessment'
  AND s.service_ref=r.id;
