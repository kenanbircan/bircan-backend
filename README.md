# Bircan Migration Backend Bundle

This package replaces the unstable PDF flow with a single clean generation path.

## What this fixes

- Prevents extra blank trailing pages caused by footer/header content being treated as normal flowing content
- Uses buffered page numbering in `pdfkit` so page labels are stamped after the real content is finished
- Uses a locked two-column header layout so the website, email, and contact details do not break awkwardly
- Provides a production-ready `server.js` with `/api/health` and `/api/assessment/submit`

## Install

```bash
npm install
cp .env.example .env
npm start
```

## Routes

### GET `/api/health`
Returns backend health and whether SMTP is configured.

### POST `/api/assessment/submit`
Accepts assessment data and returns a generated PDF URL.

Example body:

```json
{
  "clientEmail": "kenan@bircanmigration.com.au",
  "answers": {
    "fullName": "John Smith",
    "email": "kenan@bircanmigration.com.au",
    "dob": "1990-05-14",
    "citizenship": "United Kingdom",
    "location": "Outside Australia",
    "occupation": "Software Engineer",
    "employerName": "Tech Solutions Pty Ltd",
    "nominationStatus": "Lodged and pending",
    "skillsAssessment": "Completed successfully",
    "englishScore": "IELTS 7.0 overall with at least 6.0 in each band",
    "workYears": "5 years"
  }
}
```

## Deployment notes for Render

- Use **Web Service**
- Build command: `npm install`
- Start command: `npm start`
- Add env vars from `.env.example`
- Set `PUBLIC_BASE_URL` to your Render backend URL
- Optional: set `PDF_LOGO_PATH` if you want to include your logo from disk

## Important implementation rule

Do not run a second PDF pass in any other file. The PDF must be generated **only once** through `renderAssessment()` from `src/generateAssessmentPdf.js`.

If you append any footer, page-number, or branding content outside this module, the duplicate-pages bug can return.
