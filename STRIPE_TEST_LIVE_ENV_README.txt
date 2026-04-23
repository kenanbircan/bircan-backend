Patched Stripe test/live toggle for Bircan backend

This package patches your CURRENT server.js only. Other assessment/PDF/OpenAI/SMTP/admin/knowledgebase functions are left in place.

IMPORTANT: The old hardcoded live Stripe price fallbacks were removed. This prevents the backend from using live price IDs while STRIPE_MODE=test.

Render test-mode setup:
STRIPE_MODE=test
STRIPE_SECRET_KEY_TEST=sk_test_...
STRIPE_WEBHOOK_SECRET_TEST=whsec_...   (optional unless testing webhooks)
STRIPE_PRICE_CITIZENSHIP_20_TEST=price_1TPVVBJ1zGpc7hJ0dEfFHxXH
STRIPE_PRICE_CITIZENSHIP_50_TEST=price_1TPVWHJ1zGpc7hJ04XNPOLk7
STRIPE_PRICE_CITIZENSHIP_100_TEST=price_1TPVXUJ1zGpc7hJ0E1R1VlIG
STRIPE_PRICE_CITIZENSHIP_UNLIMITED_TEST=price_...   (optional)

Render live-mode setup later:
STRIPE_MODE=live
STRIPE_SECRET_KEY_LIVE=sk_live_...
STRIPE_WEBHOOK_SECRET_LIVE=whsec_...
STRIPE_PRICE_CITIZENSHIP_20_LIVE=price_...
STRIPE_PRICE_CITIZENSHIP_50_LIVE=price_...
STRIPE_PRICE_CITIZENSHIP_100_LIVE=price_...
STRIPE_PRICE_CITIZENSHIP_UNLIMITED_LIVE=price_...

After deploy, check:
https://bircan-migration-backend.onrender.com/api/health

Expected for test mode:
"stripeMode":"test"
"stripeKeyType":"test"
"stripePrices":{"20":true,"50":true,"100":true}

If /api/health does not show stripeMode, Render is still running an older server.js.
