# Bircan Migration citizenship test package

## What is included
- `citizenship-test.html` — redesigned page fully wired to the backend endpoints.
- `server.js` — Express + Stripe backend with entitlement tracking.
- `citizenship-success.html` — verifies Stripe session and activates the plan.
- `citizenship-cancel.html` — return page if payment is cancelled.
- `.env.example` — required Stripe test configuration.
- `package.json` — Node dependencies.

## How the page works
- Free exam works directly in the browser and is limited to 3 attempts.
- Paid plan buttons call the backend `POST /api/create-checkout-session`.
- Successful Stripe return goes to `citizenship-success.html`, which calls `GET /api/stripe/verify-session`.
- Paid exam state is loaded from `GET /api/citizenship-plan`.
- Starting a paid exam deducts attempts through `POST /api/citizenship/start-exam`.
- Double-click **Reset exam** clears the current browser entitlement by calling `POST /api/reset-plan`.

## Testing
1. Run `npm install`
2. Copy `.env.example` to `.env`
3. Fill in Stripe test keys and price ids
4. Run `npm start`
5. Open `http://localhost:4242/citizenship-test.html`

## Stripe webhook for local testing
Use:
`stripe listen --forward-to localhost:4242/api/stripe/webhook`

## Front-end testing without payment
- Right-click any paid plan button to activate preview mode for that plan without Stripe checkout.


## Render deployment notes
- Set `BASE_URL` to your Render backend URL, for example `https://bircan-migration-backend.onrender.com`.
- Set `CORS_ALLOWED_ORIGINS` to the frontend domains that will load the citizenship page.
- After deploy, test `https://bircan-migration-backend.onrender.com/api/health` and confirm `stripeConfigured`, `baseUrl`, and `allowedOrigins` are correct.
