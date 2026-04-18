
# Bircan Migration AI Backend

This backend accepts the assessment answers, runs an OpenAI analysis, creates a branded PDF advice letter, and emails it to the client.

## Required Render environment variables

- `OPENAI_API_KEY`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Optional:
- `OPENAI_MODEL` (default: `gpt-4.1`)
- `FRONTEND_URL`
- `PORT`

## Main route

`POST /api/assessment/submit`

Example request body:

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

## Check status

`GET /api/assessment/:submissionId/status`

## Download PDF

`GET /api/assessment/:submissionId/pdf`

## Test email

`GET /api/debug/test-email?to=kenanbircan@gmail.com`
