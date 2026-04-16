import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 10000);

const APP_BASE_URL = String(
  process.env.APP_BASE_URL || `http://localhost:${PORT}`
).replace(/\/$/, '');

const FRONTEND_SUCCESS_URL = String(
  process.env.FRONTEND_SUCCESS_URL || `${APP_BASE_URL}/success.html`
).replace(/\/$/, '');

const FRONTEND_CANCEL_URL = String(
  process.env.FRONTEND_CANCEL_URL || `${APP_BASE_URL}/cancel.html`
).replace(/\/$/, '');

const storageDir = path.join(__dirname, 'storage');
const submissionsDir = path.join(storageDir, 'submissions');
const publicDir = path.join(__dirname, 'public');
const reportsDir = path.join(publicDir, 'reports');

fs.mkdirSync(submissionsDir, { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/reports', express.static(reportsDir));

function safe(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safe(value, '');
  return date.toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function submissionFile(id) {
  return path.join(submissionsDir, `${id}.json`);
}

function readSubmission(id) {
  if (!id) return null;
  const file = submissionFile(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSubmission(id, data) {
  fs.writeFileSync(submissionFile(id), JSON.stringify(data, null, 2));
}

function createSubmission(data = {}) {
  const id = nanoid(12);
  const now = new Date().toISOString();

  const record = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'submitted',
    paymentStatus: 'unpaid',
    stripeSessionId: null,
    stripePaymentIntentId: null,
    paidAt: null,
    pdfPath: null,
    pdfUrl: null,
    emailSentAt: null,
    ...data,
  };

  writeSubmission(id, record);
  return record;
}

function updateSubmission(id, patch = {}) {
  const existing = readSubmission(id);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  writeSubmission(id, updated);
  return updated;
}

function listSubmissions() {
  return fs
    .readdirSync(submissionsDir)
    .filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(submissionsDir, file), 'utf8')))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendAdminNotification(submission) {
  try {
    const transporter = createTransporter();
    const to = process.env.ADMIN_NOTIFY_EMAIL;

    if (!transporter || !to) return false;

    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'Bircan Migration <noreply@bircanmigration.com.au>',
      to,
      subject: `New Bircan Migration submission: ${safe(submission.type, 'Assessment')}`,
      text: `Submission ID: ${submission.id}
Type: ${safe(submission.type)}
Name: ${safe(submission.fullName || submission.name)}
Email: ${safe(submission.email)}
Phone: ${safe(submission.phone)}
Visa Type: ${safe(submission.visaType)}
Plan: ${safe(submission.planLabel || submission.productName || submission.productKey)}
`,
    });

    return true;
  } catch (error) {
    console.error('sendAdminNotification error:', error);
    return false;
  }
}

async function sendClientReceipt(submission) {
  try {
    const transporter = createTransporter();

    if (!transporter || !submission.email) return false;

    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'Bircan Migration <noreply@bircanmigration.com.au>',
      to: submission.email,
      subject: 'Your Bircan Migration submission',
      text: `Dear ${safe(submission.fullName || submission.name, 'Client')},

Thank you for your submission.

Reference ID: ${submission.id}

We have received your information.

Bircan Migration
https://bircanmigration.com.au`,
    });

    return true;
  } catch (error) {
    console.error('sendClientReceipt error:', error);
    return false;
  }
}

async function sendFinalReportEmail(submission, pdfBuffer) {
  try {
    const transporter = createTransporter();

    if (!transporter || !submission.email || !pdfBuffer) return false;

    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'Bircan Migration <noreply@bircanmigration.com.au>',
      to: submission.email,
      subject: 'Your Migration Assessment Letter',
      text: `Dear ${safe(submission.fullName || submission.name, 'Client')},

Thank you for your payment.

Your assessment letter is attached to this email.

Reference ID: ${submission.id}

Bircan Migration
https://bircanmigration.com.au`,
      attachments: [
        {
          filename: `assessment-${submission.id}.pdf`,
          content: pdfBuffer,
        },
      ],
    });

    return true;
  } catch (error) {
    console.error('sendFinalReportEmail error:', error);
    return false;
  }
}

function buildAssessment(submission = {}) {
  const findings = [];
  const strengths = [];
  const risks = [];
  const recommendedNextSteps = [];

  if (submission.visaType) findings.push(`Assessment requested for ${submission.visaType}.`);
  if (submission.currentVisa) findings.push(`Current visa recorded as ${submission.currentVisa}.`);
  if (submission.relationshipStatus) findings.push(`Relationship status: ${submission.relationshipStatus}.`);
  if (submission.location) findings.push(`Client location: ${submission.location}.`);
  if (submission.planLabel || submission.productName) {
    findings.push(`Selected package: ${safe(submission.planLabel || submission.productName)}.`);
  }

  if (submission.email) strengths.push('Client email provided for communication.');
  if (submission.phone) strengths.push('Client phone number provided.');
  if (submission.relationshipStartDate) strengths.push('Relationship timeline supplied.');
  if (submission.cohabitationStartDate) strengths.push('Cohabitation date supplied.');

  if (!submission.currentVisa) risks.push('Current visa details should be confirmed.');
  if (!submission.nationality) risks.push('Nationality details should be confirmed.');
  if (!submission.phone) risks.push('Phone number should be confirmed.');
  if (!submission.relationshipStartDate && /partner/i.test(safe(submission.visaType))) {
    risks.push('Relationship commencement evidence may be required.');
  }

  recommendedNextSteps.push('Review supporting evidence and identity documents.');
  recommendedNextSteps.push('Confirm immigration history and current visa status.');
  recommendedNextSteps.push('Book a professional consultation before lodgement.');

  return {
    outcome: risks.length <= 1 ? 'Promising initial assessment' : 'Further review recommended',
    suitability: risks.length <= 1 ? 'Good preliminary profile' : 'Requires targeted review',
    findings: findings.length ? findings : ['Preliminary information was received and assessed.'],
    strengths: strengths.length
      ? strengths
      : ['Sufficient initial information was provided for a preliminary review.'],
    risks,
    recommendedNextSteps,
  };
}

async function generatePdfBuffer(submission) {
  return new Promise((resolve, reject) => {
    try {
      const assessment = submission.assessment || buildAssessment(submission);

      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 50,
          bottom: 50,
          left: 50,
          right: 50,
        },
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.rect(0, 0, doc.page.width, 95).fill('#0E3A5D');

      doc
        .font('Helvetica-Bold')
        .fontSize(21)
        .fillColor('#FFFFFF')
        .text('Bircan Migration', 50, 25, { width: 280 });

      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#D9ECFA')
        .text('https://bircanmigration.com.au', 50, 54, { width: 280 });

      doc
        .font('Helvetica-Bold')
        .fontSize(16)
        .fillColor('#FFFFFF')
        .text('Client Assessment Letter', 310, 28, { width: 220, align: 'right' });

      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#D9ECFA')
        .text(`Generated: ${formatDate(new Date().toISOString())}`, 310, 54, {
          width: 220,
          align: 'right',
        });

      doc.y = 125;

      doc
        .font('Helvetica-Bold')
        .fontSize(15)
        .fillColor('#163955')
        .text(`Client: ${safe(submission.fullName || submission.name, 'Client')}`, 50, doc.y, {
          width: 495,
        });

      doc.moveDown(0.5);

      doc
        .font('Helvetica')
        .fontSize(10.5)
        .fillColor('#374151')
        .text(
          `This document sets out a preliminary migration assessment summary for ${safe(
            submission.visaType,
            'the requested visa pathway'
          )}. It is based on the information provided by the client and should be treated as an initial review only.`,
          {
            width: 495,
            lineGap: 3,
          }
        );

      doc.moveDown(1);

      function section(title) {
        doc.moveDown(0.5);
        const y = doc.y;

        doc.roundedRect(50, y, 495, 24, 6).fill('#EAF4FB');

        doc
          .font('Helvetica-Bold')
          .fontSize(12)
          .fillColor('#0E3A5D')
          .text(title, 62, y + 7, { width: 460 });

        doc.y = y + 32;
      }

      function labelValue(label, value, fallback = 'Not provided') {
        const y = doc.y;

        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor('#163955')
          .text(label, 50, y, { width: 125 });

        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor('#222222')
          .text(safe(value, fallback), 185, y, {
            width: 350,
            lineGap: 2,
          });

        doc.moveDown(0.9);
      }

      function bullets(items, emptyText) {
        if (!items || !items.length) {
          doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#444444')
            .text(emptyText, 62, doc.y, { width: 470 });

          doc.moveDown(0.8);
          return;
        }

        for (const item of items) {
          const y = doc.y;

          doc
            .font('Helvetica-Bold')
            .fontSize(11)
            .fillColor('#0F5E9C')
            .text('•', 62, y);

          doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#222222')
            .text(safe(item), 78, y, {
              width: 450,
              lineGap: 2,
            });

          doc.moveDown(0.45);
        }

        doc.moveDown(0.3);
      }

      section('Client Information');
      labelValue('Full name', submission.fullName || submission.name);
      labelValue('Visa type', submission.visaType);
      labelValue('Selected plan', submission.planLabel || submission.productName || submission.productKey);
      labelValue('Email', submission.email);
      labelValue('Phone', submission.phone);
      labelValue('Date of birth', submission.dateOfBirth ? formatDate(submission.dateOfBirth) : '');
      labelValue('Nationality', submission.nationality);
      labelValue('Current location', submission.location);
      labelValue('Relationship status', submission.relationshipStatus);
      labelValue('Sponsor status', submission.sponsorStatus || submission.sponsorCitizenshipStatus);
      labelValue('Current visa', submission.currentVisa || submission.applicantStatus);
      labelValue(
        'Relationship start date',
        submission.relationshipStartDate ? formatDate(submission.relationshipStartDate) : ''
      );
      labelValue(
        'Cohabitation start date',
        submission.cohabitationStartDate ? formatDate(submission.cohabitationStartDate) : ''
      );
      labelValue('Notes', submission.notes);
      labelValue('Submitted', formatDate(submission.submittedAt || submission.createdAt));

      section('Assessment Outcome');
      labelValue('Outcome', assessment.outcome);
      labelValue('Suitability', assessment.suitability);

      section('Key Findings');
      bullets(assessment.findings, 'No findings recorded.');

      section('Strengths');
      bullets(assessment.strengths, 'No strengths recorded.');

      section('Risks / Review Flags');
      bullets(
        assessment.risks,
        'No immediate review flags were identified in this preliminary summary.'
      );

      section('Recommended Next Steps');
      bullets(assessment.recommendedNextSteps, 'No next steps recorded.');

      section('Important Notice');
      doc
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor('#444444')
        .text(
          'This letter is a preliminary assessment summary only. It does not constitute formal legal advice, a final eligibility determination, or a guarantee of visa outcome. A full review of evidence, history, legal criteria, and application strategy should be completed before any application is lodged.',
          62,
          doc.y,
          {
            width: 470,
            lineGap: 4,
          }
        );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

const PRODUCT_CATALOG = {
  '309-1h': { name: 'Subclass 309 Assessment - 1 Hour', amount: 299, currency: 'aud' },
  '309-24h': { name: 'Subclass 309 Assessment - 24 Hours', amount: 199, currency: 'aud' },
  '309-3d': { name: 'Subclass 309 Assessment - 3 Days', amount: 149, currency: 'aud' },
  '309-7d': { name: 'Subclass 309 Assessment - 7 Days', amount: 99, currency: 'aud' },

  'partner-309-100-review': { name: 'Partner Visa 309/100 Premium Review', amount: 79, currency: 'aud' },
  'partner-820-801-review': { name: 'Partner Visa 820/801 Premium Review', amount: 79, currency: 'aud' },
  'aat-appeals-review': { name: 'AAT Appeals Risk Review', amount: 199, currency: 'aud' },
  'citizenship-eligibility-review': { name: 'Citizenship Eligibility Review', amount: 49, currency: 'aud' },
};

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
    hasStripeKey: Boolean(process.env.STRIPE_SECRET_KEY),
    hasSmtp: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    appBaseUrl: APP_BASE_URL,
  });
});

app.get('/api/stripe-check', (_req, res) => {
  res.json({
    ok: true,
    hasStripeKey: Boolean(process.env.STRIPE_SECRET_KEY),
    keyPrefix: process.env.STRIPE_SECRET_KEY
      ? process.env.STRIPE_SECRET_KEY.slice(0, 7)
      : null,
    successUrl: FRONTEND_SUCCESS_URL,
    cancelUrl: FRONTEND_CANCEL_URL,
  });
});

app.post('/api/assessment/submit', async (req, res) => {
  try {
    const payload = req.body || {};
    const fullName = safe(payload.fullName || payload.name, '');
    const email = safe(payload.email, '');

    if (!fullName && !email) {
      return res.status(400).json({
        ok: false,
        error: 'Please provide at least a client name or email address.',
      });
    }

    const submission = createSubmission({
      ...payload,
      name: fullName || safe(payload.name, ''),
      fullName: fullName || safe(payload.name, ''),
      email,
      type: payload.type || payload.productKey || payload.visaType || 'general-assessment',
      status: 'submitted',
      paymentStatus: 'unpaid',
      submittedAt: new Date().toISOString(),
      assessment: payload.assessment || buildAssessment(payload),
    });

    await Promise.allSettled([
      sendAdminNotification(submission),
      sendClientReceipt(submission),
    ]);

    return res.json({
      ok: true,
      submissionId: submission.id,
      submission,
    });
  } catch (error) {
    console.error('submit error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to save assessment submission.',
    });
  }
});

app.post('/api/payments/checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        ok: false,
        error: 'Stripe is not configured on the server.',
      });
    }

    const {
      submissionId,
      productKey,
      amount,
      currency,
      customerEmail,
      customerName,
      planLabel,
    } = req.body || {};

    const submission = readSubmission(submissionId);

    if (!submission) {
      return res.status(404).json({
        ok: false,
        error: 'Submission not found.',
      });
    }

    const product = PRODUCT_CATALOG[productKey] || {
      name: safe(planLabel, 'Migration Assessment'),
      amount: Number(amount) || 99,
      currency: safe(currency, 'aud').toLowerCase(),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: safe(customerEmail || submission.email, ''),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: product.currency,
            unit_amount: Math.round(Number(product.amount) * 100),
            product_data: {
              name: product.name,
            },
          },
        },
      ],
      success_url: `${FRONTEND_SUCCESS_URL}?submissionId=${encodeURIComponent(
        submissionId
      )}&productKey=${encodeURIComponent(productKey || '')}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_CANCEL_URL}?submissionId=${encodeURIComponent(submissionId)}`,
      metadata: {
        submissionId,
        productKey: safe(productKey, ''),
        customerName: safe(customerName || submission.fullName || submission.name, ''),
        customerEmail: safe(customerEmail || submission.email, ''),
      },
    });

    updateSubmission(submissionId, {
      stripeSessionId: session.id,
      productKey: safe(productKey, ''),
      productName: product.name,
      planLabel: safe(planLabel || product.name, product.name),
      amount: product.amount,
      currency: product.currency,
    });

    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to create checkout session.',
    });
  }
});

app.post('/api/payments/mark-paid', async (req, res) => {
  try {
    const { submissionId, sessionId, paymentIntentId } = req.body || {};
    const submission = readSubmission(submissionId);

    if (!submission) {
      return res.status(404).json({
        ok: false,
        error: 'Submission not found.',
      });
    }

    updateSubmission(submissionId, {
      paymentStatus: 'paid',
      status: 'paid',
      stripeSessionId: sessionId || submission.stripeSessionId || null,
      stripePaymentIntentId: paymentIntentId || submission.stripePaymentIntentId || null,
      paidAt: new Date().toISOString(),
    });

    const latest = readSubmission(submissionId);
    const pdfBuffer = await generatePdfBuffer(latest);
    const fileName = `assessment-${submissionId}.pdf`;
    const filePath = path.join(reportsDir, fileName);
    const pdfUrl = `/reports/${fileName}`;

    fs.writeFileSync(filePath, pdfBuffer);

    updateSubmission(submissionId, {
      pdfPath: filePath,
      pdfUrl,
    });

    const emailSent = await sendFinalReportEmail(readSubmission(submissionId), pdfBuffer);

    if (emailSent) {
      updateSubmission(submissionId, {
        emailSentAt: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      message: 'Payment recorded and PDF generated.',
      submissionId,
      downloadUrl: `${APP_BASE_URL}${pdfUrl}`,
      submission: readSubmission(submissionId),
    });
  } catch (error) {
    console.error('mark-paid error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to mark payment as paid.',
    });
  }
});

app.get('/api/admin/submissions', (_req, res) => {
  return res.json({
    ok: true,
    items: listSubmissions(),
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.listen(PORT, () => {
  console.log(`Bircan Migration backend running on port ${PORT}`);
});
