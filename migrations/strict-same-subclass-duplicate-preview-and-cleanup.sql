-- Strict same-subclass duplicate cleanup for Bircan dashboard.
-- Purpose: suppress older duplicate visa assessment cards created by repeated checkout/test loops.
-- This does NOT delete records. It marks lower-priority duplicates as superseded.
-- Run the PREVIEW first and only run the UPDATE if the rows are truly duplicate test records.

-- PREVIEW: shows duplicate active visa assessment groups by client/applicant email + subclass + plan.
WITH candidates AS (
  SELECT
    a.*,
    lower(COALESCE(NULLIF(a.client_email,''), NULLIF(a.applicant_email,''))) AS owner_email,
    COALESCE(a.active_plan, a.selected_plan, 'instant') AS effective_plan,
    row_number() OVER (
      PARTITION BY lower(COALESCE(NULLIF(a.client_email,''), NULLIF(a.applicant_email,''))), a.visa_type, COALESCE(a.active_plan, a.selected_plan, 'instant')
      ORDER BY
        CASE WHEN a.payment_status='paid' THEN 5 ELSE 0 END DESC,
        CASE WHEN a.stripe_session_id IS NOT NULL THEN 4 ELSE 0 END DESC,
        CASE WHEN a.pdf_bytes IS NOT NULL THEN 3 ELSE 0 END DESC,
        a.updated_at DESC NULLS LAST,
        a.created_at DESC NULLS LAST,
        a.id DESC
    ) AS keep_rank,
    count(*) OVER (
      PARTITION BY lower(COALESCE(NULLIF(a.client_email,''), NULLIF(a.applicant_email,''))), a.visa_type, COALESCE(a.active_plan, a.selected_plan, 'instant')
    ) AS group_count
  FROM assessments a
  WHERE a.visa_type IS NOT NULL
    AND lower(COALESCE(a.visa_type,'')) <> 'visa'
    AND lower(COALESCE(NULLIF(a.client_email,''), NULLIF(a.applicant_email,''))) <> ''
    AND COALESCE(a.payment_status,'') IN ('paid','unpaid')
    AND COALESCE(a.status,'') NOT LIKE 'superseded%'
    AND a.created_at > now() - interval '24 hours'
)
SELECT owner_email, visa_type, effective_plan, group_count, keep_rank, id, payment_status, status, stripe_session_id, created_at, updated_at
FROM candidates
WHERE group_count > 1
ORDER BY owner_email, visa_type, effective_plan, keep_rank;

-- UPDATE: uncomment and run only after preview confirms the older rows are duplicates.
/*
WITH candidates AS (
  SELECT
    a.id,
    row_number() OVER (
      PARTITION BY lower(COALESCE(NULLIF(a.client_email,''), NULLIF(a.applicant_email,''))), a.visa_type, COALESCE(a.active_plan, a.selected_plan, 'instant')
      ORDER BY
        CASE WHEN a.payment_status='paid' THEN 5 ELSE 0 END DESC,
        CASE WHEN a.stripe_session_id IS NOT NULL THEN 4 ELSE 0 END DESC,
        CASE WHEN a.pdf_bytes IS NOT NULL THEN 3 ELSE 0 END DESC,
        a.updated_at DESC NULLS LAST,
        a.created_at DESC NULLS LAST,
        a.id DESC
    ) AS keep_rank,
    count(*) OVER (
      PARTITION BY lower(COALESCE(NULLIF(a.client_email,''), NULLIF(a.applicant_email,''))), a.visa_type, COALESCE(a.active_plan, a.selected_plan, 'instant')
    ) AS group_count
  FROM assessments a
  WHERE a.visa_type IS NOT NULL
    AND lower(COALESCE(a.visa_type,'')) <> 'visa'
    AND lower(COALESCE(NULLIF(a.client_email,''), NULLIF(a.applicant_email,''))) <> ''
    AND COALESCE(a.payment_status,'') IN ('paid','unpaid')
    AND COALESCE(a.status,'') NOT LIKE 'superseded%'
    AND a.created_at > now() - interval '24 hours'
)
UPDATE assessments a
SET status='superseded_duplicate',
    payment_status='superseded',
    generation_error=COALESCE(a.generation_error,'Superseded duplicate assessment record hidden from dashboard; retained for audit.'),
    updated_at=now()
FROM candidates c
WHERE a.id=c.id
  AND c.group_count > 1
  AND c.keep_rank > 1;
*/
