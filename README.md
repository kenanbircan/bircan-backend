# Bircan Migration Backend

Production-style Node.js backend for:

- assessment submission
- Stripe checkout session creation
- Stripe webhook confirmation
- OpenAI-powered assessment analysis
- PDF letter generation
- email delivery to the client
- status and admin-friendly retrieval endpoints

## Included files

- `server.js`
- `storage.js`
- `pdf.js`
- `mailer.js`
- `package.json`
- `.env.example`
- `render.yaml`
- `.gitignore`

## Install

```bash
npm install
cp .env.example .env
npm start
```

## Required environment variables

- `OPENAI_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`
- `FRONTEND_URL`
- `APP_BASE_URL`

## Frontend flow

1. Frontend posts full answers to `POST /api/assessment/submit`
2. Backend stores the submission and returns `submissionId`
3. Frontend posts plan + `submissionId` to `POST /api/payments/create-checkout-session`
4. Stripe redirects back to your success page
5. Stripe webhook calls backend and marks payment as successful
6. Backend runs OpenAI analysis
7. Backend generates PDF
8. Backend emails the final assessment letter
9. Frontend can poll `GET /api/assessment/:submissionId/status`

## Important

This package uses JSON file storage for persistence. That is much better than memory-only testing, but for true long-term production you should move to PostgreSQL or another database.
