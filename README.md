BIRCAN PAYMENT FINALISE NO-FAIL PAYMENTS PATCH

This patch fixes the live PostgreSQL error:
  null value in column "id" of relation "payments" violates not-null constraint

What changed:
- Payment finalisation no longer fails if the legacy payments table has an old id column with no default.
- The assessment is marked paid/preparing/ready first.
- The payments audit insert is now safe and non-blocking.
- The server attempts to harden payments.id defaults where possible.
- Finalisation still returns dashboard redirect data.

Upload/replace all backend files:
- server.js
- db.js
- pdf.js
- package.json

Required Render env:
- BOOTSTRAP_DB=true
- DATABASE_URL
- SESSION_SECRET
- STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_TEST
- APP_BASE_URL=https://bircanmigration.au

After redeploy, test:
- /api/health should show version 10.0.2-payment-audit-safe-id-hardened
