'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

let Stripe = null;
try {
  Stripe = require('stripe');
} catch (_) {}

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {}

const app = express();

const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || 'development';

const PRIMARY_FRONTEND_URL = 'https://assessment.bircanmigration.au';
const HARDCODED_ALLOWED_ORIGINS = [
  'https://assessment.bircanmigration.au',
  'https://www.assessment.bircanmigration.au',
  'https://www.bircanmigration.au',
  'https://bircanmigration.au',
  'https://www.bircanmigration.com.au',
  'https://bircanmigration.com.au',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'null',
];

const FRONTEND_URL_OVERRIDE = String(process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
const APP_BASE_URL = FRONTEND_URL_OVERRIDE || PRIMARY_FRONTEND_URL;
const ALLOWED_ORIGINS = HARDCODED_ALLOWED_ORIGINS;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || 'aud').toLowerCase();
const STRIPE_TAX_BEHAVIOR = process.env.STRIPE_TAX_BEHAVIOR || 'exclusive';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@bircanmigration.com.au';

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'data');
const SUBMISSIONS_DIR = path.join(STORAGE_DIR, 'submissions');
const PDF_DIR = path.join(STORAGE_DIR, 'pdfs');

const stripe = Stripe && STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(STORAGE_DIR);
ensureDirSync(SUBMISSIONS_DIR);
ensureDirSync(PDF_DIR);

function nowIso() {
  return new Date().toISOString();
}

function safeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function submissionPath(submissionId) {
  return path.join(SUBMISSIONS_DIR, `${sanitizeFileName(submissionId)}.json`);
}

async function getSubmission(submissionId) {
  return readJsonSafe(submissionPath(submissionId), null);
}

async function saveSubmission(submission) {
  submission.updatedAt = nowIso();
  await writeJson(submissionPath(submission.id), submission);
  return submission;
}

async function updateSubmission(submissionId, patch) {
  const current = (await getSubmission(submissionId)) || { id: submissionId, createdAt: nowIso() };
  const next = { ...current, ...patch, id: submissionId };
  await saveSubmission(next);
  return next;
}

function normalizePlan(input) {
  const raw = String(input || '').trim().toLowerCase();
  const map = {
    instant: { code: 'instant', label: 'Instant', price: 30000, turnaround: 'Instant' },
    '24 hours': { code: '24h', label: '24 Hours', price: 25000, turnaround: '24 hours' },
    '24h': { code: '24h', label: '24 Hours', price: 25000, turnaround: '24 hours' },
    '3 days': { code: '3d', label: '3 Days', price: 15000, turnaround: '3 days' },
    '3d': { code: '3d', label: '3 Days', price: 15000, turnaround: '3 days' },
  };
  return map[raw] || map.instant;
}

function extractAssessmentPayload(body = {}) {
  const plan = normalizePlan(body.plan || body.package || body.delivery);
  const client = body.client || {};
  const answers = Array.isArray(body.answers) ? body.answers : body.responses || body.questions || [];
  return {
    visaType: body.visaType || body.subclass || 'Subclass 482',
    plan,
    client: {
      fullName: client.fullName || body.fullName || '',
      email: (client.email || body.email || '').trim(),
      phone: client.phone || body.phone || '',
      dob: client.dob || body.dob || '',
      nationality: client.nationality || body.nationality || '',
    },
    answers,
    notes: body.notes || '',
    metadata: body.metadata || {},
  };
}

async function generatePdfFallback(submission) {
  const pdfFileName = `${sanitizeFileName(submission.id)}.pdf`;
  const pdfPath = path.join(PDF_DIR, pdfFileName);

  const lines = [
    'BIRCAN MIGRATION & EDUCATION',
    'Assessment Letter of Advice',
    '',
    `Submission ID: ${submission.id}`,
    `Visa Type: ${submission.visaType || ''}`,
    `Client: ${submission.client?.fullName || ''}`,
    `Email: ${submission.client?.email || ''}`,
    `Plan: ${submission.plan?.label || ''}`,
    `Generated At: ${nowIso()}`,
    '',
    'Assessment Summary',
    submission.analysis?.summary || 'Assessment received and processed.',
    '',
    'Answers',
    ...((submission.answers || []).map((a, index) => `${index + 1}. ${typeof a === 'string' ? a : `${a.question || 'Question'}: ${a.answer || ''}`}`)),
    '',
    'Important',
    'This auto-generated letter should be reviewed by Bircan Migration & Education before being treated as formal advice.',
  ];

  const minimalPdf = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${lines.join('\n').length + 120}>>stream
BT
/F1 11 Tf
50 760 Td
(${lines.join(' ').replace(/[()\\]/g, ' ')}) Tj
ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000063 00000 n 
0000000120 00000 n 
0000000260 00000 n 
0000000460 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
530
%%EOF`);
  await fsp.writeFile(pdfPath, minimalPdf);
  return { pdfPath, pdfUrl: `/api/assessment/${encodeURIComponent(submission.id)}/pdf` };
}

async function tryGeneratePdf(submission) {
  try {
    const customPdfModule = require(path.join(__dirname, 'pdf'));
    if (typeof customPdfModule.generateAssessmentPdf === 'function') {
      const result = await customPdfModule.generateAssessmentPdf(submission);
      if (result?.pdfPath) return result;
      if (typeof result === 'string') return { pdfPath: result, pdfUrl: `/api/assessment/${encodeURIComponent(submission.id)}/pdf` };
    }
  } catch (_) {}
  return generatePdfFallback(submission);
}

async function sendEmailFallback({ to, subject, text, html, attachments }) {
  if (!SMTP_HOST || !nodemailer) {
    return { ok: false, skipped: true, reason: 'SMTP not configured' };
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  const info = await transporter.sendMail({ from: SMTP_FROM, to, subject, text, html, attachments });
  return { ok: true, messageId: info.messageId };
}

async function trySendAssessmentEmail(submission, pdfPath) {
  const to = submission.client?.email;
  if (!to) {
    return { ok: false, skipped: true, reason: 'No client email on submission' };
  }

  try {
    const customMailer = require(path.join(__dirname, 'mailer'));
    if (typeof customMailer.sendAssessmentEmail === 'function') {
      return await customMailer.sendAssessmentEmail({ submission, pdfPath });
    }
  } catch (_) {}

  const subject = `Your ${submission.visaType || 'Visa'} assessment letter`;
  const text = [
    `Dear ${submission.client?.fullName || 'Client'},`,
    '',
    'Thank you for your assessment order with Bircan Migration & Education.',
    'Your PDF assessment letter is attached to this email.',
    '',
    'Kind regards,',
    'Bircan Migration & Education',
  ].join('\n');

  return sendEmailFallback({
    to,
    subject,
    text,
    html: `<p>Dear ${submission.client?.fullName || 'Client'},</p><p>Thank you for your assessment order with Bircan Migration &amp; Education.</p><p>Your PDF assessment letter is attached to this email.</p><p>Kind regards,<br>Bircan Migration &amp; Education</p>`,
    attachments: pdfPath ? [{ filename: path.basename(pdfPath), path: pdfPath }] : [],
  });
}

async function runAssessmentAnalysis(submission) {
  const answerCount = Array.isArray(submission.answers) ? submission.answers.length : 0;
  return {
    status: 'completed',
    summary: `Assessment processed for ${submission.visaType || 'visa assessment'} with ${answerCount} recorded response${answerCount === 1 ? '' : 's'}.`,
    generatedAt: nowIso(),
  };
}

async function processPaidSubmission(submissionId) {
  let submission = await getSubmission(submissionId);
  if (!submission) throw new Error(`Submission not found for ${submissionId}`);

  submission = await updateSubmission(submissionId, {
    paymentStatus: 'paid',
    analysisStatus: 'running',
    pdfStatus: 'generating',
    emailStatus: 'pending',
    processingStartedAt: nowIso(),
  });

  try {
    const analysis = await runAssessmentAnalysis(submission);
    submission = await updateSubmission(submissionId, {
      analysisStatus: analysis.status,
      analysis,
    });

    const pdfResult = await tryGeneratePdf(submission);
    submission = await updateSubmission(submissionId, {
      pdfStatus: pdfResult?.pdfPath ? 'generated' : 'failed',
      pdfPath: pdfResult?.pdfPath || null,
      pdfUrl: pdfResult?.pdfUrl || null,
    });

    const emailResult = await trySendAssessmentEmail(submission, pdfResult?.pdfPath);
    submission = await updateSubmission(submissionId, {
      emailStatus: emailResult?.ok ? 'sent' : (emailResult?.skipped ? 'skipped' : 'failed'),
      emailResult,
      processedAt: nowIso(),
      status: 'completed',
    });

    return await getSubmission(submissionId);
  } catch (error) {
    await updateSubmission(submissionId, {
      analysisStatus: 'failed',
      pdfStatus: 'failed',
      emailStatus: 'failed',
      processingError: error.message,
      processedAt: nowIso(),
      status: 'failed',
    });
    throw error;
  }
}

function corsOptionsDelegate(req, callback) {
  const origin = req.header('Origin');
  if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) || origin === 'null') {
    callback(null, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
    });
    return;
  }
  callback(null, { origin: false });
}

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(cors(corsOptionsDelegate));
app.options('*', cors(corsOptionsDelegate));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
    timestamp: nowIso(),
    env: NODE_ENV,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
    hasStripeKey: Boolean(STRIPE_SECRET_KEY),
    hasStripeWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET),
    hasSmtp: Boolean(SMTP_HOST && nodemailer),
    appBaseUrl: APP_BASE_URL,
    allowedOrigins: ALLOWED_ORIGINS,
    timestamp: nowIso(),
  });
});

app.post('/api/assessment/submit', async (req, res, next) => {
  try {
    const payload = extractAssessmentPayload(req.body);
    if (!payload.client.email) {
      return res.status(400).json({ ok: false, error: 'Client email is required.' });
    }

    const submissionId = safeId('sub');
    const submission = {
      id: submissionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'created',
      paymentStatus: 'unpaid',
      analysisStatus: 'not_started',
      pdfStatus: 'not_generated',
      emailStatus: 'not_sent',
      ...payload,
    };

    await saveSubmission(submission);
    res.status(201).json({ ok: true, submissionId, status: submission.status, paymentStatus: submission.paymentStatus });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assessment/:submissionId/status', async (req, res, next) => {
  try {
    const submission = await getSubmission(req.params.submissionId);
    if (!submission) return res.status(404).json({ ok: false, error: 'Submission not found.' });
    res.json({
      ok: true,
      submissionId: submission.id,
      status: submission.status || 'created',
      paymentStatus: submission.paymentStatus || 'unpaid',
      analysisStatus: submission.analysisStatus || 'not_started',
      pdfStatus: submission.pdfStatus || 'not_generated',
      emailStatus: submission.emailStatus || 'not_sent',
      pdfUrl: submission.pdfUrl || null,
      processingError: submission.processingError || null,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assessment/:submissionId/pdf', async (req, res, next) => {
  try {
    const submission = await getSubmission(req.params.submissionId);
    if (!submission || !submission.pdfPath) {
      return res.status(404).json({ ok: false, error: 'PDF not found.' });
    }
    if (!fs.existsSync(submission.pdfPath)) {
      return res.status(404).json({ ok: false, error: 'PDF not found.' });
    }
    res.download(submission.pdfPath, path.basename(submission.pdfPath));
  } catch (error) {
    next(error);
  }
});

app.post('/api/payments/create-checkout-session', async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
    }

    const submissionId = req.body?.submissionId;
    if (!submissionId) {
      return res.status(400).json({ ok: false, error: 'submissionId is required.' });
    }

    const submission = await getSubmission(submissionId);
    if (!submission) {
      return res.status(404).json({ ok: false, error: 'Submission not found.' });
    }

    const successUrl = `${APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&submissionId=${encodeURIComponent(submissionId)}`;
    const cancelUrl = `${APP_BASE_URL}/cancel.html?submissionId=${encodeURIComponent(submissionId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: submission.client?.email || undefined,
      metadata: {
        submissionId,
        visaType: submission.visaType || 'Assessment',
        planCode: submission.plan?.code || '',
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: STRIPE_CURRENCY,
            unit_amount: Number(submission.plan?.price || 30000),
            tax_behavior: STRIPE_TAX_BEHAVIOR,
            product_data: {
              name: `${submission.visaType || 'Visa'} Assessment - ${submission.plan?.label || 'Plan'}`,
              description: `Turnaround: ${submission.plan?.turnaround || ''}`,
            },
          },
        },
      ],
    });

    await updateSubmission(submissionId, {
      status: 'checkout_created',
      checkoutSessionId: session.id,
      paymentStatus: 'pending',
    });

    res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/payments/confirm', async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
    }

    const sessionId = req.body?.sessionId;
    const submissionIdFromBody = req.body?.submissionId;
    if (!sessionId && !submissionIdFromBody) {
      return res.status(400).json({ ok: false, error: 'sessionId or submissionId is required.' });
    }

    let session = null;
    let submissionId = submissionIdFromBody || null;

    if (sessionId) {
      session = await stripe.checkout.sessions.retrieve(sessionId);
      submissionId = submissionId || session?.metadata?.submissionId || null;
    }

    if (!submissionId) {
      return res.status(400).json({ ok: false, error: 'No submissionId could be resolved.' });
    }

    if (session && session.payment_status !== 'paid') {
      return res.status(400).json({ ok: false, error: 'Stripe session is not paid yet.', paymentStatus: session.payment_status });
    }

    const existing = await getSubmission(submissionId);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Submission not found.' });
    }

    await updateSubmission(submissionId, {
      status: 'paid',
      paymentStatus: 'paid',
      stripeSessionId: session?.id || existing.stripeSessionId || null,
      stripePaymentIntentId: session?.payment_intent || existing.stripePaymentIntentId || null,
      paidAt: nowIso(),
    });

    const processed = await processPaidSubmission(submissionId);
    res.json({
      ok: true,
      submissionId,
      status: processed.status || 'paid',
      paymentStatus: processed.paymentStatus,
      analysisStatus: processed.analysisStatus,
      pdfStatus: processed.pdfStatus,
      emailStatus: processed.emailStatus,
      pdfUrl: processed.pdfUrl || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/payments/webhook', async (req, res, next) => {
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({ ok: false, error: 'Stripe webhook is not configured.' });
    }

    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).json({ ok: false, error: 'Missing Stripe signature header.' });
    }

    const event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const submissionId = session?.metadata?.submissionId;
      if (submissionId) {
        await updateSubmission(submissionId, {
          status: 'paid',
          paymentStatus: 'paid',
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent || null,
          paidAt: nowIso(),
          lastWebhookEventId: event.id,
        });

        processPaidSubmission(submissionId).catch(async (error) => {
          await updateSubmission(submissionId, {
            processingError: error.message,
            analysisStatus: 'failed',
            pdfStatus: 'failed',
            emailStatus: 'failed',
            status: 'failed',
          });
        });
      }
    }

    if (event.type === 'checkout.session.async_payment_failed' || event.type === 'payment_intent.payment_failed') {
      const object = event.data.object;
      const submissionId = object?.metadata?.submissionId || null;
      if (submissionId) {
        await updateSubmission(submissionId, {
          paymentStatus: 'failed',
          status: 'payment_failed',
          lastWebhookEventId: event.id,
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error('[server-error]', error);
  const status = Number(error.statusCode || error.status || 500);
  res.status(status).json({
    ok: false,
    error: error.message || 'Internal Server Error',
  });
});

app.listen(PORT, () => {
  console.log(`Bircan Migration backend listening on port ${PORT}`);
});
