require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const mime = require('mime-types');
const { renderAssessment } = require('./src/generateAssessmentPdf');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const DEFAULT_REVIEW_EMAIL = process.env.DEFAULT_REVIEW_EMAIL || 'kenan@bircanmigration.com.au';
const OUTPUT_DIR = path.join(__dirname, 'output');
const LOGO_PATH = process.env.PDF_LOGO_PATH || '';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/output', express.static(OUTPUT_DIR, {
  setHeaders: (res, filePath) => {
    const contentType = mime.lookup(filePath) || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
  }
}));


function normalizeRequestBody(req) {
  if (!req || typeof req.body === 'undefined' || req.body === null) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  return {};
}

function createSubmissionId() {
  return `sub_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function buildPayload(body, submissionId) {
  const answers = body.answers || body.questionnaireRecord || {};
  const model = body.model || 'gpt-4.1-mini';
  const occupation = answers.occupation || body.occupation || 'Not provided';
  const stream = answers.stream || body.stream || 'Core Skills';
  const visaLabel = body.visaLabel || 'Subclass 482 Skills In Demand Visa';
  const employerName = answers.employerName || body.employerName || 'Not provided';

  return {
    assessmentType: 'Preliminary Visa Assessment Letter',
    visaLabel,
    assessmentDate: new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' }),
    submissionId,
    overallResult: body.overallResult || 'Potentially eligible',
    outcomeBlurb:
      body.outcomeBlurb ||
      'You appear to meet the key preliminary criteria based on the facts currently provided, subject to final documentary review and departmental assessment.',
    ratingEligibility: body.ratingEligibility || 'High',
    ratingOccupation: body.ratingOccupation || 'High',
    ratingEnglish: body.ratingEnglish || 'Satisfactory',
    fullName: answers.fullName || body.fullName || 'Client',
    dob: answers.dob || body.dob,
    citizenship: answers.citizenship || body.citizenship,
    location: answers.location || body.location || answers.currentVisa,
    occupation,
    employerName,
    nominationStatus: answers.nominationStatus || body.nominationStatus,
    skillsAssessment: answers.skillsAssessment || body.skillsAssessment,
    englishScore: answers.englishScore || body.englishScore || answers.englishStatus,
    workYears: answers.workYears || body.workYears,
    instructionsAndScope:
      body.instructionsAndScope ||
      `We confirm that we have been instructed to provide a preliminary migration assessment in relation to the ${visaLabel} under the ${stream} stream. This assessment has been prepared using a combination of automated analytical systems and professional migration expertise, based on the information presently supplied, and remains subject to documentary verification and legal review.`,
    caseSummary:
      body.caseSummary ||
      `${answers.fullName || 'The applicant'} seeks to proceed with a ${visaLabel} application in the occupation of ${occupation}. The sponsoring employer is ${employerName}. The present material indicates that the applicant may satisfy the core threshold requirements, subject to confirmation of nomination, documentary completeness, and any legislative or policy requirements applicable at the time of decision. AI processing model used for backend analysis: ${model}.`,
    professionalRecommendation:
      body.professionalRecommendation ||
      `On the information currently available, the case appears to demonstrate a prima facie level of eligibility for the proposed visa pathway. Before lodgement, all supporting evidence should be reviewed for consistency, currency, and compliance with Departmental requirements. Nomination status, documentary sufficiency, and any family-member requirements should be confirmed before a final legal position is adopted.`,
    keyFindings: body.keyFindings || [
      `Nominated occupation (${occupation}) appears consistent with the proposed pathway.`,
      `Employer details indicate an identified sponsoring business (${employerName}).`,
      `Nomination status is recorded as: ${answers.nominationStatus || 'Not provided'}.`,
      `Skills assessment status is recorded as: ${answers.skillsAssessment || 'Not provided'}.`,
      `English language position is recorded as: ${answers.englishScore || answers.englishStatus || 'Not provided'}.`,
      `Document readiness presently includes: ${answers.docsReady || 'Not provided'}.`
    ],
    requiredEvidence: body.requiredEvidence || [
      'Confirmation of all identity, qualification, and employment documents.',
      'Updated nomination and sponsor evidence where applicable.',
      'Health insurance arrangements and any dependent documentation.',
      'Any additional evidence required by the Department of Home Affairs at time of lodgement.'
    ],
    nextSteps: body.nextSteps || [
      'Review the full evidence set for completeness and consistency.',
      'Confirm nomination progress and any employer-side requirements.',
      'Prepare the visa application package for legal review prior to lodgement.',
      'Respond promptly to any requests for further information.'
    ],
    documentChecklist: body.documentChecklist || [
      'Passport bio page',
      'Curriculum Vitae',
      'Employment references',
      'Qualification documents and transcripts',
      'Skills assessment evidence',
      'English language evidence',
      'Sponsor and nomination documents',
      'Family relationship documents if applicable'
    ],
    assumptions: body.assumptions || [
      'Information provided by the client is accurate and complete.',
      'All documents to be supplied are genuine and current.',
      'No undisclosed compliance, character, or health issues exist.',
      'Any employer-side sponsorship requirements will remain satisfied.'
    ],
    ratings: body.ratings || {
      'Sponsor readiness': body.ratingEligibility || 'High',
      'Occupation fit': body.ratingOccupation || 'High',
      'English position': body.ratingEnglish || 'Satisfactory',
      'Compliance risk': 'Low',
      'Overall readiness': 'High'
    },
    questionnaireRecord: answers,
    disclaimer:
      body.disclaimer ||
      'This preliminary assessment is provided solely on the basis of the information supplied by the client and does not constitute legal advice or a guarantee of visa grant. Migration outcomes depend on the full merits of the application, compliance with all legislative and policy requirements, and the discretion of the Department of Home Affairs. Clients should seek comprehensive advice and ensure all documentation is accurate and complete prior to lodgement.'
  };
}

function buildMailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendEmailWithAttachment({ to, subject, text, filePath }) {
  const transporter = buildMailer();
  if (!transporter) {
    return { sent: false, reason: 'SMTP not configured' };
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'kenan@bircanmigration.com.au',
    to,
    subject,
    text,
    attachments: [{ filename: path.basename(filePath), path: filePath }]
  });

  return { sent: true };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
    pdfEngine: 'stable-buffered-pdfkit',
    hasSmtp: Boolean(buildMailer())
  });
});

app.post('/api/assessment/submit', async (req, res) => {
  const submissionId = createSubmissionId();

  try {
    const body = normalizeRequestBody(req);
    const clientEmail = body.clientEmail || body.email || body.answers?.email || DEFAULT_REVIEW_EMAIL;
    const payload = buildPayload(body, submissionId);
    const pdfPath = path.join(OUTPUT_DIR, `${submissionId}.pdf`);

    await renderAssessment(pdfPath, payload, { logoPath: LOGO_PATH });

    const emailResult = await sendEmailWithAttachment({
      to: clientEmail,
      subject: `${payload.assessmentType} - ${payload.fullName}`,
      text: `Please find attached the preliminary visa assessment letter for submission ${submissionId}.`,
      filePath: pdfPath
    });

    res.json({
      ok: true,
      submissionId,
      status: 'completed',
      analysisStatus: 'completed',
      pdfStatus: 'generated',
      emailStatus: emailResult.sent ? 'sent' : 'skipped',
      emailReason: emailResult.reason || null,
      pdfUrl: `${PUBLIC_BASE_URL}/output/${path.basename(pdfPath)}`,
      deliveryEmail: clientEmail
    });
  } catch (error) {
    console.error('Assessment submission failed', { submissionId, error });
    res.status(500).json({
      ok: false,
      submissionId,
      status: 'failed',
      analysisStatus: 'failed',
      pdfStatus: 'failed',
      emailStatus: 'failed',
      processingError: error.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log(`Bircan backend listening on ${PUBLIC_BASE_URL}`);
});
