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

// This expects pdf.js to export a DEFAULT function:
// export default async function generatePDF(data) { ... }
import generatePDF from './pdf.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);

function cleanString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function buildAssessmentSummary(payload = {}) {
  const visaType = cleanString(payload.visaType, 'Migration Assessment');
  const fullName = cleanString(payload.fullName || payload.name, 'Client');
  const email = cleanString(payload.email, '');
  const phone = cleanString(payload.phone, '');
  const nationality = cleanString(payload.nationality, '');
  const location = cleanString(payload.location, '');
  const relationshipStatus = cleanString(payload.relationshipStatus, '');
  const sponsorStatus = cleanString(payload.sponsorStatus, '');
  const applicantStatus = cleanString(payload.applicantStatus, '');
  const notes = cleanString(
    payload.notes ||
      payload.additionalInformation ||
      payload.additionalInfo ||
      ''
  );

  return {
    visaType,
    fullName,
    email,
    phone,
    nationality,
    location,
    relationshipStatus,
    sponsorStatus,
    applicantStatus,
    notes,
    submittedAt: new Date().toISOString(),
  };
}

function buildSimpleAssessmentResult(summary) {
  const findings = [];
  const risks = [];
  const strengths = [];
  const recommendedNextSteps = [];

  if (summary.visaType.toLowerCase().includes('309')) {
    strengths.push(
      'This appears to align with the offshore partner visa pathway where the relationship is genuine and continuing.'
    );
    recommendedNextSteps.push(
      'Prepare evidence across financial, social, household, and commitment aspects of the relationship.'
    );
    recommendedNextSteps.push(
      'Organise identity documents, relationship timeline, communication history, and sponsor documents.'
    );
  }

  if (summary.relationshipStatus) {
    findings.push(`Relationship status: ${summary.relationshipStatus}`);
  }

  if (summary.sponsorStatus) {
    findings.push(`Sponsor status: ${summary.sponsorStatus}`);
  }

  if (summary.applicantStatus) {
    findings.push(`Applicant status: ${summary.applicantStatus}`);
  }

  if (summary.nationality) {
    findings.push(`Nationality: ${summary.nationality}`);
  }

  if (summary.location) {
    findings.push(`Current location: ${summary.location}`);
  }

  if (!summary.email) {
    risks.push('Email address was not provided.');
  }

  if (!summary.phone) {
    risks.push('Phone number was not provided.');
  }

  if (!summary.notes) {
    recommendedNextSteps.push(
      'Provide additional personal background and case details for a more accurate review.'
    );
  }

  if (risks.length === 0) {
    strengths.push(
      'The submission includes enough core information for an initial review.'
    );
  }

  return {
    outcome: 'Initial assessment completed',
    suitability: 'Preliminary only',
    findings,
    strengths,
    risks,
    recommendedNextSteps,
  };
}

async function ensureTempDir() {
  const dir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasFrontendUrl: Boolean(process.env.FRONTEND_URL),
    nodeEnv: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/contact', async (req, res) => {
  try {
    const body = req.body || {};

    const contact = {
      fullName: cleanString(body.fullName),
      email: cleanString(body.email),
      phone: cleanString(body.phone),
      subject: cleanString(body.subject),
      message: cleanString(body.message),
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
    const assessment = buildSimpleAssessmentResult(summary);

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
    const assessment = buildSimpleAssessmentResult(summary);

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
