require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const PDFDocument = require('pdfkit');

const app = express();

const PORT = Number(process.env.PORT || 10000);
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_FROM || '';
const STORAGE_DIR = path.join(__dirname, 'data');
const PDF_DIR = path.join(STORAGE_DIR, 'pdfs');
const DB_FILE = path.join(STORAGE_DIR, 'assessments.json');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  'http://localhost:3000,http://127.0.0.1:3000,null'
)
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function fail(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

async function ensureStorage() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.mkdir(PDF_DIR, { recursive: true });
  try {
    await fsp.access(DB_FILE);
  } catch {
    await fsp.writeFile(DB_FILE, JSON.stringify({ assessments: [] }, null, 2), 'utf8');
  }
}

async function readDb() {
  await ensureStorage();
  const raw = await fsp.readFile(DB_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { assessments: [] };
  }
}

async function writeDb(db) {
  await ensureStorage();
  await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function randomId(prefix = 'asm') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function toCurrencyAud(value) {
  const n = Number(value || 0);
  return `AUD $${n.toFixed(2)}`;
}

function getPlanCatalog() {
  return {
    instant: { key: 'instant', label: 'Instant', turnaround: 'Instant', price: 300 },
    '24hours': { key: '24hours', label: '24 Hours', turnaround: '24 Hours', price: 250 },
    '3days': { key: '3days', label: '3 Days', turnaround: '3 Days', price: 150 }
  };
}

function normalizePlan(input) {
  const catalog = getPlanCatalog();
  if (!input) return null;

  if (typeof input === 'string' && catalog[input]) {
    return catalog[input];
  }

  const key = sanitizeText(input.key || input.value || '').toLowerCase();
  if (catalog[key]) return catalog[key];

  const label = sanitizeText(input.label);
  const turnaround = sanitizeText(input.turnaround || label);
  const price = Number(input.price);

  if (!label || Number.isNaN(price) || price <= 0) return null;

  return {
    key: key || label.toLowerCase().replace(/\s+/g, '-'),
    label,
    turnaround,
    price
  };
}

function getOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (origin === 'null' && allowedOrigins.includes('null')) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (getOriginAllowed(origin)) {
    if (origin) res.header('Access-Control-Allow-Origin', origin);
    else res.header('Access-Control-Allow-Origin', '*');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Stripe webhook must receive the raw body before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ ok: false, error: 'Stripe is not configured' });
  }

  if (!STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ ok: false, error: 'Missing STRIPE_WEBHOOK_SECRET' });
  }

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    log('Webhook signature verification failed:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const assessmentId = session.metadata?.assessmentId;
      if (assessmentId) {
        await markAssessmentPaid({
          assessmentId,
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent || '',
          paymentStatus: session.payment_status || 'paid',
          paidAt: nowIso(),
          paymentMethod: 'stripe_webhook'
        });

        const record = await getAssessmentById(assessmentId);
        if (record) {
          await generateAndSendAdviceLetter(record, {
            trigger: 'webhook',
            stripeSessionId: session.id
          });
        }
      }
    }

    return res.json({ received: true });
  } catch (error) {
    log('Webhook processing failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Webhook processing failed' });
  }
});

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

async function createTransporter() {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

function getClientEmail(answers = {}) {
  return sanitizeText(
    answers.email ||
    answers.clientEmail ||
    answers.applicantEmail ||
    ''
  );
}

function getClientName(answers = {}) {
  return sanitizeText(
    answers.fullName ||
    answers.clientName ||
    answers.applicantName ||
    `${sanitizeText(answers.firstName)} ${sanitizeText(answers.lastName)}`.trim()
  );
}

function flattenAnswersForPdf(answers = {}) {
  const pairs = [];
  for (const [key, value] of Object.entries(answers)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') {
      pairs.push([key, JSON.stringify(value)]);
    } else {
      pairs.push([key, String(value)]);
    }
  }
  return pairs;
}

async function saveAssessment(record) {
  const db = await readDb();
  db.assessments.push(record);
  await writeDb(db);
  return record;
}

async function getAssessmentById(id) {
  const db = await readDb();
  return db.assessments.find(item => item.id === id) || null;
}

async function updateAssessment(id, updater) {
  const db = await readDb();
  const index = db.assessments.findIndex(item => item.id === id);
  if (index === -1) return null;
  const current = db.assessments[index];
  const updated = typeof updater === 'function'
    ? updater(current)
    : { ...current, ...updater };
  db.assessments[index] = updated;
  await writeDb(db);
  return updated;
}

async function markAssessmentPaid({
  assessmentId,
  stripeSessionId = '',
  stripePaymentIntentId = '',
  paymentStatus = 'paid',
  paidAt = nowIso(),
  paymentMethod = 'stripe'
}) {
  return updateAssessment(assessmentId, current => ({
    ...current,
    status: 'paid',
    payment: {
      ...(current.payment || {}),
      status: paymentStatus,
      paidAt,
      paymentMethod,
      stripeSessionId: stripeSessionId || current.payment?.stripeSessionId || '',
      stripePaymentIntentId: stripePaymentIntentId || current.payment?.stripePaymentIntentId || ''
    },
    updatedAt: nowIso()
  }));
}

async function createAssessmentFromPayload(payload = {}) {
  const selectedPlan = normalizePlan(payload.selectedPlan || payload.plan);
  if (!selectedPlan) {
    throw fail('A valid payment plan is required', 400);
  }

  const answers = payload.answers || {};
  const email = getClientEmail(answers);
  const fullName = getClientName(answers);

  if (!email) {
    throw fail('Client email is required in the assessment answers', 400);
  }

  const assessment = {
    id: randomId('assessment'),
    assessmentType: sanitizeText(payload.assessmentType || 'subclass_482'),
    service: {
      title: 'Subclass 482 Visa Assessment',
      plan: selectedPlan
    },
    applicant: {
      name: fullName,
      email,
      phone: sanitizeText(answers.phone || answers.mobile || '')
    },
    answers,
    status: 'pending_payment',
    payment: {
      status: 'unpaid',
      paidAt: '',
      paymentMethod: '',
      stripeSessionId: '',
      stripePaymentIntentId: ''
    },
    generated: {
      pdfPath: '',
      pdfFilename: '',
      emailedAt: '',
      emailMessageId: ''
    },
    successUrl: sanitizeText(payload.successUrl || ''),
    cancelUrl: sanitizeText(payload.cancelUrl || ''),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  return saveAssessment(assessment);
}

function getAdviceSummary(record) {
  const a = record.answers || {};
  const points = [];

  if (a.hasSponsor === 'yes') points.push('Client indicates there is an employer sponsor or sponsoring business in place.');
  else if (a.hasSponsor) points.push('Sponsor position needs to be clarified before a full pathway opinion is finalised.');

  if (a.hasNomination === 'yes') points.push('Nomination appears to be available or in progress.');
  else if (a.hasNomination) points.push('Nomination status needs review before visa readiness can be confirmed.');

  if (a.workExperienceYears) points.push(`Claimed work experience: ${a.workExperienceYears}.`);
  if (a.englishTest) points.push(`English position noted: ${a.englishTest}.`);
  if (a.skillsAssessment) points.push(`Skills assessment position: ${a.skillsAssessment}.`);
  if (a.locationStatus) points.push(`Current location/visa context: ${a.locationStatus}.`);

  if (!points.length) {
    points.push('Further factual review is required based on the client’s answers and supporting documents.');
  }

  return points;
}

async function generateAssessmentPdf(record) {
  await ensureStorage();

  const filename = `${record.id}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filepath);

    doc.pipe(stream);

    doc.fontSize(20).text('Bircan Migration', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(16).text('Subclass 482 Visa Assessment Letter of Advice', { align: 'left' });
    doc.moveDown(1);

    doc.fontSize(10).fillColor('#444444').text(`Assessment ID: ${record.id}`);
    doc.text(`Issued: ${new Date().toLocaleString()}`);
    doc.text(`Client: ${record.applicant.name || 'Not provided'}`);
    doc.text(`Email: ${record.applicant.email || 'Not provided'}`);
    doc.text(`Selected Plan: ${record.service.plan.label} - ${toCurrencyAud(record.service.plan.price)}`);
    doc.moveDown();

    doc.fillColor('#000000').fontSize(12).text('Service Summary', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11).text(
      'This assessment letter has been prepared from the information submitted through the online Subclass 482 assessment form. '
      + 'It is an initial advice document for case screening, strategy review, and next-step planning.'
    );
    doc.moveDown();

    doc.fontSize(12).text('Preliminary Advice Snapshot', { underline: true });
    doc.moveDown(0.4);
    for (const item of getAdviceSummary(record)) {
      doc.fontSize(11).text(`• ${item}`);
      doc.moveDown(0.2);
    }

    doc.moveDown();
    doc.fontSize(12).text('Client Answers', { underline: true });
    doc.moveDown(0.4);

    for (const [key, value] of flattenAnswersForPdf(record.answers)) {
      doc.fontSize(10).fillColor('#111111').text(`${key}: `, { continued: true });
      doc.fillColor('#444444').text(value);
    }

    doc.moveDown();
    doc.fillColor('#000000').fontSize(12).text('Next Steps', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11).text('1. Review sponsor, nomination, occupation, and stream position.');
    doc.text('2. Confirm skills, qualifications, work experience, and English evidence.');
    doc.text('3. Review family members, health insurance, and compliance history if relevant.');
    doc.text('4. Prepare tailored migration strategy and document checklist.');
    doc.moveDown();

    doc.fontSize(10).fillColor('#444444').text(
      'This letter is general preliminary guidance only and is based solely on the information submitted by the client. '
      + 'Final migration advice may change after document review and legal assessment.'
    );

    doc.end();

    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  const updated = await updateAssessment(record.id, current => ({
    ...current,
    generated: {
      ...(current.generated || {}),
      pdfPath: filepath,
      pdfFilename: filename
    },
    updatedAt: nowIso()
  }));

  return updated;
}

async function sendAdviceEmail(record) {
  const transporter = await createTransporter();
  if (!transporter) {
    throw fail('SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.', 500);
  }

  if (!record.generated?.pdfPath) {
    throw fail('PDF has not been generated yet', 500);
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const to = record.applicant.email;
  if (!to) {
    throw fail('Client email is missing', 400);
  }

  const subject = `Subclass 482 Assessment Letter - ${record.applicant.name || 'Client'}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#1a1a1a;">
      <p>Dear ${record.applicant.name || 'Client'},</p>
      <p>Thank you for completing your Subclass 482 visa assessment.</p>
      <p>Please find attached your PDF letter of advice based on the information submitted through the assessment form.</p>
      <p>If you would like to proceed with the next step of your case, please reply to this email.</p>
      <p>Kind regards,<br>Bircan Migration</p>
    </div>
  `;

  const info = await transporter.sendMail({
    from,
    to,
    cc: ADMIN_EMAIL || undefined,
    subject,
    html,
    attachments: [
      {
        filename: record.generated.pdfFilename || `${record.id}.pdf`,
        path: record.generated.pdfPath
      }
    ]
  });

  const updated = await updateAssessment(record.id, current => ({
    ...current,
    generated: {
      ...(current.generated || {}),
      emailedAt: nowIso(),
      emailMessageId: info.messageId || ''
    },
    updatedAt: nowIso()
  }));

  return { updated, info };
}

async function generateAndSendAdviceLetter(record, meta = {}) {
  let working = record;
  if (!working.generated?.pdfPath) {
    working = await generateAssessmentPdf(working);
  }

  const result = await sendAdviceEmail(working);
  log('Advice email sent', {
    assessmentId: working.id,
    trigger: meta.trigger || 'manual',
    messageId: result.info.messageId || ''
  });

  return result.updated;
}

app.get('/api/health', async (req, res) => {
  await ensureStorage();
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
    hasStripeKey: !!STRIPE_SECRET_KEY,
    hasPublishableKey: !!STRIPE_PUBLISHABLE_KEY,
    hasStripeWebhookSecret: !!STRIPE_WEBHOOK_SECRET,
    hasSmtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    appBaseUrl: APP_BASE_URL,
    storageDir: STORAGE_DIR
  });
});

app.post('/api/assessment/submit', async (req, res, next) => {
  try {
    const assessment = await createAssessmentFromPayload(req.body || {});
    res.json({
      ok: true,
      assessmentId: assessment.id,
      status: assessment.status
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/payments/create-checkout-session', async (req, res, next) => {
  try {
    if (!stripe) {
      throw fail('Stripe is not configured on the backend', 500);
    }

    const payload = req.body || {};
    const selectedPlan = normalizePlan(payload.selectedPlan || payload.plan);
    if (!selectedPlan) {
      throw fail('A valid payment plan is required', 400);
    }

    const answers = payload.answers || {};
    const clientEmail = getClientEmail(answers);
    if (!clientEmail) {
      throw fail('Client email is required before payment', 400);
    }

    let assessment;
    if (payload.assessmentId) {
      assessment = await getAssessmentById(payload.assessmentId);
      if (!assessment) throw fail('Assessment record not found', 404);
    } else {
      assessment = await createAssessmentFromPayload({
        assessmentType: payload.assessmentType || 'subclass_482',
        selectedPlan,
        answers,
        successUrl: payload.successUrl,
        cancelUrl: payload.cancelUrl
      });
    }

    const successUrl = sanitizeText(payload.successUrl) || `${APP_BASE_URL}?payment=success&assessmentId=${assessment.id}`;
    const cancelUrl = sanitizeText(payload.cancelUrl) || `${APP_BASE_URL}?payment=cancelled&assessmentId=${assessment.id}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: clientEmail || undefined,
      payment_method_types: ['card'],
      metadata: {
        assessmentId: assessment.id,
        assessmentType: assessment.assessmentType,
        planKey: selectedPlan.key,
        planLabel: selectedPlan.label,
        turnaround: selectedPlan.turnaround,
        clientEmail,
        clientName: getClientName(answers)
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'aud',
            unit_amount: Math.round(Number(selectedPlan.price) * 100),
            product_data: {
              name: `Subclass 482 Visa Assessment - ${selectedPlan.label}`,
              description: `Turnaround: ${selectedPlan.turnaround}`
            }
          }
        }
      ]
    });

    await updateAssessment(assessment.id, current => ({
      ...current,
      status: 'checkout_created',
      payment: {
        ...(current.payment || {}),
        stripeSessionId: session.id,
        status: 'checkout_created'
      },
      updatedAt: nowIso()
    }));

    res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      assessmentId: assessment.id
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/assessments/payment-success', async (req, res, next) => {
  try {
    const payload = req.body || {};
    let assessmentId = sanitizeText(payload.assessmentId);

    if (!assessmentId) {
      const clientEmail = getClientEmail(payload.answers || {});
      const db = await readDb();
      const latest = [...db.assessments]
        .reverse()
        .find(item => item.applicant.email === clientEmail && item.assessmentType === 'subclass_482');
      if (latest) assessmentId = latest.id;
    }

    if (!assessmentId) {
      throw fail('Assessment ID could not be resolved for payment success', 400);
    }

    let assessment = await markAssessmentPaid({
      assessmentId,
      stripeSessionId: sanitizeText(payload.stripeSessionId),
      stripePaymentIntentId: sanitizeText(payload.stripePaymentIntentId),
      paymentStatus: 'paid',
      paidAt: nowIso(),
      paymentMethod: 'frontend_callback'
    });

    if (!assessment) {
      throw fail('Assessment record not found', 404);
    }

    assessment = await generateAndSendAdviceLetter(assessment, { trigger: 'payment_success_route' });

    res.json({
      ok: true,
      assessmentId: assessment.id,
      status: assessment.status,
      pdfGenerated: !!assessment.generated?.pdfPath,
      emailedAt: assessment.generated?.emailedAt || ''
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/assessments/generate-letter', async (req, res, next) => {
  try {
    const assessmentId = sanitizeText(req.body?.assessmentId);
    if (!assessmentId) throw fail('assessmentId is required', 400);

    let assessment = await getAssessmentById(assessmentId);
    if (!assessment) throw fail('Assessment record not found', 404);

    assessment = await generateAssessmentPdf(assessment);

    res.json({
      ok: true,
      assessmentId: assessment.id,
      pdfFilename: assessment.generated?.pdfFilename || '',
      pdfPath: assessment.generated?.pdfPath || ''
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/assessments/email-letter', async (req, res, next) => {
  try {
    const assessmentId = sanitizeText(req.body?.assessmentId);
    if (!assessmentId) throw fail('assessmentId is required', 400);

    let assessment = await getAssessmentById(assessmentId);
    if (!assessment) throw fail('Assessment record not found', 404);

    if (!assessment.generated?.pdfPath) {
      assessment = await generateAssessmentPdf(assessment);
    }

    const result = await sendAdviceEmail(assessment);

    res.json({
      ok: true,
      assessmentId: result.updated.id,
      emailedAt: result.updated.generated?.emailedAt || '',
      messageId: result.info.messageId || ''
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assessments/:id', async (req, res, next) => {
  try {
    const assessment = await getAssessmentById(req.params.id);
    if (!assessment) throw fail('Assessment record not found', 404);

    res.json({
      ok: true,
      assessment
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assessments/:id/pdf', async (req, res, next) => {
  try {
    const assessment = await getAssessmentById(req.params.id);
    if (!assessment) throw fail('Assessment record not found', 404);
    if (!assessment.generated?.pdfPath) throw fail('PDF not generated yet', 404);

    res.download(
      assessment.generated.pdfPath,
      assessment.generated.pdfFilename || `${assessment.id}.pdf`
    );
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  const status = Number(err.status || 500);
  log('Error:', status, err.message);
  res.status(status).json({
    ok: false,
    error: err.message || 'Internal server error'
  });
});

ensureStorage()
  .then(() => {
    app.listen(PORT, () => {
      log(`Server listening on port ${PORT}`);
      log(`Health: ${APP_BASE_URL}/api/health`);
    });
  })
  .catch(error => {
    console.error('Failed to initialise storage:', error);
    process.exit(1);
  });
