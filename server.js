import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import Stripe from 'stripe';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 10000);
const WEBSITE_URL = process.env.WEBSITE_URL || 'https://www.bircanmigration.au';
const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL || `${WEBSITE_URL}/payment-success.html`;
const FRONTEND_CANCEL_URL = process.env.FRONTEND_CANCEL_URL || `${WEBSITE_URL}/payment-cancelled.html`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || 'aud').toLowerCase();
const ASSESSMENT_PRICE_CENTS = Number(process.env.ASSESSMENT_PRICE_CENTS || 9900);
const allowedOrigins = (process.env.BM_ALLOWED_ORIGINS || WEBSITE_URL)
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

if (!STRIPE_SECRET_KEY) {
  console.warn('[startup] STRIPE_SECRET_KEY is missing. Payment endpoints will fail until it is configured.');
}

const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_test_placeholder_for_boot', {
  apiVersion: '2025-02-24.acacia',
  timeout: 20000,
  maxNetworkRetries: 2
});

const dataDir = path.join(__dirname, 'data');
const assessmentsDir = path.join(dataDir, 'assessments');
const pdfDir = path.join(dataDir, 'pdfs');
fs.mkdirSync(assessmentsDir, { recursive: true });
fs.mkdirSync(pdfDir, { recursive: true });

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));
app.use(compression());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed: ${origin}`));
  }
}));
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(pdfDir));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', apiLimiter);

function cleanText(value, fallback = 'Not provided') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function ensureStripeReady() {
  if (!STRIPE_SECRET_KEY) {
    const error = new Error('Stripe is not configured. Add STRIPE_SECRET_KEY to your environment variables.');
    error.statusCode = 500;
    throw error;
  }
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assessmentPath(draftId) {
  return path.join(assessmentsDir, `${draftId}.json`);
}

function readAssessment(draftId) {
  const file = assessmentPath(draftId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveAssessment(record) {
  fs.writeFileSync(assessmentPath(record.draftId), JSON.stringify(record, null, 2));
}

function riskLabel(score) {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Moderate';
  if (score >= 40) return 'Needs detailed review';
  return 'High risk / insufficient information';
}

function buildAssessmentSummary(form) {
  const answers = form.answers || {};
  let score = 0;
  if (answers.relationshipLengthMonths >= 12) score += 20;
  if (answers.marriedOrDeFacto === 'yes') score += 15;
  if (answers.livingTogether === 'yes') score += 15;
  if (answers.financialEvidence === 'yes') score += 10;
  if (answers.socialRecognition === 'yes') score += 10;
  if (answers.childrenTogether === 'yes') score += 10;
  if (answers.sponsorAustralianStatus === 'citizen' || answers.sponsorAustralianStatus === 'pr') score += 10;
  if (answers.noSeriousCharacterIssues === 'yes') score += 10;

  const observations = [];
  if (answers.relationshipLengthMonths < 12) observations.push('Relationship period appears shorter than 12 months, so exemption or stronger supporting evidence may be needed.');
  if (answers.livingTogether !== 'yes') observations.push('The couple does not currently appear to be living together full-time, so the separation context and contact history should be explained clearly.');
  if (answers.financialEvidence !== 'yes') observations.push('Financial interdependency evidence looks limited and should be strengthened.');
  if (answers.socialRecognition !== 'yes') observations.push('Social recognition evidence appears limited.');
  if (answers.noSeriousCharacterIssues !== 'yes') observations.push('Potential character issues were flagged and require lawyer review before lodgement strategy is finalised.');
  if (observations.length === 0) observations.push('The core relationship indicators appear reasonably aligned with a partner visa assessment, subject to document review and chronology testing.');

  return {
    score,
    rating: riskLabel(score),
    observations,
    recommendedNextSteps: [
      'Prepare a structured relationship timeline with dates, locations, visits and major milestones.',
      'Collect identity, civil, communication, financial and social evidence for both parties.',
      'Review sponsorship eligibility, prior sponsorship history and character disclosures carefully.',
      'Undertake a full legal review before lodgement because the final outcome depends on evidence quality and consistency.'
    ]
  };
}

function createPdf({ assessment, payment, outputPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const primary = '#0a4ea3';
    const dark = '#0f172a';
    const gray = '#475569';

    doc.fontSize(24).fillColor(primary).text('Bircan Migration', { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(15).fillColor(dark).text('Paid AI Assessment Summary', { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor(gray).text(`Website: ${WEBSITE_URL}`);
    doc.text(`Generated: ${new Date().toLocaleString('en-AU')}`);
    doc.text(`Payment status: ${payment.status}`);
    doc.text(`Reference: ${payment.sessionId}`);
    doc.moveDown();

    const form = assessment.form || {};
    const answers = form.answers || {};
    const summary = assessment.summary || buildAssessmentSummary(form);

    doc.fontSize(13).fillColor(primary).text('Client details');
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor(dark);
    doc.text(`Client name: ${cleanText(form.clientName)}`);
    doc.text(`Email: ${cleanText(form.email)}`);
    doc.text(`Phone: ${cleanText(form.phone)}`);
    doc.text(`Assessment type: ${cleanText(form.assessmentType, 'Partner visa assessment')}`);
    doc.text(`Visa subclass: ${cleanText(form.visaSubclass, 'Not specified')}`);
    doc.moveDown();

    doc.fontSize(13).fillColor(primary).text('AI assessment result');
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor(dark);
    doc.text(`Indicative score: ${summary.score}/100`);
    doc.text(`Assessment band: ${summary.rating}`);
    doc.moveDown(0.4);
    doc.text('Key observations:');
    summary.observations.forEach((item, idx) => doc.text(`${idx + 1}. ${item}`, { indent: 12 }));
    doc.moveDown();

    doc.fontSize(13).fillColor(primary).text('Client answers snapshot');
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor(dark);
    const rows = [
      ['Relationship duration (months)', cleanText(answers.relationshipLengthMonths)],
      ['Married / de facto', cleanText(answers.marriedOrDeFacto)],
      ['Living together', cleanText(answers.livingTogether)],
      ['Financial evidence available', cleanText(answers.financialEvidence)],
      ['Social recognition evidence', cleanText(answers.socialRecognition)],
      ['Children together', cleanText(answers.childrenTogether)],
      ['Sponsor status', cleanText(answers.sponsorAustralianStatus)],
      ['Character concerns flagged', answers.noSeriousCharacterIssues === 'yes' ? 'No' : 'Yes / review needed'],
      ['Additional notes', cleanText(answers.additionalNotes)]
    ];
    rows.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
      doc.font('Helvetica').text(value);
    });
    doc.moveDown();

    doc.fontSize(13).fillColor(primary).text('Recommended next steps');
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor(dark);
    summary.recommendedNextSteps.forEach((item, idx) => doc.text(`${idx + 1}. ${item}`, { indent: 12 }));
    doc.moveDown();

    doc.fontSize(9).fillColor(gray).text(
      'Important: This PDF is an automated preliminary assessment summary and is not legal advice. Final visa strategy, eligibility and lodgement suitability require a detailed professional review of evidence, immigration history and current legislative requirements.'
    );

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-backend',
    website: WEBSITE_URL,
    message: 'Backend is running',
    endpoints: {
      health: '/api/health',
      paymentCreate: '/api/payment/create-checkout-session',
      paymentVerify: '/api/payment/verify-session',
      paymentWebhook: '/api/stripe/webhook',
      assessmentPdf: '/api/assessment/pdf/:draftId'
    },
    stripeConfigured: Boolean(STRIPE_SECRET_KEY),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/payment/create-checkout-session', async (req, res, next) => {
  try {
    ensureStripeReady();

    const form = req.body || {};
    const clientName = cleanText(form.clientName, 'Client');
    const email = cleanText(form.email, '');
    const assessmentType = cleanText(form.assessmentType, 'AI Migration Assessment');
    const visaSubclass = cleanText(form.visaSubclass, 'General');

    const draftId = id('draft');
    const summary = buildAssessmentSummary(form);

    saveAssessment({
      draftId,
      status: 'pending_payment',
      createdAt: new Date().toISOString(),
      form,
      summary,
      payment: null,
      pdf: null
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${FRONTEND_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}&draft_id=${draftId}`,
      cancel_url: `${FRONTEND_CANCEL_URL}?draft_id=${draftId}`,
      customer_email: email || undefined,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: STRIPE_CURRENCY,
            product_data: {
              name: `${assessmentType} - ${visaSubclass}`,
              description: 'Bircan Migration paid AI assessment and PDF summary'
            },
            unit_amount: ASSESSMENT_PRICE_CENTS
          },
          quantity: 1
        }
      ],
      metadata: {
        draftId,
        clientName: clientName.slice(0, 100),
        email: email.slice(0, 100),
        assessmentType: assessmentType.slice(0, 100),
        visaSubclass: visaSubclass.slice(0, 100)
      }
    });

    const current = readAssessment(draftId);
    current.payment = {
      status: 'checkout_created',
      sessionId: session.id,
      url: session.url,
      amountTotal: ASSESSMENT_PRICE_CENTS,
      currency: STRIPE_CURRENCY
    };
    saveAssessment(current);

    res.json({
      ok: true,
      draftId,
      checkoutUrl: session.url,
      sessionId: session.id
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/payment/verify-session', async (req, res, next) => {
  try {
    ensureStripeReady();

    const sessionId = cleanText(req.query.session_id, '');
    const draftId = cleanText(req.query.draft_id, '');

    if (!sessionId || !draftId) {
      return res.status(400).json({ ok: false, error: 'session_id and draft_id are required.' });
    }

    const record = readAssessment(draftId);
    if (!record) {
      return res.status(404).json({ ok: false, error: 'Assessment draft not found.' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent']
    });

    const isPaid = session.payment_status === 'paid' || session.status === 'complete';
    if (!isPaid) {
      return res.status(402).json({
        ok: false,
        paid: false,
        status: session.status,
        payment_status: session.payment_status,
        error: 'Payment not completed yet.'
      });
    }

    let pdf = record.pdf;
    if (!pdf?.url || !fs.existsSync(path.join(pdfDir, pdf.filename || ''))) {
      const filename = `${draftId}.pdf`;
      const outputPath = path.join(pdfDir, filename);
      await createPdf({
        assessment: record,
        payment: {
          status: session.payment_status,
          sessionId: session.id
        },
        outputPath
      });
      pdf = {
        filename,
        url: `${WEBSITE_URL.replace(/\/$/, '')}/downloads/${filename}`,
        generatedAt: new Date().toISOString()
      };
    }

    record.status = 'paid';
    record.payment = {
      status: session.payment_status,
      sessionId: session.id,
      paymentIntentId: session.payment_intent?.id || null,
      amountTotal: session.amount_total,
      currency: session.currency,
      customerEmail: session.customer_details?.email || record.form?.email || null,
      paidAt: new Date().toISOString()
    };
    record.pdf = pdf;
    saveAssessment(record);

    res.json({
      ok: true,
      paid: true,
      draftId,
      sessionId: session.id,
      pdfUrl: pdf.url,
      assessment: {
        clientName: record.form?.clientName || null,
        assessmentType: record.form?.assessmentType || null,
        visaSubclass: record.form?.visaSubclass || null,
        summary: record.summary
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assessment/pdf/:draftId', (req, res) => {
  const draftId = cleanText(req.params.draftId, '');
  const record = readAssessment(draftId);
  if (!record?.pdf?.filename) {
    return res.status(404).json({ ok: false, error: 'PDF not found.' });
  }
  const pdfPath = path.join(pdfDir, record.pdf.filename);
  if (!fs.existsSync(pdfPath)) {
    return res.status(404).json({ ok: false, error: 'PDF file is missing on the server.' });
  }
  res.download(pdfPath, record.pdf.filename);
});

app.post('/api/stripe/webhook', (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Webhook secret is not configured.');
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const draftId = session.metadata?.draftId;
    if (draftId) {
      const record = readAssessment(draftId);
      if (record) {
        record.status = 'payment_received';
        record.payment = {
          ...(record.payment || {}),
          status: session.payment_status,
          sessionId: session.id,
          amountTotal: session.amount_total,
          currency: session.currency,
          customerEmail: session.customer_details?.email || record.form?.email || null,
          webhookReceivedAt: new Date().toISOString()
        };
        saveAssessment(record);
      }
    }
  }

  res.json({ received: true });
});

app.use((error, _req, res, _next) => {
  console.error('[error]', error);
  const status = error.statusCode || 500;
  const message = error?.raw?.message || error.message || 'Internal server error';
  res.status(status).json({
    ok: false,
    error: message,
    type: error.type || 'server_error'
  });
});

app.listen(PORT, () => {
  console.log(`[startup] Bircan backend listening on port ${PORT}`);
});
