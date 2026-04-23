# Bircan Migration citizenship test Stripe test-mode package

## What is included
- `citizenship-test.html` — updated exam page wired to backend endpoints.
- `server.js` — Express + Stripe backend.
- `citizenship-success.html` — verifies the returned Checkout Session.
- `citizenship-cancel.html` — cancel return page.
- `data/entitlements.json` — simple local storage file for browser-based test entitlements.

## Setup
1. Install Node.js 18+.
2. In this folder run:
   - `npm install`
3. Copy `.env.example` to `.env`.
4. Fill in your Stripe test keys and Stripe test Price IDs.
5. Start the server:
   - `npm start`
6. Open:
   - `http://localhost:4242/citizenship-test.html`

## Stripe webhook for local testing
Use Stripe CLI so webhook events hit your local server:
- `stripe listen --forward-to localhost:4242/api/stripe/webhook`

Stripe CLI will print a webhook signing secret. Put that into:
- `STRIPE_WEBHOOK_SECRET`

## Test card
Use Stripe test card:
- `4242 4242 4242 4242`
- any future expiry
- any CVC
- any ZIP/postcode

## Important
This package uses a simple browser ID and local JSON store for test-mode entitlement tracking. It is suitable for testing and demonstration, not for a production multi-user authenticated deployment.
