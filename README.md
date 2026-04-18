# Bircan Migration AI Backend v2

This version adds:
- stronger migration-grade AI prompting
- more polished PDF styling
- admin dashboard for submissions
- resend email action
- download PDF again action
- clearer status handling when email fails after PDF generation

## Main routes

- `POST /api/assessment/submit`
- `GET /api/assessment/:submissionId/status`
- `GET /api/assessment/:submissionId/pdf`
- `GET /api/debug/test-email?to=kenanbircan@gmail.com`

## Admin routes

- `GET /admin/admin.html`
- `GET /api/admin/submissions`
- `POST /api/admin/submissions/:submissionId/resend-email`

If you want to protect admin access, set:

- `ADMIN_TOKEN`

Then use:
- query param `?token=...`
- or request header `x-admin-token`

## Required environment variables

- `OPENAI_API_KEY`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Optional environment variables

- `OPENAI_MODEL`
- `OPENAI_BASE_URL`
- `FRONTEND_URL`
- `ADMIN_TOKEN`
- `PORT`

## Admin UI

After deploy, open:

`https://your-backend-domain/admin/admin.html`

## Patch included in this zip

- adds a stable `node-fetch` import wrapper for the OpenAI request path
- removes unsupported `response_format` from the Chat Completions request
- logs raw AI content when JSON parsing fails
