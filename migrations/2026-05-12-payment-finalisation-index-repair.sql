-- Bircan Migration payment finalisation schema repair
-- Purpose:
--   Remove the over-strict paid-assessment uniqueness rule that blocks repeat
--   paid purchases for the same client/subclass/plan and causes finalisation to
--   fail with:
--   duplicate key value violates unique constraint "idx_one_active_paid_visa_per_account_subclass_plan"
--
-- Correct idempotency is enforced by Stripe checkout session/payment IDs.

BEGIN;

DROP INDEX IF EXISTS idx_one_active_paid_visa_per_account_subclass_plan;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assessments_stripe_session_id_unique
ON assessments (stripe_session_id)
WHERE stripe_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_sessions_stripe_session_id_unique
ON service_sessions (stripe_session_id)
WHERE stripe_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique
ON payments (stripe_session_id)
WHERE stripe_session_id IS NOT NULL;

COMMIT;
