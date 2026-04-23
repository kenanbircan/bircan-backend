PATCH SUMMARY

This package is patched from your uploaded backup files only.

Files included:
- server.js
- package.json

What changed in server.js:
- Only the Stripe Checkout success URL construction inside POST /create-checkout-session was changed.
- {CHECKOUT_SESSION_ID} is no longer passed through URLSearchParams, so Stripe can replace it with a real session ID such as cs_test_... after payment.

What was NOT changed:
- Visa assessment logic
- OpenAI analysis logic
- PDF generation
- SMTP/email logic
- Admin routes
- Knowledgebase loading
- Storage/submission functions
- Existing Stripe mode toggle and verification routes

Required Render env example for test mode:
STRIPE_MODE=test
STRIPE_SECRET_KEY_TEST=sk_test_...
STRIPE_PRICE_CITIZENSHIP_20_TEST=price_...
STRIPE_PRICE_CITIZENSHIP_50_TEST=price_...
STRIPE_PRICE_CITIZENSHIP_100_TEST=price_...
FRONTEND_URL=https://bircanmigration.au
STRIPE_SUCCESS_PATH=/citizenship-payment-success.html
STRIPE_CANCEL_PATH=/citizenship-payment-cancel.html

After upload to GitHub, redeploy Render with Clear build cache & deploy.
