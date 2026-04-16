import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import generatePDF from './pdf.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  'https://bircanmigration.au',
  'https://www.bircanmigration.au',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.set('trust proxy', 1);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function buildAssessmentSummary(payload = {}) {
  return {
    visaType: pick(payload.visaType, payload.visaSubclass, 'Migration Assessment'),
    fullName: pick(payload.fullName, payload.name, 'Client'),
    email: pick(payload.email),
    phone: pick(payload.phone, payload.mobile),
    dateOfBirth: pick(payload.dateOfBirth, payload.dob),
    nationality: pick(payload.nationality, payload.citizenship),
    location: pick(payload.location, payload.currentLocation, payload.countryOfResidence),
    relationshipStatus: pick(payload.relationshipStatus, payload.maritalStatus),
    sponsorStatus: pick(payload.sponsorStatus),
    applicantStatus: pick(payload.applicantStatus, payload.currentVisaStatus),
    passportCountry: pick(payload.passportCountry),
    currentVisa: pick(payload.currentVisa),
    sponsorName: pick(payload.sponsorName),
    sponsorCitizenshipStatus: pick(payload.sponsorCitizenshipStatus),
    relationshipStartDate: pick(payload.relationshipStartDate),
    cohabitationStartDate: pick(payload.cohabitationStartDate),
    childrenDetails: pick(payload.childrenDetails),
    refusalHistory: pick(payload.refusalHistory),
    healthIssues: pick(payload.healthIssues),
    characterIssues: pick(payload.characterIssues),
    notes: pick(payload.notes, payload.additionalInformation, payload.additionalInfo),
    submittedAt: new Date().toISOString(),
  };
}

function buildAssessmentResult(summary, payload = {}) {
  const findings = [];
  const strengths = [];
  const risks = [];
  const recommendedNextSteps = [];

  if (summary.visaType.toLowerCase().includes('309')) {
    findings.push('The requested pathway appears to be the offshore Partner visa stream.');
    strengths.push('Subclass 309 is generally suitable where the applicant is outside Australia and the relationship is genuine and continuing.');
    recommendedNextSteps.push('Prepare evidence across the four relationship categories: financial, social, nature of household, and commitment.');
    recommendedNextSteps.push('Prepare a clear relationship timeline supported by documents and statements.');
    recommendedNextSteps.push('Confirm the sponsor’s Australian citizenship, permanent residence, or eligible New Zealand citizen status.');
  }

  if (summary.relationshipStatus) findings.push(`Relationship status recorded: ${summary.relationshipStatus}`);
  if (summary.sponsorStatus) findings.push(`Sponsor status recorded: ${summary.sponsorStatus}`);
  if (summary.applicantStatus) findings.push(`Applicant visa status recorded: ${summary.applicantStatus}`);
  if (summary.currentVisa) findings.push(`Current visa recorded: ${summary.currentVisa}`);
  if (summary.location) findings.push(`Current location recorded: ${summary.location}`);
  if (summary.nationality) findings.push(`Nationality recorded: ${summary.nationality}`);

  if (summary.relationshipStartDate) {
    strengths.push('A relationship commencement date has been provided, which assists with timeline assessment.');
  }

  if (summary.cohabitationStartDate) {
    strengths.push('A cohabitation commencement date has been provided, which may support household evidence.');
  }

  if (summary.sponsorCitizenshipStatus) {
    strengths.push('Sponsor immigration status information has been provided.');
  }

  if (!summary.email) risks.push('Email address not provided.');
  if (!summary.phone) risks.push('Phone number not provided.');
  if (!summary.location) risks.push('Current location not provided.');
  if (!summary.relationshipStatus) risks.push('Relationship status not provided.');
  if (!summary.sponsorStatus && !summary.sponsorCitizenshipStatus) risks.push('Sponsor eligibility information is incomplete.');
  if (!summary.notes) risks.push('Limited case detail has been provided for deeper assessment.');

  if (summary.refusalHistory) {
    risks.push('The client has indicated prior refusal or relevant immigration history that should be reviewed carefully.');
    recommendedNextSteps.push('Review all previous visa refusal, cancellation, or immigration history documents before proceeding.');
  }

  if (summary.healthIssues) {
    risks.push('Potential health issues were flagged and may require further assessment.');
    recommendedNextSteps.push('Obtain more detail regarding any health issues and likely evidentiary requirements.');
  }

  if (summary.characterIssues) {
    risks.push('Potential character issues were flagged and may require further assessment.');
    recommendedNextSteps.push('Review police, court, or related character documents before application strategy is finalised.');
  }

  const customFindings = toArray(payload.findings);
  const customStrengths = toArray(payload.strengths);
  const customRisks = toArray(payload.risks);
  const customNextSteps = toArray(payload.recommendedNextSteps);

  findings.push(...customFindings);
  strengths.push(...customStrengths);
  risks.push(...customRisks);
  recommendedNextSteps.push(...customNextSteps);

  if (strengths.length === 0) {
    strengths.push('The submission contains some initial information suitable for a preliminary review.');
  }

  if (recommendedNextSteps.length === 0) {
    recommendedNextSteps.push('Obtain a full migration consultation and document review before lodging any application.');
  }

  const suitability =
    risks.length >= 4
      ? 'Requires detailed review before eligibility can be assessed'
      : 'Potentially suitable subject to full legal and evidentiary review';

  return {
    outcome: 'Preliminary assessment completed',
    suitability,
    findings,
    strengths,
    risks,
    recommendedNextSteps,
  };
}

async function ensureTempDir() {
  const dir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'bircan-backend',
    website: 'https://www.bircanmigration.au',
    message: 'Backend is running',
    endpoints: {
      health: '/api/health',
      contact: '/api/contact',
      assessmentSubmit: '/api/assessment/submit',
      assessmentPdf: '/api/assessment/pdf',
      upload: '/api/upload',
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'bircan-backend',
    website: 'https://www.bircanmigration.au',
    hasFrontendUrl: Boolean(process.env.FRONTEND_URL),
    nodeEnv: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/contact', async (req, res) => {
  try {
    const body = req.body || {};

    const contact = {
      fullName: safeString(body.fullName),
      email: safeString(body.email),
      phone: safeString(body.phone),
      subject: safeString(body.subject),
      message: safeString(body.message),
      submittedAt: new Date().toISOString(),
    };

    if (!contact.fullName || !contact.email || !contact.message) {
      return res.status(400).json({
        ok: false,
        error: 'fullName, email and message are required.',
      });
    }

    return res.json({
      ok: true,
      message: 'Contact enquiry received successfully.',
      contact,
    });
  } catch (error) {
    console.error('CONTACT ERROR:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to process contact enquiry.',
    });
  }
});

app.post('/api/assessment/submit', async (req, res) => {
  try {
    const payload = req.body || {};
    const summary = buildAssessmentSummary(payload);
    const assessment = buildAssessmentResult(summary, payload);

    return res.json({
      ok: true,
      message: 'Assessment submitted successfully.',
      summary,
      assessment,
    });
  } catch (error) {
    console.error('ASSESSMENT SUBMIT ERROR:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to submit assessment.',
    });
  }
});

app.post('/api/assessment/pdf', async (req, res) => {
  try {
    const payload = req.body || {};
    const summary = buildAssessmentSummary(payload);
    const assessment = buildAssessmentResult(summary, payload);

    const pdfData = {
      ...summary,
      assessment,
      firmName: 'Bircan Migration',
      website: 'https://www.bircanmigration.au',
      generatedAt: new Date().toISOString(),
    };

    const pdfResult = await generatePDF(pdfData);
    const filename = `${summary.visaType.replace(/[^a-z0-9]+/gi, '_')}_assessment_letter.pdf`;

    if (Buffer.isBuffer(pdfResult)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdfResult);
    }

    if (typeof pdfResult === 'string') {
      const absolutePath = path.isAbsolute(pdfResult)
        ? pdfResult
        : path.join(__dirname, pdfResult);

      if (!fs.existsSync(absolutePath)) {
        return res.status(500).json({
          ok: false,
          error: 'PDF was generated but the file could not be found.',
        });
      }

      return res.download(absolutePath, filename);
    }

    return res.status(500).json({
      ok: false,
      error: 'PDF generator did not return a valid Buffer or file path.',
    });
  } catch (error) {
    console.error('PDF GENERATION ERROR:', error);
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to generate PDF.',
    });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'No file uploaded.',
      });
    }

    const dir = await ensureTempDir();
    const filename = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const outputPath = path.join(dir, filename);

    fs.writeFileSync(outputPath, req.file.buffer);

    return res.json({
      ok: true,
      message: 'File uploaded successfully.',
      file: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        savedAs: filename,
      },
    });
  } catch (error) {
    console.error('UPLOAD ERROR:', error);
    return res.status(500).json({
      ok: false,
      error: 'File upload failed.',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Route not found.',
    path: req.originalUrl,
  });
});

app.use((err, req, res, next) => {
  console.error('UNHANDLED SERVER ERROR:', err);

  if (err.message?.startsWith('CORS blocked')) {
    return res.status(403).json({
      ok: false,
      error: err.message,
    });
  }

  return res.status(500).json({
    ok: false,
    error: err?.message || 'Internal server error.',
  });
});

app.listen(PORT, () => {
  console.log(`✅ bircan-backend running on port ${PORT}`);
});
