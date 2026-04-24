PRODUCTION-GRADE CITIZENSHIP TEST PACKAGE

Built from the uploaded frontend, backend, package.json and DOCX question bank.

Files included:
- citizenship-test-stripe-wired.html
- server.js
- package.json
- citizenship-question-bank.json

Frontend upload:
Upload citizenship-test-stripe-wired.html to your frontend root, for example public_html/.

Backend deploy:
Upload/commit server.js, package.json and citizenship-question-bank.json to the Render backend repo root.
Then redeploy using Clear build cache & deploy.

Required Render environment values:
STRIPE_MODE=test or live
FRONTEND_URL=https://bircanmigration.au
STRIPE_SUCCESS_PATH=/citizenship-test-stripe-wired.html
STRIPE_CANCEL_PATH=/citizenship-test-stripe-wired.html
STRIPE_SECRET_KEY_TEST=sk_test_...
STRIPE_WEBHOOK_SECRET_TEST=whsec_...
STRIPE_PRICE_CITIZENSHIP_20_TEST=price_...
STRIPE_PRICE_CITIZENSHIP_50_TEST=price_...
STRIPE_PRICE_CITIZENSHIP_100_TEST=price_...

For live mode, use STRIPE_MODE=live plus *_LIVE variables.

Production-grade changes:
- Uses parsed 500-question bank from uploaded DOCX.
- Questions are served by backend.
- Correct answers are not sent to frontend until submitted.
- Paid entitlements are stored server-side after Stripe verification/webhook.
- Paid attempts are deducted server-side only after exam submission.
- Free attempts are backend-tracked by browser token.
- Result screen shows score, pass/fail, values score, failure reasons, category breakdown, and correct/incorrect answers.
