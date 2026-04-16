# Bircan Migration Backend

Production-ready Node.js backend for a commercial migration workflow:

- Stripe Checkout session creation
- Verified Stripe webhook handling
- Submission persistence to JSON storage
- Professional PDF generation
- Client receipt email
- Admin notification email
- Success page polling endpoint
- Render deployment config

## Main Flow

1. Frontend sends form data to `POST /api/payments/create-checkout-session`
2. Backend creates a pending submission and Stripe Checkout Session
3. Customer pays in Stripe Checkout
4. Stripe sends `checkout.session.completed` webhook
5. Backend marks the submission as paid, generates the PDF, sends emails, and stores delivery metadata
6. Frontend success page calls `GET /api/payments/session-status?session_id=...`
7. Frontend can download the PDF from `GET /api/submissions/:submissionId/pdf`

## Required Environment Variables

Copy `.env.example` to `.env` and fill in the values.

Critical:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SMTP_HOST`
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
- `ADMIN_NOTIFY_EMAIL`
- `APP_BASE_URL`

## Local Run

```bash
npm install
npm run dev
```

## Stripe Webhook (local)

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Then place the generated webhook secret into `.env` as `STRIPE_WEBHOOK_SECRET`.

## Recommended Frontend Success Flow

After Stripe redirects to your success page:

1. Read `session_id` and `submission_id` from the URL
2. Call:
   `GET /api/payments/session-status?session_id=...`
3. If the response says `status=completed` and `pdfReady=true`, show a download button using `downloadUrl`

## Render Notes

The JSON storage in this package works immediately, but local disk on free tiers can be ephemeral.  
For long-term persistence, mount a persistent disk or replace `storage.js` with PostgreSQL / MongoDB later.

## Key API Endpoints

- `GET /`
- `GET /api/health`
- `POST /api/payments/create-checkout-session`
- `POST /api/stripe/webhook`
- `GET /api/payments/session-status`
- `GET /api/submissions/:submissionId`
- `GET /api/submissions/:submissionId/pdf`
