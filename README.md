BIRCAN FINAL SERVER - DEPLOYMENT NOTES

Upload these files to your backend repository root:
- server.js
- db.js
- pdf.js
- package.json

Required Render environment variables:
- DATABASE_URL
- SESSION_SECRET
- APP_BASE_URL=https://bircanmigration.au
- STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_TEST
- STRIPE_WEBHOOK_SECRET recommended
- STRIPE_PRICE_VISA_INSTANT_TEST or STRIPE_PRICE_VISA_INSTANT
- STRIPE_PRICE_VISA_24H_TEST or STRIPE_PRICE_VISA_24H
- STRIPE_PRICE_VISA_3D_TEST or STRIPE_PRICE_VISA_3D

Optional email variables:
- SMTP_HOST
- SMTP_PORT
- SMTP_SECURE
- SMTP_USER
- SMTP_PASS
- SMTP_FROM

Important behaviour:
- Payment verification now attaches payment and immediately generates the PDF by default.
- Stripe webhook also queues and triggers generation.
- Opening /api/assessment/:id/pdf will auto-generate the PDF if payment is already paid but the PDF is missing.
- Dashboard status returns 'ready' whenever pdf_bytes exists.
- GET /api/assessment/generate-pdf is intentionally blocked. Use POST with { assessmentId }.

Render start command:
npm start

Health check:
/api/health


PATCH ADDED - PAYMENT FINALISATION ROUTE
This patched server also exposes:
- POST /api/payments/finalise
- POST /api/payment/finalise
- POST /api/payments/finalize
- GET  /api/payments/finalise

Purpose:
- fixes payment-complete.html error: Route not found: POST /api/payments/finalise
- retrieves the Stripe Checkout session
- attaches the paid session to the assessment
- triggers PDF generation
- restores bm_session cookie from the paid Stripe session email where the client account exists
- returns redirectUrl to account-dashboard.html

Expected frontend payload:
{ "session_id": "cs_test_..." }
or
{ "sessionId": "cs_test_..." }

PATCH 10.0.1 - PAYMENT FINALISE DB MIGRATION SAFE
- Adds POST /api/payments/finalise aliases for payment-complete pages.
- Adds in-place ALTER TABLE migration for older PostgreSQL tables.
- Fixes: column "client_id" of relation "payments" does not exist.
- Also hardens older assessments/pdf_jobs schemas so missing PDF/status columns do not crash the server.

After deploy, open /api/health once. If BOOTSTRAP_DB=true, the server applies the migration automatically at startup.
