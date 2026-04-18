# Bircan Migration PDF Engine

Commercial-grade PDF engine for preliminary migration assessment letters.

## What this fixes

- Replaces generic report styling with a formal migration-law letter layout
- Adds a stable branded header/footer on every page
- Prevents footer-only trailing pages by stamping header/footer after content generation with buffered pages
- Produces cleaner legal sections, better hierarchy, and a stronger signature block
- Supports logo injection without making the logo mandatory

## Files

- `src/generateAssessmentPdf.js` — main PDF generator
- `src/brandConfig.js` — firm branding and colours
- `examples/create-sample.js` — test script that generates a sample PDF

## Install

```bash
npm install
```

## Usage

```js
const { generateAssessmentPdf } = require('./src/generateAssessmentPdf');

await generateAssessmentPdf({
  outputPath: './output/preliminary-assessment.pdf',
  logoPath: './assets/logo.png', // optional
  assessment: {
    date: '2026-04-18',
    preliminaryOutcome: 'Potentially eligible',
    matter: 'Subclass 482 preliminary assessment',
    submissionId: 'sub_123',
    fullName: 'John Smith',
    email: 'client@example.com',
    dob: '1990-05-14',
    citizenship: 'United Kingdom',
    location: 'Outside Australia',
    stream: 'Subclass 482 | Core Skills stream',
    occupation: 'Software Engineer',
    employerName: 'Tech Solutions Pty Ltd',
    nominationStatus: 'Lodged and pending',
    highestQualification: 'Bachelor Degree',
    fieldOfStudy: 'Computer Science',
    qualificationRelevant: 'Yes',
    skillsAssessment: 'Completed successfully',
    skillsAssessmentRef: 'ACS123456',
    workYears: '5 years',
    englishScore: 'IELTS 7.0 overall with at least 6.0 in each band',
    hasSponsor: 'Yes',
    includePartner: 'Yes',
    healthInsurance: 'Will arrange before grant'
  }
});
```

## Backend integration point

Use this generator inside your `/api/assessment/submit` pipeline after AI analysis has returned structured data.

Example:

```js
const { generateAssessmentPdf } = require('./src/generateAssessmentPdf');

const pdfBuffer = await generateAssessmentPdf({
  logoPath: path.join(__dirname, 'assets', 'logo.png'),
  assessment: analysisResult,
  outputPath: path.join(__dirname, 'storage', `${submissionId}.pdf`)
});
```

Then attach `pdfBuffer` or the saved output path to your email logic.

## Recommended response shape from analysis layer

The generator works best if your analysis output includes:

- `preliminaryOutcome`
- `matter`
- `fullName`
- `email`
- `dob`
- `citizenship`
- `location`
- `stream`
- `occupation`
- `employerName`
- `nominationStatus`
- `highestQualification`
- `fieldOfStudy`
- `qualificationRelevant`
- `skillsAssessment`
- `skillsAssessmentRef`
- `workYears`
- `englishStatus` / `englishScore`
- `hasSponsor`
- `includePartner`
- `passportReady`
- `cvReady`
- `employmentRefs`
- `qualificationDocs`
- `healthInsurance`
- `extraNotes`

## Important implementation note

This engine avoids the common duplication problem by:

- using `bufferPages: true` and stamping chrome only after content is complete
- removing flowing footer/header text from the live pagination path
- keeping content flow and page decoration fully separated
- using fixed-position contact blocks to avoid broken line wrapping in the header

## Branding

All firm details are preloaded from the Bircan Migration & Education profile.
Edit `src/brandConfig.js` if you want to adjust colours, credentials, or contact information.
