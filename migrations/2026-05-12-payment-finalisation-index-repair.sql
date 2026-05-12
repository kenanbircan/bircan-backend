-- Bircan Migration payment finalisation index repair
-- Run once, safe to repeat.
-- Removes an over-strict unique index that blocked repeat paid visa assessments
-- for the same client/subclass/plan, and keeps idempotency on Stripe session IDs.

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
