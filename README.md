# Bircan Migration AI Backend

This backend accepts visa assessment answers, runs an OpenAI analysis, generates a PDF advice letter, and emails the PDF to the client.

## Main flow

`POST /api/assessment/submit`

This route:
- saves the submission
- immediately starts AI analysis
- generates a PDF advice letter
- emails the PDF
- exposes status polling and PDF download routes

## Required Render environment variables

- `OPENAI_API_KEY`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Optional environment variables

- `OPENAI_MODEL` (default: `gpt-4.1-mini`)
- `OPENAI_BASE_URL`
- `FRONTEND_URL`
- `PORT`

## Health check

`GET /api/health`

Expected response shape includes:
- `hasOpenAiKey`
- `hasSmtp`
- `model`

## Submit route

`POST /api/assessment/submit`

Example body:

```json
{
  "subclass": "Subclass 482",
  "plan": "24 hours",
  "client": {
    "fullName": "John Smith",
    "email": "kenanbircan@gmail.com",
    "phone": "+61412345678",
    "dob": "1990-05-14",
    "nationality": "United Kingdom"
  },
  "answers": [
    { "question": "Occupation", "answer": "Software Engineer" },
    { "question": "Has sponsor", "answer": "Yes" }
  ]
}
```

## Status route

`GET /api/assessment/:submissionId/status`

## PDF download route

`GET /api/assessment/:submissionId/pdf`

## SMTP test route

`GET /api/debug/test-email?to=kenanbircan@gmail.com`
