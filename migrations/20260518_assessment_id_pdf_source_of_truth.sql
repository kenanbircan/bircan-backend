-- 2026-05-18
-- Permanent PDF identity repair.
-- Repeat paid visa assessments must be allowed even where the same client submits
-- the same subclass/plan/answers again. Stripe session ids remain unique.
BEGIN;

-- Remove known unsafe fingerprint/idempotency indexes if they exist.
-- These names cover prior Bircan backend variants; missing indexes are ignored.
DROP INDEX IF EXISTS idx_assessments_client_visa_plan_fingerprint_unique;
DROP INDEX IF EXISTS idx_assessments_submission_fingerprint_unique;
DROP INDEX IF EXISTS idx_assessments_client_email_visa_type_selected_plan_submission_fingerprint;
DROP INDEX IF EXISTS idx_assessments_client_visa_plan_submission_fingerprint;
DROP INDEX IF EXISTS assessments_client_email_visa_type_selected_plan_submission_fingerprint_key;

-- Keep/restore the safe uniqueness rule: one Stripe checkout session can attach
-- to one assessment only, but identical future assessments must get fresh ids.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assessments_stripe_session_id_unique
ON assessments (stripe_session_id)
WHERE stripe_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique
ON payments (stripe_session_id)
WHERE stripe_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_sessions_stripe_session_id_unique
ON service_sessions (stripe_session_id)
WHERE stripe_session_id IS NOT NULL;

COMMIT;
