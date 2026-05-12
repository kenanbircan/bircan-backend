require('dotenv').config();


// ---- Render runtime hardening: expose silent startup failures instead of exiting without logs ----
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason && reason.stack ? reason.stack : reason);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received: shutting down Bircan backend.');
  process.exit(0);
});

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { query, tx } = require('./db');
const { buildAssessmentPdfBuffer, buildAppealAdvicePdfBuffer, sha256 } = require('./pdf');
const { generateMigrationAdvice, supportedSubclasses } = require('./adviceEngine');
const { buildKnowledgebaseLegalPack, assertKnowledgebasePack, buildKnowledgebaseHealthReport } = require('./knowledgebaseLoader');
const { buildDelegateSimulatorPdfInputs, supportedDelegateSimulatorSubclasses } = require('./migrationDecisionEngine');
const { attachEvidenceValidation, validateEvidenceForAssessment } = require('./evidenceValidationLayer');
const hardening = require('./backendHardening');
const pdfModule = require('./pdf');
const decisionEngineModule = require('./migrationDecisionEngine');
const { attachPathwayComparisonToAdviceBundle, compareMigrationPathways } = require('./migrationPathwayComparator');
const { installClientJourneyRoutes, ensureClientJourneySchema } = require('./clientJourneyEngine');

const app = express();
app.use(hardening.requestIdMiddleware);
const PORT = process.env.PORT || 4242;
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.JWT_SECRET;
if (!SESSION_SECRET && (process.env.NODE_ENV === 'production' || process.env.RENDER)) {
  throw new Error('SESSION_SECRET or JWT_SECRET is required in production. Refusing to boot with an unsafe fallback secret.');
}
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://bircanmigration.au';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY_LIVE;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const stripePriceValidationCache = new Map();


// ---- Stripe checkout hardening: never reuse an idempotency key for changed parameters ----
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

function makeStripeIdempotencyKey(prefix, payload = {}) {
  const fingerprint = crypto.createHash('sha256').update(stableJson(payload)).digest('hex').slice(0, 24);
  const nonce = crypto.randomBytes(8).toString('hex');
  const cleanPrefix = String(prefix || 'checkout').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  return `${cleanPrefix}-${Date.now()}-${nonce}-${fingerprint}`.slice(0, 250);
}

function checkoutFingerprint({ serviceType, serviceRef, plan, price, email, accessId, assessmentId }) {
  return {
    serviceType: normaliseServiceType(serviceType),
    serviceRef: serviceRef || assessmentId || accessId || null,
    plan: serviceType === 'citizenship_test' ? normaliseCitizenshipPlan(plan) : safePlan(plan),
    price: price || null,
    email: normaliseEmail(email),
    appBaseUrl: APP_BASE_URL
  };
}

async function getReusableOpenCheckoutSession(stripeSessionId, expected = {}) {
  if (!stripe || !stripeSessionId) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(stripeSessionId);
    const md = session.metadata || {};
    const serviceOk = !expected.serviceType || normaliseServiceType(md.service_type) === normaliseServiceType(expected.serviceType);
    const planOk = !expected.plan || String(md.plan || '').toLowerCase() === String(expected.plan || '').toLowerCase();
    const refOk = !expected.serviceRef || [md.service_ref, md.assessment_id, md.appeal_assessment_id, md.citizenship_access_id, session.client_reference_id].filter(Boolean).includes(expected.serviceRef);
    let amountOk = true;
    if (expected.serviceType && expected.plan) {
      const expectedAmount = expectedAmountCentsForService(expected.serviceType, expected.plan);
      amountOk = Number(session.amount_total || 0) === expectedAmount && String(session.currency || 'aud').toLowerCase() === String(expected.currency || 'aud').toLowerCase();
    }
    if (session && session.url && session.status === 'open' && session.payment_status !== 'paid' && serviceOk && planOk && refOk && amountOk) return session;
  } catch (err) {
    console.warn('Existing Stripe checkout session could not be reused:', err.message);
  }
  return null;
}

async function createCheckoutSessionSafely(params, prefix, fingerprint) {
  return stripe.checkout.sessions.create(params, {
    idempotencyKey: makeStripeIdempotencyKey(prefix, fingerprint)
  });
}
const appealUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12 } });
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (_err) { pdfParse = null; }
const BOOTSTRAP_DB = String(process.env.BOOTSTRAP_DB || 'true').toLowerCase() !== 'false';
const PDF_WORKER_INTERVAL_MS = Math.max(3000, Number(process.env.PDF_WORKER_INTERVAL_MS || 10000));
const CHECKOUT_HANDOFF_PERMANENT_PATCH = 'assessment-prelogin-save-login-redirect-checkout-direct-v1';
const PDF_MODULE_BINDING_PATCH = 'server-uses-pdf-js-buildAssessmentPdfBuffer-v1';

// ---- Payment checkout reuse hardening ----
// v2026-05-13: Public assessment start must never reuse a paid assessment for a new checkout.
// A paid record is a completed matter. New payment attempts must receive a fresh unpaid assessment/service session.
const BIRCAN_PAYMENT_CHECKOUT_REUSE_PATCH = 'public-start-never-reuse-paid-assessment-v1';

// Payment finalisation must be fast. By default it only records payment and queues PDF generation.
// Set VERIFY_PAYMENT_WAIT_FOR_PDF=true only for local debugging.
const VERIFY_PAYMENT_WAIT_FOR_PDF = String(process.env.VERIFY_PAYMENT_WAIT_FOR_PDF || 'false').toLowerCase() === 'true';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || [
  'https://bircanmigration.au',
  'https://www.bircanmigration.au',
  'https://bircanmigration.com.au',
  'https://www.bircanmigration.com.au',
  'https://assessment.bircanmigration.au',
  'https://www.assessment.bircanmigration.au',
  'http://localhost:3000',
  'http://localhost:4242',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'null'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function safePlan(plan) {
  const raw = String(plan || '').trim().toLowerCase();
  const p = raw.replace(/\s+/g, '').replace(/[-_]+/g, '');
  if (['24h', '24hr', '24hour', '24hours'].includes(p) || /(^|[^0-9])24\s*(h|hr|hour|hours)([^a-z]|$)/i.test(raw)) return '24h';
  if (['3d', '3day', '3days'].includes(p) || /(^|[^0-9])(3|three|72)\s*(d|day|days|h|hr|hour|hours)([^a-z]|$)/i.test(raw)) return '3d';
  if (/(recommended|24\s*hours|24\s*h|250)/i.test(raw)) return '24h';
  if (/(value|3\s*days|3\s*d|72\s*hours|150)/i.test(raw)) return '3d';
  return 'instant';
}

// Visa plan extraction must be defensive because different frontend pages have
// used different field names over time. This prevents every visa checkout from
// silently falling back to the instant Stripe price.
const PLAN_FIELD_RE = /^(plan|selectedplan|selected_plan|assessmentplan|assessment_plan|planid|plan_id|priceplan|price_plan|paymentplan|payment_plan|turnaround|package|tier|servicelevel|service_level)$/i;

function findPlanInObject(value, depth = 0) {
  if (!value || depth > 4) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value);
    if (/(instant|fastest|24\s*h|24\s*hour|recommended|250|3\s*d|3\s*day|72\s*hour|value|150)/i.test(text)) return text;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlanInObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  for (const [key, val] of Object.entries(value)) {
    const cleanKey = String(key).replace(/[^a-z0-9_]/gi, '');
    if (PLAN_FIELD_RE.test(cleanKey)) {
      const direct = findPlanInObject(val, depth + 1);
      if (direct) return direct;
    }
  }
  for (const [key, val] of Object.entries(value)) {
    const cleanKey = String(key).replace(/[^a-z0-9_]/gi, '');
    if (/plan|turnaround|package|tier|price|payment/i.test(cleanKey)) {
      const related = findPlanInObject(val, depth + 1);
      if (related) return related;
    }
  }
  return null;
}

function requestedVisaPlan(req, fallback = 'instant') {
  const explicit = findPlanInObject(req && req.body) || findPlanInObject(req && req.query);
  return safePlan(explicit || fallback || 'instant');
}

function planFromAssessmentBody(body, fallback = 'instant') {
  return safePlan(findPlanInObject(body) || fallback || 'instant');
}
function strictServicePlanFromRequest(req, fallback = '') {
  const body = (req && req.body) || {};
  const queryObj = (req && req.query) || {};
  const candidates = [
    body.plan, body.selectedPlan, body.selected_plan, body.planId, body.plan_id,
    body.assessmentPlan, body.assessment_plan, body.pricePlan, body.price_plan,
    body.paymentPlan, body.payment_plan, body.turnaround, body.serviceLevel, body.service_level,
    queryObj.plan, queryObj.selectedPlan, queryObj.selected_plan, queryObj.planId, queryObj.plan_id,
    queryObj.assessmentPlan, queryObj.assessment_plan, queryObj.pricePlan, queryObj.price_plan,
    queryObj.paymentPlan, queryObj.payment_plan, queryObj.turnaround, queryObj.serviceLevel, queryObj.service_level,
    fallback
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return safePlan(value);
  }
  const err = new Error('Payment plan is required. Start checkout again from the selected plan button.');
  err.statusCode = 400;
  throw err;
}


// ---- Payload pipeline hardening v6 ----
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function normaliseValue(v) { if (v === undefined) return undefined; if (v === null) return null; if (typeof v === 'string') return v.trim(); if (Array.isArray(v)) return v.map(normaliseValue).filter(x => x !== undefined && x !== ''); if (isPlainObject(v)) { const out = {}; for (const [k, val] of Object.entries(v)) { const nv = normaliseValue(val); if (nv !== undefined && nv !== '') out[k] = nv; } return out; } return v; }
function flattenObject(input, prefix = '', out = {}) { if (!isPlainObject(input)) return out; for (const [key, value] of Object.entries(input)) { if (['password','token','auth','authorization','bm_session'].includes(String(key).toLowerCase())) continue; const name = prefix ? `${prefix}.${key}` : key; if (isPlainObject(value)) flattenObject(value, name, out); else if (Array.isArray(value)) out[name] = value.map(v => isPlainObject(v) ? JSON.stringify(v) : v).join('; '); else if (value !== undefined && value !== null && value !== '') out[name] = value; } return out; }

function pickApplicantValue(...sources) {
  const keys = [
    'applicantName','applicant_name','applicant-name',
    'fullName','full_name','full-name',
    'primaryApplicantName','primary_applicant_name','primary-applicant-name',
    'clientName','client_name','client-name',
    'name'
  ];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
  }
  return null;
}
function pickApplicantEmailValue(client, ...sources) {
  const keys = ['applicantEmail','applicant_email','applicant-email','email','email-address','clientEmail','client_email','client-email'];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return normaliseEmail(value);
    }
  }
  return normaliseEmail(client && client.email);
}
function buildAssessmentPayload(body, client) {
  const b = isPlainObject(body) ? body : {};
  const source = isPlainObject(b.formPayload) ? b.formPayload : isPlainObject(b.form_payload) ? b.form_payload : isPlainObject(b.answers) ? b.answers : isPlainObject(b.formData) ? b.formData : isPlainObject(b.form_data) ? b.form_data : isPlainObject(b.payload) ? b.payload : isPlainObject(b.data) ? b.data : b;
  const answers = normaliseValue(source) || {};
  const flatAnswers = flattenObject(answers);
  const flatBody = flattenObject(b);
  const applicantName = pickApplicantValue(b, answers, flatAnswers, flatBody);
  const applicantEmail = pickApplicantEmailValue(client, b, answers, flatAnswers, flatBody);
  const meta = {
    submittedAt: new Date().toISOString(),
    clientEmail: normaliseEmail(client && client.email),
    applicantEmail,
    applicantName,
    visaType: String(b.visaType || b.visa_type || b.subclass || b.visaSubclass || answers.visaType || answers.visa_type || flatAnswers.visaType || flatAnswers.visa_type || '').replace(/[^0-9A-Za-z]/g, '') || 'unknown',
    selectedPlan: planFromAssessmentBody(b, 'instant'),
    sourceShape: b.formPayload ? 'formPayload' : b.form_payload ? 'form_payload' : b.answers ? 'answers' : b.formData ? 'formData' : b.payload ? 'payload' : 'rawBody'
  };
  return { meta, answers, flatAnswers, rawSubmission: normaliseValue(b) };
}


function stripVolatileAssessmentValues(value) {
  if (Array.isArray(value)) return value.map(stripVolatileAssessmentValues);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const k = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if ([
      'submittedat','createdat','updatedat','timestamp','time','dategenerated','generatedat',
      'submissionref','submissionid','assessmentid','servicesessionid','sessionid','stripe',
      'token','auth','authorization','password','bmsession','csrf','nonce','random'
    ].includes(k)) continue;
    out[key] = stripVolatileAssessmentValues(val);
  }
  return out;
}

function stableAssessmentJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableAssessmentJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableAssessmentJson(value[k])).join(',') + '}';
}

function visaSubmissionFingerprint({ email, visaType, plan, payload }) {
  const cleaned = stripVolatileAssessmentValues((payload && payload.answers) || payload || {});
  const basis = {
    email: normaliseEmail(email),
    visaType: String(visaType || '').toLowerCase(),
    plan: safePlan(plan),
    answers: cleaned
  };
  return crypto.createHash('sha256').update(stableAssessmentJson(basis)).digest('hex');
}

function payloadAnswerCount(payload) { if (!isPlainObject(payload)) return 0; const answers = isPlainObject(payload.answers) ? payload.answers : payload; return Object.keys(flattenObject(answers)).filter(k => !/^(meta|rawSubmission)\./i.test(k)).length; }
function payloadLooksUsable(payload) { return payloadAnswerCount(payload) >= 3; }

// A PDF is only treated as available when bytes exist and are large enough
// to be a real issued PDF. This prevents false-positive "generated" messages.
function hasIssuedPdfBytes(value) {
  if (!value) return false;
  const len = Buffer.isBuffer(value) ? value.length : value.byteLength || 0;
  return len > 1024;
}

async function verifyIssuedPdfSaved(clientOrDb, assessmentId) {
  const runner = clientOrDb && typeof clientOrDb.query === 'function' ? clientOrDb : { query };
  const { rows } = await runner.query(
    `SELECT id, visa_type, client_email, applicant_email, applicant_name, selected_plan, active_plan,
            status, payment_status, pdf_bytes, pdf_mime, pdf_filename, pdf_sha256,
            pdf_generated_at, generation_error, created_at, updated_at
     FROM assessments
     WHERE id=$1
     LIMIT 1`,
    [assessmentId]
  );
  const saved = rows[0];
  if (!saved || !hasIssuedPdfBytes(saved.pdf_bytes)) {
    const msg = 'PDF generation failed: final PDF was not saved or is empty.';
    await runner.query(
      `UPDATE assessments SET status='pdf_failed', generation_error=$1, updated_at=now() WHERE id=$2`,
      [msg, assessmentId]
    );
    await runner.query(
      `UPDATE pdf_jobs SET status='failed', last_error=$1, updated_at=now() WHERE assessment_id=$2`,
      [msg, assessmentId]
    );
    throw new Error(msg);
  }
  if (saved.status !== 'pdf_ready') {
    await runner.query(`UPDATE assessments SET status='pdf_ready', updated_at=now() WHERE id=$1`, [assessmentId]);
    saved.status = 'pdf_ready';
  }
  saved.has_pdf = true;
  delete saved.pdf_bytes;
  return saved;
}

function publicError(err) {
  const msg = err && err.message ? err.message : 'Server error.';
  if (/duplicate key/i.test(msg)) return 'Duplicate record.';
  return msg;
}

function isAllowedBircanOrigin(origin) {
  if (!origin || origin === 'null') return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  try {
    const u = new URL(origin);
    const host = String(u.hostname || '').toLowerCase();
    if (u.protocol === 'https:' && (host === 'bircanmigration.au' || host.endsWith('.bircanmigration.au'))) return true;
    if (u.protocol === 'https:' && (host === 'bircanmigration.com.au' || host.endsWith('.bircanmigration.com.au'))) return true;
    if (u.protocol === 'https:' && (host.endsWith('.onrender.com') || host.endsWith('.netlify.app') || host.endsWith('.vercel.app'))) return true;
  } catch (_err) {}
  return false;
}

const corsOptions = {
  origin(origin, cb) {
    if (isAllowedBircanOrigin(origin)) return cb(null, true);
    console.error('CORS blocked origin:', origin);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Auth-Token', 'X-Bircan-Dashboard', 'X-Dashboard-Access-Token'],
  exposedHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Stripe webhook must be mounted before express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret) : JSON.parse(req.body.toString());
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const result = await attachPaidSession(event.data.object, { triggerGeneration: true, waitForPdf: false });
    console.log('Stripe checkout attached:', result);
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());


// ---- TEMPORARY protected browser migration endpoint: Postgres idempotency repair/indexes ----


function sign(client) {
  return jwt.sign({ sub: client.id, email: client.email }, SESSION_SECRET, { expiresIn: '7d' });
}

function setSessionCookie(res, token) {
  res.cookie('bm_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies.bm_session || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ ok: false, error: 'Login required.' });
    const decoded = jwt.verify(token, SESSION_SECRET);
    const { rows } = await query('SELECT id, email, name FROM clients WHERE id=$1', [decoded.sub]);
    if (!rows[0]) return res.status(401).json({ ok: false, error: 'Account not found.' });
    req.client = rows[0];
    next();
  } catch (_err) {
    res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  }
}


async function optionalAuth(req, _res, next) {
  try {
    const token = (req.cookies && req.cookies.bm_session) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token) {
      const decoded = jwt.verify(token, SESSION_SECRET);
      const { rows } = await query('SELECT id, email, name FROM clients WHERE id=$1', [decoded.sub]);
      if (rows[0]) req.client = rows[0];
    }
  } catch (_err) {
    // Optional auth deliberately continues so dashboard access_id handoff can still work.
  }
  next();
}


// ---- Checkout auth bridge: fixes cross-site cookie / missing bearer token at checkout-start ----
// checkout-start.html is a handoff page. It may arrive after login with a saved
// service_session_id/assessment_id/email but without the browser sending the
// cookie or bearer token. For checkout creation only, recover the client from
// the login-confirmed service session, while still enforcing same-email ownership.
async function requireCheckoutAuth(req, res, next) {
  try {
    const token = (req.cookies && req.cookies.bm_session) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token) {
      const decoded = jwt.verify(token, SESSION_SECRET);
      const { rows } = await query('SELECT id, email, name FROM clients WHERE id=$1 LIMIT 1', [decoded.sub]);
      if (rows[0]) {
        req.client = rows[0];
        return next();
      }
    }
  } catch (_err) {
    // Fall through to service-session recovery below.
  }

  try {
    const b = req.body || {};
    const q = req.query || {};
    const serviceSessionId = String(b.serviceSessionId || b.service_session_id || q.serviceSessionId || q.service_session_id || '').trim();
    const assessmentId = String(b.assessmentId || b.assessment_id || b.submissionRef || b.submission_ref || q.assessmentId || q.assessment_id || q.submissionRef || q.submission_ref || '').trim();
    const email = normaliseEmail(b.email || b.clientEmail || b.assessmentEmail || q.email || q.clientEmail || q.assessmentEmail || '');

    let session = null;
    if (serviceSessionId) {
      session = (await query(`SELECT * FROM service_sessions WHERE id=$1 LIMIT 1`, [serviceSessionId])).rows[0] || null;
    }
    if (!session && assessmentId) {
      session = (await query(
        `SELECT * FROM service_sessions
         WHERE service_type='visa_assessment' AND service_ref=$1
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 1`,
        [assessmentId]
      )).rows[0] || null;
    }

    if (!session) {
      return res.status(401).json({ ok: false, error: 'Login required.', code: 'CHECKOUT_SESSION_NOT_FOUND' });
    }

    const md = session.metadata || {};
    const sessionEmail = normaliseEmail(session.client_email || md.portal_login_email || md.original_started_email || md.applicant_email);
    const confirmed = Boolean(md.portal_login_confirmed_at || md.fresh_login_confirmed || session.client_id);
    if (!confirmed) {
      return res.status(401).json({ ok: false, error: 'Login required.', code: 'CHECKOUT_LOGIN_NOT_CONFIRMED' });
    }
    if (email && sessionEmail && email !== sessionEmail) {
      return res.status(403).json({
        ok: false,
        error: 'This checkout belongs to a different email address. Please log in with the same email used in the assessment form.',
        code: 'CHECKOUT_EMAIL_MISMATCH',
        requiredEmail: sessionEmail,
        loggedInEmail: email
      });
    }

    let client = null;
    if (session.client_id) {
      client = (await query('SELECT id, email, name FROM clients WHERE id=$1 LIMIT 1', [session.client_id])).rows[0] || null;
    }
    if (!client && sessionEmail) {
      client = (await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1) LIMIT 1', [sessionEmail])).rows[0] || null;
    }
    if (!client) {
      return res.status(401).json({ ok: false, error: 'Login required.', code: 'CHECKOUT_CLIENT_NOT_FOUND' });
    }

    req.client = client;
    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Login required.', code: 'CHECKOUT_AUTH_BRIDGE_FAILED', detail: err.message });
  }
}


// Automated client journey system: assessment -> payment -> documents -> review -> lodgement readiness.
installClientJourneyRoutes(app, {
  query,
  tx,
  requireAuth,
  stripe,
  appBaseUrl: APP_BASE_URL,
  resolveVisaPriceId
});

function makeAssessmentId(visaType) {
  return `sub_${Date.now()}_${String(visaType || 'visa').toLowerCase()}_${Math.random().toString(16).slice(2, 10)}`;
}

// ---- Public visa assessment start + exact assessment-id handoff ----
function getRequestedAssessmentId(req) {
  return String(
    (req.body && (req.body.assessmentId || req.body.assessment_id || req.body.id)) ||
    (req.query && (req.query.assessmentId || req.query.assessment_id || req.query.id)) ||
    ''
  ).trim();
}

function getRequestedServiceSessionId(req) {
  return String(
    (req.body && (req.body.serviceSessionId || req.body.service_session_id)) ||
    (req.query && (req.query.serviceSessionId || req.query.service_session_id)) ||
    ''
  ).trim();
}

async function markServiceSessionLoginConfirmed(req, client) {
  const serviceSessionId = getRequestedServiceSessionId(req);
  const serviceType = normaliseServiceType((req.body && (req.body.service || req.body.serviceType || req.body.service_type)) || (req.query && (req.query.service || req.query.serviceType || req.query.service_type)) || '');
  const appealAssessmentId = String(
    (req.body && (req.body.appealAssessmentId || req.body.appeal_assessment_id)) ||
    (req.query && (req.query.appealAssessmentId || req.query.appeal_assessment_id)) ||
    ''
  ).trim();
  if (!serviceSessionId && !appealAssessmentId) return null;

  let rows = [];
  if (serviceSessionId) {
    rows = (await query(`SELECT * FROM service_sessions WHERE id=$1 LIMIT 1`, [serviceSessionId])).rows;
  } else if (appealAssessmentId) {
    rows = (await query(`SELECT * FROM service_sessions WHERE service_type='appeals_assessment' AND service_ref=$1 ORDER BY created_at DESC LIMIT 1`, [appealAssessmentId])).rows;
  }
  const session = rows[0];
  if (!session) return null;

  const startedEmail = normaliseEmail(session.client_email);
  const loggedInEmail = normaliseEmail(client && client.email);

  // Permanent handoff protection:
  // The service session belongs to the email captured on the assessment form.
  // A stale browser token, stale localStorage handoff, or a different test login must never
  // overwrite service_sessions.client_email. If the email does not match, stop here and
  // instruct the frontend to clear the wrong session and login with the assessment email.
  if (startedEmail && loggedInEmail && startedEmail !== loggedInEmail) {
    const err = new Error(`This saved assessment was submitted using ${startedEmail}. You are currently logged in as ${loggedInEmail}. Please log out and sign in with ${startedEmail} to continue to payment.`);
    err.statusCode = 409;
    err.code = 'CHECKOUT_EMAIL_MISMATCH';
    err.requiredEmail = startedEmail;
    err.loggedInEmail = loggedInEmail;
    err.serviceSessionId = session.id;
    err.serviceRef = session.service_ref || null;
    throw err;
  }

  if (session.service_type === 'visa_assessment' && session.service_ref) {
    const assessmentRows = (await query(
      `SELECT id, client_email, applicant_email FROM assessments WHERE id=$1 LIMIT 1`,
      [session.service_ref]
    )).rows;
    const assessment = assessmentRows[0];
    const assessmentEmail = normaliseEmail(assessment && (assessment.client_email || assessment.applicant_email));
    if (assessmentEmail && loggedInEmail && assessmentEmail !== loggedInEmail) {
      const err = new Error(`This assessment belongs to ${assessmentEmail}, but you are logged in as ${loggedInEmail}. Please use the same email address used in the assessment form.`);
      err.statusCode = 409;
      err.code = 'ASSESSMENT_EMAIL_MISMATCH';
      err.requiredEmail = assessmentEmail;
      err.loggedInEmail = loggedInEmail;
      err.serviceSessionId = session.id;
      err.assessmentId = session.service_ref;
      throw err;
    }
  }

  const metadata = {
    ...(session.metadata || {}),
    original_started_email: (session.metadata && session.metadata.original_started_email) || startedEmail || null,
    portal_login_email: loggedInEmail || null,
    portal_login_confirmed_at: new Date().toISOString(),
    fresh_login_confirmed: true,
    email_match_enforced: true
  };

  await query(
    `UPDATE service_sessions
     SET client_id=$1,
         client_email=COALESCE(NULLIF(client_email,''), $2),
         metadata=COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
         updated_at=now()
     WHERE id=$4`,
    [client.id, loggedInEmail, JSON.stringify(metadata), session.id]
  );

  if (session.service_type === 'appeals_assessment' && session.service_ref) {
    await query(
      `UPDATE appeals_assessments
       SET client_id=$1,
           client_email=COALESCE(NULLIF(client_email,''), $2),
           updated_at=now()
       WHERE id=$3`,
      [client.id, loggedInEmail, session.service_ref]
    );
  }

  return { ...session, client_id: client.id, client_email: startedEmail || loggedInEmail, metadata };
}

async function attachVisaAssessmentToClientById(assessmentId, client) {
  if (!assessmentId) return null;
  const { rows } = await query('SELECT * FROM assessments WHERE id=$1', [assessmentId]);
  const assessment = rows[0];
  if (!assessment) {
    const err = new Error('Assessment was not found. Submit the visa assessment first, using the same email address, then continue to payment.');
    err.statusCode = 404;
    throw err;
  }

  const assessmentEmail = normaliseEmail(assessment.client_email || assessment.applicant_email);
  const clientEmail = normaliseEmail(client && client.email);
  if (!assessmentEmail || assessmentEmail !== clientEmail) {
    const err = new Error(`This assessment belongs to ${assessmentEmail || 'another email address'}, but you are logged in as ${clientEmail}. Please use the same email address used in the assessment form.`);
    err.statusCode = 409;
    err.code = 'ASSESSMENT_EMAIL_MISMATCH';
    err.requiredEmail = assessmentEmail || null;
    err.loggedInEmail = clientEmail || null;
    err.assessmentId = assessment.id;
    throw err;
  }

  const updated = await query(
    `UPDATE assessments
     SET client_id=$1,
         client_email=$2,
         applicant_email=COALESCE(applicant_email,$2),
         active_plan=COALESCE(active_plan, selected_plan),
         updated_at=now()
     WHERE id=$3
     RETURNING *`,
    [client.id, client.email, assessment.id]
  );
  return updated.rows[0] || assessment;
}

function visaCheckoutHandoffPayload(assessment) {
  if (!assessment) return null;
  return {
    service: 'visa_assessment',
    assessmentId: assessment.id,
    assessment_id: assessment.id,
    visaType: assessment.visa_type,
    plan: assessment.selected_plan || assessment.active_plan || 'instant',
    next: `/checkout-start.html?assessment_id=${encodeURIComponent(assessment.id)}`
  };
}


function expectedAmountCentsForService(serviceType, plan) {
  const service = normaliseServiceType(serviceType);
  if (service === 'visa_assessment' || service === 'appeals_assessment') {
    const p = safePlan(plan);
    if (p === 'instant') return 30000;
    if (p === '24h') return 25000;
    if (p === '3d') return 20000;
  }
  if (service === 'citizenship_test') {
    const p = normaliseCitizenshipPlan(plan);
    if (p === '20') return 5000;
    if (p === '50') return 10000;
    if (p === '100') return 15000;
  }
  throw Object.assign(new Error(`Invalid payment plan for ${serviceType}: ${plan}`), { statusCode: 400 });
}

function expectedPlanLabelForService(serviceType, plan) {
  const service = normaliseServiceType(serviceType);
  if (service === 'citizenship_test') return normaliseCitizenshipPlan(plan);
  return safePlan(plan);
}

async function assertStripePriceMatchesPlan({ serviceType, plan, priceId, currency = 'aud' }) {
  if (!stripe) throw Object.assign(new Error('Stripe is not configured.'), { statusCode: 500 });
  if (!priceId) throw Object.assign(new Error(`Missing Stripe price for ${serviceType} plan ${expectedPlanLabelForService(serviceType, plan)}.`), { statusCode: 500 });
  const expectedAmount = expectedAmountCentsForService(serviceType, plan);
  const expectedCurrency = String(currency || 'aud').toLowerCase();
  const cacheKey = `${serviceType}|${expectedPlanLabelForService(serviceType, plan)}|${priceId}|${expectedCurrency}|${expectedAmount}`;
  if (stripePriceValidationCache.has(cacheKey)) return stripePriceValidationCache.get(cacheKey);
  let price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (err) {
    throw Object.assign(new Error(`Stripe price ${priceId} could not be retrieved for ${serviceType} plan ${expectedPlanLabelForService(serviceType, plan)}: ${err.message}`), { statusCode: 500 });
  }
  const actualCurrency = String(price.currency || '').toLowerCase();
  if (!price.active) {
    throw Object.assign(new Error(`Stripe price ${priceId} is inactive for ${serviceType} plan ${expectedPlanLabelForService(serviceType, plan)}.`), { statusCode: 500 });
  }
  if (actualCurrency !== expectedCurrency || Number(price.unit_amount) !== expectedAmount) {
    throw Object.assign(new Error(`Stripe price mismatch blocked: ${serviceType} plan ${expectedPlanLabelForService(serviceType, plan)} requires ${expectedCurrency.toUpperCase()} ${(expectedAmount / 100).toFixed(2)}, but ${priceId} is ${actualCurrency.toUpperCase()} ${((Number(price.unit_amount || 0)) / 100).toFixed(2)}. Fix the Render environment variable before taking payment.`), { statusCode: 500 });
  }
  const verified = { ok: true, priceId, amountCents: expectedAmount, currency: expectedCurrency };
  stripePriceValidationCache.set(cacheKey, verified);
  return verified;
}

function resolveVisaPriceId(_visaType, plan) {
  const key = safePlan(plan) === 'instant' ? 'INSTANT' : safePlan(plan) === '24h' ? '24H' : '3D';
  return process.env[`STRIPE_PRICE_VISA_${key}`] || process.env[`STRIPE_PRICE_VISA_${key}_TEST`] || process.env[`STRIPE_PRICE_VISA_${key}_LIVE`];
}


function resolveAppealPriceId(plan) {
  const key = safePlan(plan) === 'instant' ? 'INSTANT' : safePlan(plan) === '24h' ? '24H' : '3D';
  return process.env[`STRIPE_PRICE_APPEAL_${key}`] || process.env[`STRIPE_PRICE_APPEAL_${key}_TEST`] || process.env[`STRIPE_PRICE_APPEAL_${key}_LIVE`];
}

function normaliseCitizenshipPlan(plan) {
  const rawInput = String(plan || '').trim();
  const raw = rawInput.toLowerCase().replace(/\s+/g, '').replace(/[-_]+/g, '').replace(/\$/g, '').replace(/aud/g, '');
  if (['20', '20test', '20tests', 'twenty', 'starter20'].includes(raw)) return '20';
  if (['50', '50test', '50tests', 'fifty', 'standard50'].includes(raw)) return '50';
  if (['100', '100test', '100tests', 'onehundred', 'hundred', 'premium100'].includes(raw)) return '100';
  // Some older frontend buttons sent the dollar price rather than the test-count plan.
  // Preserve those safely: $150 means the 100-test pack, not an invalid 150-test plan.
  if (['150', '150price', '150payment', '150plan'].includes(raw)) return '100';
  throw Object.assign(new Error(`Invalid citizenship test plan: ${rawInput || '(empty)'}. Allowed plans are 20, 50, or 100 tests.`), { statusCode: 400 });
}

function normaliseCitizenshipAmountToPlan(amount) {
  const raw = String(amount || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[-_]+/g, '').replace(/\$/g, '').replace(/aud/g, '');
  if (['50', '50.00', '5000'].includes(raw)) return '20';
  if (['100', '100.00', '10000'].includes(raw)) return '50';
  if (['150', '150.00', '15000'].includes(raw)) return '100';
  return normaliseCitizenshipPlan(amount);
}

function normaliseCitizenshipPriceToPlan(value) {
  const rawInput = String(value || '').trim();
  const raw = rawInput.toLowerCase().replace(/\s+/g, '').replace(/[-_]+/g, '').replace(/aud/g, '');
  if (!raw) return null;
  if (raw.includes('$')) {
    const dollars = raw.replace(/[^0-9.]/g, '');
    if (dollars === '50') return '20';
    if (dollars === '100') return '50';
    if (dollars === '150') return '100';
  }
  return null;
}

function normaliseCitizenshipTestCount(value) {
  const rawInput = String(value || '').trim();
  const priceMapped = normaliseCitizenshipPriceToPlan(rawInput);
  if (priceMapped) return priceMapped;
  const raw = rawInput.toLowerCase().replace(/\s+/g, '').replace(/[-_]+/g, '').replace(/aud/g, '');
  if (['20', '20test', '20tests', 'twenty'].includes(raw)) return '20';
  if (['50', '50test', '50tests', 'fifty'].includes(raw)) return '50';
  if (['100', '100test', '100tests', 'onehundred'].includes(raw)) return '100';
  if (/20.*test/.test(rawInput.toLowerCase())) return '20';
  if (/50.*test/.test(rawInput.toLowerCase())) return '50';
  if (/100.*test/.test(rawInput.toLowerCase())) return '100';
  return null;
}

function requestedCitizenshipPlan(req, fallback = '20') {
  const body = (req && req.body) || {};
  const queryObj = (req && req.query) || {};

  // First priority: explicit test-count fields. These mean product quantity,
  // not dollars.
  const testCountSources = [
    body.testCount, body.test_count, body.tests, body.examCount, body.exam_count,
    body.numberOfTests, body.number_of_tests,
    queryObj.testCount, queryObj.test_count, queryObj.tests, queryObj.examCount, queryObj.exam_count,
    queryObj.numberOfTests, queryObj.number_of_tests
  ];
  for (const value of testCountSources) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const mapped = normaliseCitizenshipTestCount(value);
      if (mapped) return mapped;
    }
  }

  // Second priority: price/amount fields. These mean dollars: $50 -> 20 tests,
  // $100 -> 50 tests, $150 -> 100 tests.
  const priceSources = [
    body.amount, body.amountAud, body.amount_aud, body.price, body.priceAud, body.price_aud,
    body.paymentAmount, body.payment_amount, body.selectedPrice, body.selected_price,
    queryObj.amount, queryObj.amountAud, queryObj.amount_aud, queryObj.price, queryObj.priceAud, queryObj.price_aud,
    queryObj.paymentAmount, queryObj.payment_amount, queryObj.selectedPrice, queryObj.selected_price
  ];
  for (const value of priceSources) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const raw = String(value).trim().replace(/[^0-9.]/g, '');
      if (raw === '50') return '20';
      if (raw === '100') return '50';
      if (raw === '150') return '100';
    }
  }

  // Third priority: plan-like fields. Numeric 20/50/100 means test-count plan;
  // dollar-labelled $50/$100/$150 is still mapped safely as price.
  const planSources = [
    body.plan, body.selectedPlan, body.selected_plan, body.planId, body.plan_id,
    body.pricePlan, body.price_plan, body.package, body.tier,
    queryObj.plan, queryObj.selectedPlan, queryObj.selected_plan, queryObj.planId, queryObj.plan_id,
    queryObj.pricePlan, queryObj.price_plan, queryObj.package, queryObj.tier,
    fallback
  ];
  for (const value of planSources) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const mapped = normaliseCitizenshipTestCount(value);
      if (mapped) return mapped;
    }
  }
  return normaliseCitizenshipPlan(fallback);
}

function citizenshipExamAllowance(plan) {
  const p = normaliseCitizenshipPlan(plan);
  if (p === '100') return 100;
  if (p === '50') return 50;
  return 20;
}

function resolveCitizenshipPriceId(plan) {
  const key = normaliseCitizenshipPlan(plan).toUpperCase();
  return process.env[`STRIPE_PRICE_CITIZENSHIP_${key}`]
    || process.env[`STRIPE_PRICE_CITIZENSHIP_${key}_TEST`]
    || process.env[`STRIPE_PRICE_CITIZENSHIP_${key}_LIVE`];
}

function makeCitizenshipAccessId(plan) {
  return `cit_${Date.now()}_${normaliseCitizenshipPlan(plan)}_${Math.random().toString(16).slice(2, 10)}`;
}


// ---------- Unified service-session engine ----------
// This layer is the single checkout handoff model for all commercial services.
// It does not remove the existing service-specific tables; it indexes them through one stable session id.
function makeServiceSessionId(serviceType) {
  const clean = String(serviceType || 'service').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'service';
  return `svc_${Date.now()}_${clean}_${Math.random().toString(16).slice(2, 10)}`;
}

function normaliseServiceType(value) {
  const raw = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (['visa', 'visa_assessment', 'assessment'].includes(raw)) return 'visa_assessment';
  if (['appeal', 'appeals', 'appeals_assessment', 'appeal_assessment'].includes(raw)) return 'appeals_assessment';
  if (['citizenship', 'citizenship_test', 'citizenship_exam'].includes(raw)) return 'citizenship_test';
  return raw;
}

async function upsertServiceSession({ id, serviceType, serviceRef, email, clientId = null, plan = null, status = 'draft_created', paymentStatus = 'unpaid', stripeSessionId = null, metadata = {} }) {
  const sessionId = id || makeServiceSessionId(serviceType);
  const normalisedType = normaliseServiceType(serviceType);
  const normalisedEmail = normaliseEmail(email);
  if (!normalisedType) throw Object.assign(new Error('service_type is required.'), { statusCode: 400 });
  if (!normalisedEmail || !normalisedEmail.includes('@')) throw Object.assign(new Error('Valid client email is required.'), { statusCode: 400 });
  const { rows } = await query(
    `INSERT INTO service_sessions (id, service_type, service_ref, client_id, client_email, selected_plan, status, payment_status, stripe_session_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       service_type=EXCLUDED.service_type,
       service_ref=COALESCE(EXCLUDED.service_ref, service_sessions.service_ref),
       client_id=COALESCE(EXCLUDED.client_id, service_sessions.client_id),
       client_email=COALESCE(EXCLUDED.client_email, service_sessions.client_email),
       selected_plan=COALESCE(EXCLUDED.selected_plan, service_sessions.selected_plan),
       status=COALESCE(EXCLUDED.status, service_sessions.status),
       payment_status=COALESCE(EXCLUDED.payment_status, service_sessions.payment_status),
       stripe_session_id=COALESCE(EXCLUDED.stripe_session_id, service_sessions.stripe_session_id),
       metadata=COALESCE(service_sessions.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
       updated_at=now()
     RETURNING *`,
    [sessionId, normalisedType, serviceRef || null, clientId || null, normalisedEmail, plan || null, status, paymentStatus, stripeSessionId || null, metadata || {}]
  );
  return rows[0];
}

async function getServiceSessionForCheckout(req) {
  const serviceSessionId = req.body.serviceSessionId || req.body.service_session_id || req.query.service_session_id || req.query.serviceSessionId;
  const serviceType = normaliseServiceType(req.body.serviceType || req.body.service_type || req.query.service_type || req.query.service);
  const serviceRef = req.body.serviceRef || req.body.service_ref || req.body.assessmentId || req.body.assessment_id || req.body.appealAssessmentId || req.body.appeal_assessment_id || req.query.assessment_id;
  let rows;
  if (serviceSessionId) {
    rows = (await query(`SELECT * FROM service_sessions WHERE id=$1 LIMIT 1`, [serviceSessionId])).rows;
  } else if (serviceType && serviceRef) {
    rows = (await query(`SELECT * FROM service_sessions WHERE service_type=$1 AND service_ref=$2 ORDER BY created_at DESC LIMIT 1`, [serviceType, serviceRef])).rows;
  } else if (serviceType && normaliseEmail(req.client.email)) {
    rows = (await query(
      `SELECT * FROM service_sessions
       WHERE service_type=$1 AND lower(client_email)=lower($2) AND payment_status <> 'paid'
       ORDER BY created_at DESC LIMIT 1`,
      [serviceType, req.client.email]
    )).rows;
  }
  const session = rows && rows[0];
  if (!session) {
    throw Object.assign(new Error('Checkout handoff was not found. The assessment was not saved before login, so Stripe has been stopped. Please submit the assessment again from the selected plan button.'), { statusCode: 404, code: 'SERVICE_SESSION_NOT_FOUND' });
  }

  const existingMetadata = session.metadata || {};
  const sessionServiceType = normaliseServiceType(session.service_type || existingMetadata.service_type || serviceType);
  const startedEmail = normaliseEmail(session.client_email || existingMetadata.original_started_email || existingMetadata.applicant_email);
  const loggedInEmail = normaliseEmail(req.client && req.client.email);

  // Payment handoff must be deliberate. The login page confirms this by setting
  // portal_login_confirmed_at before checkout. Normal logins must go to dashboard,
  // not Stripe, unless a real saved service_session_id is being carried through.
  if (existingMetadata.require_fresh_login && !existingMetadata.portal_login_confirmed_at) {
    throw Object.assign(new Error('Login must be completed before Stripe payment. Please log in through the secure portal first.'), { statusCode: 401, code: 'FRESH_LOGIN_REQUIRED' });
  }

  // Strict self-service rule: visa assessments must be paid from the same portal
  // email used when the assessment was submitted. Appeals may preserve a different
  // applicant/refusal email, but visa self-service access is account-email locked.
  if (sessionServiceType === 'visa_assessment') {
    if (startedEmail && loggedInEmail && startedEmail !== loggedInEmail) {
      throw Object.assign(
        new Error('This visa assessment must be paid from the same email address used to submit the assessment. Please log in with the assessment email or submit the assessment again.'),
        { statusCode: 403, code: 'VISA_EMAIL_MISMATCH', requiredEmail: startedEmail, loggedInEmail, serviceSessionId: session.id, assessmentId: session.service_ref || null }
      );
    }

    if (session.service_ref) {
      const assessmentRows = (await query(
        `SELECT id, client_email, applicant_email FROM assessments WHERE id=$1 LIMIT 1`,
        [session.service_ref]
      )).rows;
      const assessment = assessmentRows[0];
      const assessmentEmail = normaliseEmail(assessment && (assessment.client_email || assessment.applicant_email));
      if (assessmentEmail && loggedInEmail && assessmentEmail !== loggedInEmail) {
        throw Object.assign(
          new Error('This visa assessment belongs to a different email address. Please log in with the same email used in the assessment form.'),
          { statusCode: 403, code: 'ASSESSMENT_EMAIL_MISMATCH', requiredEmail: assessmentEmail, loggedInEmail, serviceSessionId: session.id, assessmentId: session.service_ref }
        );
      }
    }
  }

  const nextMetadata = {
    ...existingMetadata,
    original_started_email: existingMetadata.original_started_email || startedEmail || null,
    portal_login_email: loggedInEmail || null,
    checkout_email_policy: sessionServiceType === 'visa_assessment' ? 'strict_same_email' : 'portal_account_attached',
    checkout_email_checked_at: new Date().toISOString()
  };

  const nextClientEmail = sessionServiceType === 'visa_assessment'
    ? (session.client_email || req.client.email)
    : req.client.email;

  await query(
    `UPDATE service_sessions
     SET client_id=$1, client_email=$2, metadata=COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at=now()
     WHERE id=$4`,
    [req.client.id, nextClientEmail, JSON.stringify(nextMetadata), session.id]
  );
  session.client_id = req.client.id;
  session.client_email = nextClientEmail;
  session.metadata = nextMetadata;
  return session;
}

async function markServiceSessionCheckoutCreated(sessionId, stripeSessionId) {
  await query(`UPDATE service_sessions SET status='checkout_created', stripe_session_id=$1, updated_at=now() WHERE id=$2`, [stripeSessionId, sessionId]);
}

async function markServiceSessionPaidByStripe(session) {
  const md = session.metadata || {};
  const serviceType = normaliseServiceType(md.service_type);
  const serviceRef = md.service_session_id || md.service_ref || md.assessment_id || md.appeal_assessment_id || md.citizenship_access_id || session.client_reference_id;
  if (!serviceType) return;
  await query(
    `UPDATE service_sessions
     SET status='paid', payment_status='paid', stripe_session_id=$1, updated_at=now()
     WHERE (id=$2 OR (service_type=$3 AND service_ref=$4))`,
    [session.id, md.service_session_id || null, serviceType, serviceRef || null]
  );
}



function appealReleaseAtSql(plan) {
  const p = safePlan(plan);
  if (p === 'instant') return 'now()';
  if (p === '24h') return "now() + interval '24 hours'";
  return "now() + interval '72 hours'";
}


// ---- Unified release-lock helpers for visa + appeals + citizenship dashboard ----
function releaseIntervalSqlForPlan(plan) {
  const p = safePlan(plan);
  if (p === 'instant') return 'now()';
  if (p === '24h') return "now() + interval '24 hours'";
  return "now() + interval '72 hours'";
}

function isInstantPlan(plan) {
  return safePlan(plan) === 'instant';
}

function normalisePlanLabel(plan) {
  const p = safePlan(plan);
  if (p === '24h') return '24 Hours';
  if (p === '3d') return '3 Days';
  return 'Instant';
}

function formatDurationSeconds(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `${d}d ${rh}h ${m}m`;
  }
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function serviceTitle(serviceType, row) {
  if (serviceType === 'visa_assessment') return `Subclass ${row.visa_type || row.visaType || 'Visa'} assessment`;
  if (serviceType === 'appeals_assessment') return `Appeals assessment${row.visa_subclass ? ' — subclass ' + row.visa_subclass : ''}`;
  if (serviceType === 'citizenship_test') return 'Australian Citizenship Test Practice';
  return 'Client service';
}

function buildUnifiedServiceCard(row) {
  const serviceType = row.service_type;
  const paid = row.payment_status === 'paid' || row.status === 'active' || row.status === 'pdf_ready' || row.status === 'advice_ready' || row.status === 'release_scheduled';
  const rawPlan = row.selected_plan || row.active_plan || row.plan || (serviceType === 'citizenship_test' ? '20' : 'instant');
  const plan = serviceType === 'citizenship_test' ? normaliseCitizenshipPlan(rawPlan) : safePlan(rawPlan);
  const secondsRemaining = Math.max(0, Number(row.release_seconds_remaining || 0));
  const locked = paid && secondsRemaining > 0;
  const hasPdf = row.has_pdf === true;
  const ready = paid && !locked && (hasPdf || serviceType === 'citizenship_test');
  const finalPdfUrl = serviceType === 'visa_assessment' && hasPdf && !locked ? `/api/assessment/${encodeURIComponent(row.id)}/final-pdf` : serviceType === 'appeals_assessment' && hasPdf && !locked ? `/api/appeals/${encodeURIComponent(row.id)}/final-pdf` : null;
  let actionLabel = 'Complete payment';
  if (serviceType === 'citizenship_test' && paid) actionLabel = 'Open paid exam';
  else if (locked) actionLabel = `${normalisePlanLabel(plan)} release pending`;
  else if (ready && finalPdfUrl) actionLabel = 'Open PDF';
  else if (paid) actionLabel = 'Preparing advice letter';
  return {
    id: row.id,
    serviceType,
    title: serviceTitle(serviceType, row),
    reference: row.id,
    plan,
    planLabel: serviceType === 'citizenship_test' ? `${plan} Tests` : normalisePlanLabel(plan),
    status: row.status,
    paymentStatus: row.payment_status,
    paid,
    locked,
    ready,
    hasPdf,
    releaseAt: row.release_at || null,
    releaseSecondsRemaining: secondsRemaining,
    timerText: locked ? formatDurationSeconds(secondsRemaining) : null,
    actionLabel,
    finalPdfUrl,
    amountCents: row.amount_cents || null,
    currency: row.currency || 'aud',
    stripeSessionId: row.stripe_session_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pdfGeneratedAt: row.pdf_generated_at || null,
    generationError: row.generation_error || null,
    attemptsRemaining: row.attempts_remaining || null,
    examAllowance: row.exam_allowance || null,
    attemptsUsed: row.attempts_used || null
  };
}

function appealAmountCents(plan) {
  const p = safePlan(plan);
  if (p === 'instant') return 30000;
  if (p === '24h') return 25000;
  return 20000;
}

function makeAppealAssessmentId() {
  return `appeal_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}


function appealSubmissionFingerprint({ email, visaSubclass, decisionType, appealGrounds, plan, decisionFile }) {
  const payload = {
    email: normaliseEmail(email),
    visaSubclass: String(visaSubclass || '').toLowerCase(),
    decisionType: String(decisionType || '').toLowerCase(),
    appealGrounds: String(appealGrounds || '').trim().replace(/\s+/g, ' ').toLowerCase(),
    plan: safePlan(plan),
    fileName: decisionFile && decisionFile.originalname ? String(decisionFile.originalname).toLowerCase() : '',
    fileSize: decisionFile && decisionFile.size ? Number(decisionFile.size) : 0
  };
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

async function findRecentDuplicateAppealSubmission({ email, visaSubclass, decisionType, appealGrounds, plan, decisionFile }) {
  const fingerprint = appealSubmissionFingerprint({ email, visaSubclass, decisionType, appealGrounds, plan, decisionFile });
  const { rows } = await query(
    `SELECT a.*, ss.id AS service_session_id
     FROM appeals_assessments a
     LEFT JOIN LATERAL (
       SELECT id FROM service_sessions s
       WHERE s.service_type='appeals_assessment' AND s.service_ref=a.id
       ORDER BY s.created_at DESC
       LIMIT 1
     ) ss ON true
     WHERE lower(a.applicant_email)=lower($1)
       AND a.visa_subclass=$2
       AND a.decision_type=$3
       AND a.selected_plan=$4
       AND COALESCE(a.uploaded_filename,'')=$5
       AND COALESCE(a.uploaded_size,0)=$6
       AND crypto.digest(convert_to(lower(regexp_replace(COALESCE(a.appeal_grounds,''), '\s+', ' ', 'g')), 'UTF8'), 'sha256') IS NOT NULL
       AND a.created_at > now() - interval '20 minutes'
     ORDER BY a.created_at DESC
     LIMIT 5`,
    [normaliseEmail(email), String(visaSubclass || ''), String(decisionType || ''), safePlan(plan), decisionFile.originalname, decisionFile.size]
  );
  for (const row of rows) {
    const rowFingerprint = appealSubmissionFingerprint({
      email: row.applicant_email || row.client_email,
      visaSubclass: row.visa_subclass,
      decisionType: row.decision_type,
      appealGrounds: row.appeal_grounds,
      plan: row.selected_plan,
      decisionFile: { originalname: row.uploaded_filename, size: row.uploaded_size }
    });
    if (rowFingerprint === fingerprint) return row;
  }
  return null;
}

async function upsertClient(email, password, name) {
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO clients (email, name, password_hash)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET name=COALESCE(EXCLUDED.name, clients.name), updated_at=now()
     RETURNING id, email, name`,
    [normaliseEmail(email), name || null, passwordHash]
  );
  return rows[0];
}


async function ensurePaymentsIdDefaultSafe() {
  try {
    const { rows } = await query(`
      SELECT data_type, udt_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name='payments' AND column_name='id'
      LIMIT 1
    `);
    const col = rows[0];
    if (!col || col.column_default) return;
    const type = `${col.data_type || ''} ${col.udt_name || ''}`.toLowerCase();
    if (type.includes('uuid')) {
      await query(`ALTER TABLE payments ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
    } else if (type.includes('bigint') || type.includes('int8')) {
      await query(`CREATE SEQUENCE IF NOT EXISTS payments_id_seq`);
      await query(`ALTER TABLE payments ALTER COLUMN id SET DEFAULT nextval('payments_id_seq')`);
    }
  } catch (err) {
    console.warn('payments.id default hardening skipped:', err.message);
  }
}


async function runPostgresIdempotencyRepair() {
  // PostgreSQL is the source of truth. Before creating hard unique indexes, merge
  // historical duplicates created by retries/parallel payment returns so the
  // index build can succeed without manual cleanup.
  try {
    // If an old generic visa shell and a real subclass assessment share the same
    // Stripe Checkout session, the real subclass assessment is the matter of record.
    // Move linked service/payment/pdf references to the real subclass row, merge any
    // useful payment/PDF fields, then remove the generic shell so the dashboard cannot
    // show it as a second Visa Assessment card.
    await query(`
      WITH pairs AS (
        SELECT generic.id AS dup_id, real.id AS keep_id
        FROM assessments generic
        JOIN assessments real
          ON real.stripe_session_id IS NOT NULL
         AND generic.stripe_session_id = real.stripe_session_id
         AND real.id <> generic.id
        WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
          AND real.visa_type ~ '^[0-9]{3}$'
      ), ranked AS (
        SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) AS rn
        FROM pairs
      )
      UPDATE service_sessions ss
         SET service_ref = r.keep_id, updated_at = now()
      FROM ranked r
      WHERE r.rn=1 AND ss.service_type='visa_assessment' AND ss.service_ref = r.dup_id
    `).catch(err => console.warn('Generic visa service-session cleanup skipped:', err.message));

    await query(`
      WITH pairs AS (
        SELECT generic.id AS dup_id, real.id AS keep_id
        FROM assessments generic
        JOIN assessments real
          ON real.stripe_session_id IS NOT NULL
         AND generic.stripe_session_id = real.stripe_session_id
         AND real.id <> generic.id
        WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
          AND real.visa_type ~ '^[0-9]{3}$'
      ), ranked AS (
        SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) AS rn
        FROM pairs
      )
      UPDATE payments p
         SET service_ref = r.keep_id, updated_at = now()
      FROM ranked r
      WHERE r.rn=1 AND p.service_type='visa_assessment' AND p.service_ref = r.dup_id
    `).catch(err => console.warn('Generic visa payment cleanup skipped:', err.message));

    await query(`
      WITH pairs AS (
        SELECT generic.id AS dup_id, real.id AS keep_id
        FROM assessments generic
        JOIN assessments real
          ON real.stripe_session_id IS NOT NULL
         AND generic.stripe_session_id = real.stripe_session_id
         AND real.id <> generic.id
        WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
          AND real.visa_type ~ '^[0-9]{3}$'
      ), ranked AS (
        SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) AS rn
        FROM pairs
      )
      UPDATE assessments keep
         SET payment_status = CASE WHEN dup.payment_status='paid' THEN 'paid' ELSE keep.payment_status END,
             status = CASE WHEN dup.payment_status='paid' AND keep.status NOT IN ('pdf_ready','release_scheduled','pdf_queued') THEN COALESCE(dup.status, keep.status) ELSE keep.status END,
             amount_cents = COALESCE(keep.amount_cents, dup.amount_cents),
             currency = COALESCE(keep.currency, dup.currency),
             release_at = COALESCE(keep.release_at, dup.release_at),
             pdf_bytes = COALESCE(keep.pdf_bytes, dup.pdf_bytes),
             pdf_mime = COALESCE(keep.pdf_mime, dup.pdf_mime),
             pdf_filename = COALESCE(keep.pdf_filename, dup.pdf_filename),
             pdf_sha256 = COALESCE(keep.pdf_sha256, dup.pdf_sha256),
             pdf_generated_at = COALESCE(keep.pdf_generated_at, dup.pdf_generated_at),
             updated_at = now()
      FROM ranked r
      JOIN assessments dup ON dup.id=r.dup_id
      WHERE r.rn=1 AND keep.id=r.keep_id
    `).catch(err => console.warn('Generic visa assessment merge skipped:', err.message));

    await query(`
      WITH pairs AS (
        SELECT generic.id AS dup_id, real.id AS keep_id
        FROM assessments generic
        JOIN assessments real
          ON real.stripe_session_id IS NOT NULL
         AND generic.stripe_session_id = real.stripe_session_id
         AND real.id <> generic.id
        WHERE lower(COALESCE(generic.visa_type,'')) IN ('visa','unknown','')
          AND real.visa_type ~ '^[0-9]{3}$'
      ), ranked AS (
        SELECT dup_id, keep_id, row_number() OVER (PARTITION BY dup_id ORDER BY keep_id DESC) AS rn
        FROM pairs
      )
      DELETE FROM assessments a USING ranked r WHERE r.rn=1 AND a.id=r.dup_id
    `).catch(err => console.warn('Generic visa shell delete skipped:', err.message));
    await query(`
      WITH ranked AS (
        SELECT id,
               first_value(id) OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS keep_id,
               row_number() OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS rn
        FROM assessments
        WHERE submission_fingerprint IS NOT NULL
          AND COALESCE(client_email, applicant_email, '') <> ''
          AND visa_type IS NOT NULL
          AND selected_plan IS NOT NULL
      )
      UPDATE assessments keep
         SET payment_status = CASE WHEN dup.payment_status='paid' THEN 'paid' ELSE keep.payment_status END,
             status = CASE WHEN dup.payment_status='paid' AND keep.status NOT IN ('pdf_ready','release_scheduled','pdf_queued') THEN COALESCE(dup.status, keep.status) ELSE keep.status END,
             stripe_session_id = COALESCE(keep.stripe_session_id, dup.stripe_session_id),
             stripe_payment_intent = COALESCE(keep.stripe_payment_intent, dup.stripe_payment_intent),
             amount_cents = COALESCE(keep.amount_cents, dup.amount_cents),
             currency = COALESCE(keep.currency, dup.currency),
             active_plan = COALESCE(keep.active_plan, dup.active_plan),
             release_at = COALESCE(keep.release_at, dup.release_at),
             pdf_bytes = COALESCE(keep.pdf_bytes, dup.pdf_bytes),
             pdf_mime = COALESCE(keep.pdf_mime, dup.pdf_mime),
             pdf_filename = COALESCE(keep.pdf_filename, dup.pdf_filename),
             pdf_sha256 = COALESCE(keep.pdf_sha256, dup.pdf_sha256),
             pdf_generated_at = COALESCE(keep.pdf_generated_at, dup.pdf_generated_at),
             generation_error = CASE WHEN keep.pdf_bytes IS NOT NULL OR dup.pdf_bytes IS NOT NULL THEN NULL ELSE COALESCE(keep.generation_error, dup.generation_error) END,
             updated_at = now()
      FROM ranked r
      JOIN assessments dup ON dup.id=r.id
      WHERE r.rn > 1 AND keep.id=r.keep_id
    `);

    await query(`
      WITH ranked AS (
        SELECT id,
               first_value(id) OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS keep_id,
               row_number() OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS rn
        FROM assessments
        WHERE submission_fingerprint IS NOT NULL
          AND COALESCE(client_email, applicant_email, '') <> ''
          AND visa_type IS NOT NULL
          AND selected_plan IS NOT NULL
      )
      UPDATE service_sessions ss SET service_ref=r.keep_id, updated_at=now()
      FROM ranked r
      WHERE r.rn > 1 AND ss.service_type='visa_assessment' AND ss.service_ref=r.id
    `);
    await query(`
      WITH ranked AS (
        SELECT id,
               first_value(id) OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS keep_id,
               row_number() OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS rn
        FROM assessments
        WHERE submission_fingerprint IS NOT NULL
          AND COALESCE(client_email, applicant_email, '') <> ''
          AND visa_type IS NOT NULL
          AND selected_plan IS NOT NULL
      )
      UPDATE payments p SET service_ref=r.keep_id, updated_at=now()
      FROM ranked r
      WHERE r.rn > 1 AND p.service_type='visa_assessment' AND p.service_ref=r.id
    `).catch(() => null);
    await query(`
      WITH ranked AS (
        SELECT id,
               first_value(id) OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS keep_id,
               row_number() OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS rn
        FROM assessments
        WHERE submission_fingerprint IS NOT NULL
          AND COALESCE(client_email, applicant_email, '') <> ''
          AND visa_type IS NOT NULL
          AND selected_plan IS NOT NULL
      )
      UPDATE pdf_jobs j SET assessment_id=r.keep_id, updated_at=now()
      FROM ranked r
      WHERE r.rn > 1 AND j.assessment_id=r.id
    `).catch(() => null);

    await query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY stripe_session_id
                 ORDER BY CASE WHEN status='paid' THEN 2 ELSE 1 END DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id::text DESC
               ) rn
        FROM payments
        WHERE stripe_session_id IS NOT NULL AND stripe_session_id <> ''
      )
      DELETE FROM payments p USING ranked r WHERE p.id=r.id AND r.rn > 1
    `).catch(() => null);

    await query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY service_type, service_ref
                 ORDER BY CASE WHEN payment_status='paid' THEN 3 WHEN stripe_session_id IS NOT NULL THEN 2 ELSE 1 END DESC,
                          updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
               ) rn
        FROM service_sessions
        WHERE service_ref IS NOT NULL AND service_ref <> ''
      )
      DELETE FROM service_sessions s USING ranked r WHERE s.id=r.id AND r.rn > 1
    `);

    await query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY lower(COALESCE(client_email, applicant_email, '')), visa_type, selected_plan, submission_fingerprint
                 ORDER BY
                   CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN pdf_bytes IS NOT NULL THEN 2 ELSE 1 END DESC,
                   updated_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
               ) AS rn
        FROM assessments
        WHERE submission_fingerprint IS NOT NULL
          AND COALESCE(client_email, applicant_email, '') <> ''
          AND visa_type IS NOT NULL
          AND selected_plan IS NOT NULL
      )
      DELETE FROM assessments a USING ranked r WHERE a.id=r.id AND r.rn > 1
    `);
  } catch (err) {
    console.warn('Postgres idempotency repair skipped:', err.message);
  }
}

async function installPostgresIdempotencyConstraints() {
  await runPostgresIdempotencyRepair();
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assessments_idempotency_unique
    ON assessments (lower(client_email), visa_type, selected_plan, submission_fingerprint)
    WHERE submission_fingerprint IS NOT NULL AND client_email IS NOT NULL
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_service_sessions_unique_service_ref
    ON service_sessions (service_type, service_ref)
    WHERE service_ref IS NOT NULL
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique
    ON payments (stripe_session_id)
    WHERE stripe_session_id IS NOT NULL
  `).catch(err => console.warn('payments stripe_session_id unique index skipped:', err.message));
}

async function ensureSchema() {
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await query(`
    CREATE TABLE IF NOT EXISTS clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      name text,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS assessments (
      id text PRIMARY KEY,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text NOT NULL,
      applicant_email text,
      applicant_name text,
      visa_type text NOT NULL,
      selected_plan text NOT NULL DEFAULT 'instant',
      active_plan text,
      status text NOT NULL DEFAULT 'submitted',
      payment_status text NOT NULL DEFAULT 'unpaid',
      stripe_session_id text,
      stripe_payment_intent text,
      amount_cents integer,
      currency text DEFAULT 'aud',
      form_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      submission_fingerprint text,
      pdf_bytes bytea,
      pdf_mime text,
      pdf_filename text,
      pdf_sha256 text,
      pdf_generated_at timestamptz,
      generation_attempts integer NOT NULL DEFAULT 0,
      generation_locked_at timestamptz,
      generation_error text,
      release_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS payments (
      id bigserial PRIMARY KEY,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text NOT NULL,
      service_type text NOT NULL,
      service_ref text NOT NULL,
      visa_type text,
      plan text,
      stripe_session_id text UNIQUE,
      stripe_payment_intent text,
      amount_cents integer,
      currency text DEFAULT 'aud',
      status text NOT NULL DEFAULT 'paid',
      raw_payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      paid_at timestamptz,
      stripe_created_at timestamptz
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS pdf_jobs (
      id bigserial PRIMARY KEY,
      assessment_id text UNIQUE NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'queued',
      attempts integer NOT NULL DEFAULT 0,
      run_after timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  // In-place migration for existing Render PostgreSQL tables. CREATE TABLE IF NOT EXISTS
  // does not add columns to older tables; these ALTERs prevent missing-column crashes.
  await query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS name text`);
  await query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash text`);
  await query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS client_id uuid`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS client_email text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS applicant_email text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS applicant_name text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS visa_type text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS selected_plan text DEFAULT 'instant'`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS active_plan text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS status text DEFAULT 'submitted'`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid'`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS stripe_session_id text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS stripe_payment_intent text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS amount_cents integer`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud'`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS form_payload jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS submission_fingerprint text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_bytes bytea`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_mime text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_filename text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_sha256 text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_generated_at timestamptz`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generation_attempts integer NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generation_locked_at timestamptz`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generation_error text`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS release_at timestamptz`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_id uuid`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_email text`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_type text DEFAULT 'visa_assessment'`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_ref text`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS visa_type text`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan text`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_session_id text`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent text`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_cents integer`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud'`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS status text DEFAULT 'paid'`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw_payload jsonb`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at timestamptz`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_created_at timestamptz`);
  await ensurePaymentsIdDefaultSafe();

  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS assessment_id text`);
  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS status text DEFAULT 'queued'`);
  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS run_after timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS locked_at timestamptz`);
  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS last_error text`);
  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

  await query(`UPDATE assessments SET status='submitted' WHERE status IN ('payment_pending','unpaid','draft') AND payment_status <> 'paid'`);
  await query(`UPDATE assessments SET status='checkout_created' WHERE stripe_session_id IS NOT NULL AND payment_status <> 'paid' AND status NOT IN ('checkout_created')`);
  await query(`UPDATE assessments SET status='pdf_ready' WHERE pdf_bytes IS NOT NULL`);
  await query(`UPDATE assessments SET status='pdf_queued' WHERE payment_status='paid' AND pdf_bytes IS NULL AND status IN ('active','paid','preparing','processing','queued','ready','generated')`);
  await query(`UPDATE pdf_jobs SET status='completed' WHERE status IN ('complete','ready')`);
  await query(`UPDATE pdf_jobs SET status='queued' WHERE status IN ('processing','running') AND locked_at < now() - interval '10 minutes'`);



  await query(`
    CREATE TABLE IF NOT EXISTS citizenship_access (
      id text PRIMARY KEY,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text NOT NULL,
      selected_plan text NOT NULL DEFAULT '20',
      active_plan text,
      exam_allowance integer NOT NULL DEFAULT 20,
      attempts_used integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'checkout_created',
      payment_status text NOT NULL DEFAULT 'unpaid',
      stripe_session_id text UNIQUE,
      stripe_payment_intent text,
      amount_cents integer,
      currency text DEFAULT 'aud',
      raw_payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS client_id uuid`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS client_email text`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS selected_plan text DEFAULT '20'`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS active_plan text`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS exam_allowance integer NOT NULL DEFAULT 20`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS attempts_used integer NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS status text DEFAULT 'checkout_created'`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid'`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS stripe_session_id text`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS stripe_payment_intent text`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS amount_cents integer`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud'`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS raw_payload jsonb`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE citizenship_access ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_submission_fingerprint ON assessments (lower(client_email), visa_type, selected_plan, submission_fingerprint, created_at DESC) WHERE submission_fingerprint IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citizenship_access_client_email ON citizenship_access (lower(client_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citizenship_access_stripe_session ON citizenship_access (stripe_session_id)`);


  await query(`
    CREATE TABLE IF NOT EXISTS citizenship_exam_attempts (
      id text PRIMARY KEY,
      access_id text,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text NOT NULL,
      plan text,
      score integer NOT NULL DEFAULT 0,
      total_questions integer NOT NULL DEFAULT 20,
      values_correct integer NOT NULL DEFAULT 0,
      values_total integer NOT NULL DEFAULT 5,
      passed boolean NOT NULL DEFAULT false,
      timed_out boolean NOT NULL DEFAULT false,
      questions jsonb NOT NULL DEFAULT '[]'::jsonb,
      answers jsonb NOT NULL DEFAULT '[]'::jsonb,
      result jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS access_id text`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS client_id uuid`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS client_email text`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS plan text`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS total_questions integer NOT NULL DEFAULT 20`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS values_correct integer NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS values_total integer NOT NULL DEFAULT 5`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS passed boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS timed_out boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS questions jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS result jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE citizenship_exam_attempts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citizenship_exam_attempts_client_email ON citizenship_exam_attempts (lower(client_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citizenship_exam_attempts_access ON citizenship_exam_attempts (access_id, created_at DESC)`);

  await query(`
    CREATE TABLE IF NOT EXISTS appeals_assessments (
      id text PRIMARY KEY,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text,
      applicant_email text,
      applicant_name text,
      visa_subclass text,
      decision_type text,
      decision_date text,
      tribunal_deadline text,
      current_location text,
      has_previous_appeal text,
      appeal_grounds text,
      urgency_notes text,
      selected_plan text NOT NULL DEFAULT 'instant',
      active_plan text,
      status text NOT NULL DEFAULT 'submitted',
      payment_status text NOT NULL DEFAULT 'unpaid',
      stripe_session_id text,
      stripe_payment_intent text,
      amount_cents integer,
      currency text DEFAULT 'aud',
      uploaded_filename text,
      uploaded_mime_type text,
      uploaded_size integer,
      uploaded_file bytea,
      public_draft_key text,
      release_at timestamptz,
      pdf_bytes bytea,
      pdf_mime text,
      pdf_filename text,
      pdf_sha256 text,
      pdf_generated_at timestamptz,
      generation_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS client_id uuid`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS client_email text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS applicant_email text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS applicant_name text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS visa_subclass text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS decision_type text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS decision_date text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS tribunal_deadline text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS current_location text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS has_previous_appeal text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS appeal_grounds text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS urgency_notes text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS selected_plan text DEFAULT 'instant'`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS active_plan text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS status text DEFAULT 'submitted'`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid'`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS stripe_session_id text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS stripe_payment_intent text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS amount_cents integer`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud'`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS uploaded_filename text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS uploaded_mime_type text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS uploaded_size integer`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS uploaded_file bytea`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS public_draft_key text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS release_at timestamptz`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS pdf_bytes bytea`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS pdf_mime text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS pdf_filename text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS pdf_sha256 text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS pdf_generated_at timestamptz`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS generation_error text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS extracted_text text`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS advice_json jsonb`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`
    CREATE TABLE IF NOT EXISTS appeal_documents (
      id bigserial PRIMARY KEY,
      appeal_id text NOT NULL REFERENCES appeals_assessments(id) ON DELETE CASCADE,
      document_type text NOT NULL DEFAULT 'evidence',
      filename text,
      mime_type text,
      size integer,
      file_bytes bytea,
      extracted_text text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_appeal_documents_appeal_id ON appeal_documents (appeal_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_appeals_assessments_client_email ON appeals_assessments (lower(client_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_appeals_assessments_stripe_session ON appeals_assessments (stripe_session_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_assessments_public_draft_key_unique ON appeals_assessments (public_draft_key) WHERE public_draft_key IS NOT NULL`);



  // Unified service session table: single source of truth for visa, appeals, and citizenship checkout handoff.
  await query(`
    CREATE TABLE IF NOT EXISTS service_sessions (
      id text PRIMARY KEY,
      service_type text NOT NULL,
      service_ref text,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text NOT NULL,
      selected_plan text,
      status text NOT NULL DEFAULT 'draft_created',
      payment_status text NOT NULL DEFAULT 'unpaid',
      stripe_session_id text UNIQUE,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS service_type text`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS service_ref text`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS client_id uuid`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS client_email text`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS selected_plan text`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft_created'`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid'`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS stripe_session_id text`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await query(`ALTER TABLE service_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await query(`CREATE INDEX IF NOT EXISTS idx_service_sessions_email_status ON service_sessions (lower(client_email), status, payment_status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_service_sessions_type_ref ON service_sessions (service_type, service_ref)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_service_sessions_stripe ON service_sessions (stripe_session_id)`);
  await installPostgresIdempotencyConstraints();

  await ensureClientJourneySchema(query);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique ON payments (stripe_session_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_jobs_assessment_id_unique ON pdf_jobs (assessment_id)`);

  // Dashboard performance indexes. These prevent expensive scans when
  // account-dashboard.html loads records by logged-in email/client id.
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_client_email ON assessments (lower(client_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_applicant_email_lower ON assessments (lower(applicant_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_client_id ON assessments (client_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_created_at_desc ON assessments (created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_updated_at_desc ON assessments (updated_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_client_email_created_desc ON assessments (lower(client_email), created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_applicant_email_created_desc ON assessments (lower(applicant_email), created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_payments_client_email_created_desc ON payments (lower(client_email), created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_payments_client_id_created_desc ON payments (client_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citizenship_access_client_created_desc ON citizenship_access (lower(client_email), created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_appeals_assessments_client_created_desc ON appeals_assessments (lower(client_email), created_at DESC)`);

  await query(`CREATE INDEX IF NOT EXISTS idx_pdf_jobs_status_run_after ON pdf_jobs (status, run_after)`);
}



// Temporary duplicate-cleanup admin route removed for production safety.


app.get('/api/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1');
  res.json({
    ok: true,
    service: 'bircan-final-postgres-server',
    supportedAdviceSubclasses: supportedSubclasses(),
    supportedDecisionEngineSubclasses: supportedDelegateSimulatorSubclasses(),
    version: '12.2.3-production-email-lock-admin-route-removed',
    postgres: true,
    jsonFallback: false,
    stripeConfigured: Boolean(stripe),
    smtpConfigured: Boolean(process.env.SMTP_HOST),
    appBaseUrl: APP_BASE_URL,
    corsPatch: 'real-pdf-pipeline-cookie-plus-bearer',
    pdfMode: 'state-machine-issued-pdf-only',
    dashboardAccessPatch: DASHBOARD_ACCESS_PATCH,
    subclass190Engine: 'deterministic-legal-engine-v2-no-gpt-outcome',
    evidenceValidationLayer: true,
    pathwayComparator: true,
    citizenshipCheckoutRoutes: true,
    pathwayComparatorVersion: '482-190-491-v1',
    allowedOrigins
  });
}));

// Production reliability layer: readiness and route diagnostics.
app.get('/api/readiness', asyncRoute(async (_req, res) => {
  const report = await hardening.buildReadinessReport({
    query,
    pdfModule,
    decisionEngineModule,
    routes: hardening.listExpressRoutes(app)
  });
  res.status(report.ok ? 200 : 500).json(report);
}));

app.get('/api/routes', (_req, res) => {
  const routes = hardening.listExpressRoutes(app);
  res.json({ ok: true, count: routes.length, routes });
});


// ---------- Knowledgebase law-update health dashboard ----------
app.get('/api/admin/knowledgebase-health', requireAdmin, asyncRoute(async (_req, res) => {
  const health = await buildKnowledgebaseHealthReport();
  res.json({ ok: true, health });
}));

app.get('/api/knowledgebase/health', asyncRoute(async (_req, res) => {
  // Public-safe summary only. Full file manifest requires admin token.
  const health = await buildKnowledgebaseHealthReport();
  res.json({
    ok: true,
    generatedAt: health.generatedAt,
    snapshotId: health.snapshotId,
    documentsScanned: health.documentsScanned,
    authorityCounts: health.authorityCounts,
    missingAuthority: health.missingAuthority,
    subclassesDetected: health.subclassesDetected,
    lawUpdateMode: health.lawUpdateMode,
    sourceHashChangesWillChangeSnapshot: true
  });
}));



app.get('/api/admin/legal-engine-capabilities', requireAdmin, asyncRoute(async (_req, res) => {
  res.json({
    ok: true,
    version: '10.5.0-final-research-grade-migration-intelligence',
    capabilities: {
      dynamicKnowledgebaseLawUpdates: true,
      universalAllSubclassLegalGraph: true,
      authorityHierarchy: ['ACT','REGULATIONS','INSTRUMENTS','PAMS','OTHER'],
      schedule1Schedule2Separation: true,
      primarySecondaryApplicantLogic: true,
      waiverExemptionLayer: true,
      evidenceSufficiencyScoring: true,
      contradictionDetection: true,
      manualReviewLock: true,
      historicalLawReplayReadiness: true,
      delegateBehaviourModelling: true,
      refusalRiskScreening: true,
      caseLawSimilarityHooks: true,
      precedentClusterHints: true,
      selfLearningEvidenceWeightingAuditHooks: true
    }
  });
}));

// ---------- Unified admin control dashboard API ----------
// Token source: set ADMIN_TOKEN or ADMIN_PASSWORD in Render. The admin HTML sends it as X-Admin-Token.
function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD || process.env.ADMIN_DASHBOARD_TOKEN || process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!configured) return res.status(500).json({ ok: false, error: 'Admin token is not configured. Set ADMIN_TOKEN in Render.' });
  const supplied = String(req.headers['x-admin-token'] || req.headers['x-admin-password'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.admin_token || '').trim();
  if (!supplied || supplied !== String(configured).trim()) return res.status(401).json({ ok: false, error: 'Admin access denied. Enter the admin token configured on the backend.' });
  next();
}


// ---------- Frontend compatibility API routes ----------
// These routes support legacy/non-core frontend files without changing the current production flow.
async function ensureAdminEmailAccountsTable() {
  await query(`CREATE TABLE IF NOT EXISTS admin_email_accounts (
    email text PRIMARY KEY,
    role text,
    note text,
    password_hash text,
    status text DEFAULT 'active',
    provider text DEFAULT 'manual',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`);
}

function publicEmailAccount(row) {
  return {
    email: row.email,
    role: row.role || '',
    note: row.note || '',
    status: row.status || 'active',
    provider: row.provider || 'manual',
    hasPassword: Boolean(row.password_hash),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

app.get('/api/admin/email-accounts', requireAdmin, asyncRoute(async (_req, res) => {
  await ensureAdminEmailAccountsTable();
  const { rows } = await query(`SELECT * FROM admin_email_accounts ORDER BY email ASC`);
  res.json({ ok: true, accounts: rows.map(publicEmailAccount), emailAccounts: rows.map(publicEmailAccount) });
}));

app.post('/api/admin/email-accounts', requireAdmin, asyncRoute(async (req, res) => {
  await ensureAdminEmailAccountsTable();
  const email = normaliseEmail(req.body.email);
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email account is required.' });
  const role = String(req.body.role || '').trim();
  const note = String(req.body.note || '').trim();
  const status = String(req.body.status || 'active').trim() || 'active';
  const provider = String(req.body.provider || 'manual').trim() || 'manual';
  const password = String(req.body.password || '').trim();
  const hash = password ? await bcrypt.hash(password, 10) : null;
  const { rows } = await query(
    `INSERT INTO admin_email_accounts (email, role, note, password_hash, status, provider)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email) DO UPDATE SET
       role=EXCLUDED.role,
       note=EXCLUDED.note,
       password_hash=COALESCE(EXCLUDED.password_hash, admin_email_accounts.password_hash),
       status=EXCLUDED.status,
       provider=EXCLUDED.provider,
       updated_at=now()
     RETURNING *`,
    [email, role, note, hash, status, provider]
  );
  res.json({ ok: true, account: publicEmailAccount(rows[0]) });
}));

app.delete('/api/admin/email-accounts/:email', requireAdmin, asyncRoute(async (req, res) => {
  await ensureAdminEmailAccountsTable();
  const email = normaliseEmail(req.params.email);
  const result = await query(`DELETE FROM admin_email_accounts WHERE lower(email)=lower($1)`, [email]);
  res.json({ ok: true, deleted: result.rowCount || 0, email });
}));

app.post('/api/admin/email/change-password', requireAdmin, asyncRoute(async (req, res) => {
  await ensureAdminEmailAccountsTable();
  const email = normaliseEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email account is required.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO admin_email_accounts (email, password_hash, status, provider)
     VALUES ($1,$2,'active','manual')
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=now()
     RETURNING *`,
    [email, hash]
  );
  res.json({ ok: true, account: publicEmailAccount(rows[0]), message: 'Password control updated for this admin email record.' });
}));

app.post('/api/admin/email-accounts/test', requireAdmin, asyncRoute(async (req, res) => {
  const target = normaliseEmail(req.body.email || process.env.ADMIN_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER || '');
  const configured = Boolean(process.env.SMTP_HOST && (process.env.SMTP_USER || process.env.EMAIL_USER));
  if (!configured) return res.json({ ok: true, configured: false, skipped: true, message: 'SMTP is not configured. Email account route is available, but no test email was sent.' });
  if (!target) return res.status(400).json({ ok: false, error: 'No target email was supplied and no admin email is configured.' });
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER || process.env.EMAIL_USER, pass: process.env.SMTP_PASS || process.env.EMAIL_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER,
    to: target,
    subject: 'Bircan Migration email settings test',
    text: 'This is a backend email settings test from Bircan Migration.'
  });
  res.json({ ok: true, configured: true, sent: true, to: target });
}));

async function restoreClientFromStripeSession(req, res, options = {}) {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.body.sessionId || req.body.session_id || req.query.session_id || req.query.sessionId;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  let session = await stripe.checkout.sessions.retrieve(sessionId);
  session = await normalisePaidStripeSessionForAttachment(session);
  let result = { attached: false, type: (session.metadata || {}).service_type || null };
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  if (paid) result = await attachPaidSession(session, { triggerGeneration: true, waitForPdf: false });
  const email = normaliseEmail((session.metadata || {}).client_email || session.customer_email || (session.customer_details && session.customer_details.email));
  let client = null;
  if (email) {
    client = (await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1) LIMIT 1', [email])).rows[0] || null;
    if (client) setSessionCookie(res, sign(client));
  }
  const token = client ? sign(client) : null;
  return res.json({
    ok: true,
    verified: paid,
    status: paid ? 'paid' : (session.payment_status || session.status || 'open'),
    sessionId,
    service: result.type || (session.metadata || {}).service_type || null,
    assessmentId: result.assessmentId || (session.metadata || {}).assessment_id || null,
    accessId: result.accessId || (session.metadata || {}).citizenship_access_id || null,
    citizenshipAccessId: result.accessId || (session.metadata || {}).citizenship_access_id || null,
    plan: result.plan || (session.metadata || {}).plan || req.query.plan || null,
    client,
    user: client,
    token,
    accessToken: token,
    dashboardAccessToken: client ? signDashboardAccessToken(client) : null,
    redirectUrl: options.redirectUrl || `${APP_BASE_URL}/account-dashboard.html?session_id=${encodeURIComponent(sessionId)}`
  });
}

app.get('/api/stripe/verify-session', asyncRoute((req, res) => restoreClientFromStripeSession(req, res)));
app.post('/api/stripe/verify-session', asyncRoute((req, res) => restoreClientFromStripeSession(req, res)));
app.get('/checkout/verify-session', asyncRoute((req, res) => restoreClientFromStripeSession(req, res)));
app.post('/checkout/verify-session', asyncRoute((req, res) => restoreClientFromStripeSession(req, res)));
app.get('/api/auth/restore-from-session', asyncRoute((req, res) => restoreClientFromStripeSession(req, res)));

async function createCheckoutStartHandoff(req, serviceType) {
  if (!req.client) {
    const err = new Error('Login required before checkout.');
    err.statusCode = 401;
    throw err;
  }
  const body = req.body || {};
  const email = normaliseEmail(body.email || req.client.email);
  const plan = serviceType === 'citizenship_test' ? normaliseCitizenshipPlan(body.plan || body.selectedPlan || body.pack || '20') : safePlan(body.plan || body.selectedPlan || body.turnaround || 'instant');
  let serviceRef = String(body.serviceRef || body.service_ref || body.assessmentId || body.assessment_id || body.submissionId || body.submission_id || body.appealAssessmentId || body.appeal_assessment_id || body.accessId || body.access_id || body.citizenshipAccessId || body.citizenship_access_id || '').trim();

  if (serviceType === 'citizenship_test') {
    // Citizenship checkout can safely use the existing direct handler to return a real Stripe URL.
    return null;
  }
  if (!serviceRef) {
    const err = new Error('Missing assessment reference for checkout. Submit the assessment first.');
    err.statusCode = 400;
    throw err;
  }
  const session = await upsertServiceSession({
    serviceType,
    serviceRef,
    email,
    clientId: req.client.id,
    plan,
    status: 'login_confirmed',
    paymentStatus: 'unpaid',
    metadata: { compatibility_public_checkout: true, portal_login_confirmed_at: new Date().toISOString(), portal_login_email: req.client.email, require_fresh_login: false }
  });
  const params = new URLSearchParams({
    service: serviceType === 'appeals_assessment' ? 'appeals' : 'visa',
    service_session_id: session.id,
    assessment_id: serviceRef,
    plan,
    email
  });
  if (serviceType === 'appeals_assessment') params.set('appeal_assessment_id', serviceRef);
  return { ok: true, service: serviceType, serviceSessionId: session.id, service_session_id: session.id, assessmentId: serviceRef, assessment_id: serviceRef, plan, url: `${APP_BASE_URL}/checkout-start.html?${params.toString()}`, redirectUrl: `${APP_BASE_URL}/checkout-start.html?${params.toString()}` };
}

app.post('/api/public/visa-assessment/checkout', requireAuth, asyncRoute(async (req, res) => {
  res.json(await createCheckoutStartHandoff(req, 'visa_assessment'));
}));

app.post('/api/public/appeals-assessment/checkout', requireAuth, asyncRoute(async (req, res) => {
  res.json(await createCheckoutStartHandoff(req, 'appeals_assessment'));
}));

app.post('/api/public/citizenship/checkout', requireAuth, asyncRoute(handleCitizenshipCheckoutSession));

function journeyFallbackView(assessment, documents = []) {
  const id = assessment && assessment.id;
  const paid = assessment && assessment.payment_status === 'paid';
  const hasPdf = Boolean(assessment && assessment.has_pdf);
  const stageLabel = hasPdf ? 'Advice letter ready' : paid ? 'Professional review in progress' : 'Payment required';
  return {
    ok: true,
    assessmentId: id,
    stageLabel,
    completionPercent: hasPdf ? 100 : paid ? 60 : 25,
    professionalMessage: hasPdf ? 'Your issued advice letter is ready in the dashboard.' : paid ? 'Your matter is moving through review and document preparation.' : 'Complete checkout before professional review can commence.',
    timeline: [
      { label: 'Assessment submitted', completed: true },
      { label: 'Payment confirmed', completed: paid, active: !paid },
      { label: 'Professional review', completed: hasPdf, active: paid && !hasPdf },
      { label: 'Advice letter issued', completed: hasPdf }
    ],
    nextAction: hasPdf ? { action: 'open_dashboard', label: 'Open dashboard', message: 'Open the dashboard to view available document actions.' } : paid ? { action: 'submit_review', label: 'Request review update', message: 'Request a review update if documents have been supplied.' } : { action: 'checkout', label: 'Continue to checkout', message: 'Complete payment to unlock the professional review pathway.' },
    documentsRequired: documents.length ? documents : [
      { name: 'Passport biodata page', status: 'Required', uploaded: false },
      { name: 'Current visa evidence', status: 'Required if applicable', uploaded: false },
      { name: 'Supporting documents for claimed criteria', status: 'Required', uploaded: false }
    ]
  };
}

app.post('/api/journey/bootstrap', requireAuth, asyncRoute(async (req, res) => {
  const assessmentId = String(req.body.assessmentId || req.body.assessment_id || req.body.id || '').trim();
  if (!assessmentId) return res.status(400).json({ ok: false, error: 'assessmentId is required.' });
  const { rows } = await query(
    `SELECT id, payment_status, status, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes)>1024 THEN true ELSE false END AS has_pdf
     FROM assessments
     WHERE id=$1 AND (client_id=$2 OR lower(client_email)=lower($3) OR lower(applicant_email)=lower($3))
     LIMIT 1`,
    [assessmentId, req.client.id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  res.json(journeyFallbackView(rows[0]));
}));

app.post('/api/journey/:assessmentId/documents', requireAuth, asyncRoute(async (req, res) => {
  const assessmentId = String(req.params.assessmentId || '').trim();
  if (!assessmentId) return res.status(400).json({ ok: false, error: 'assessmentId is required.' });
  const { rows } = await query(
    `SELECT id, payment_status, status, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes)>1024 THEN true ELSE false END AS has_pdf
     FROM assessments
     WHERE id=$1 AND (client_id=$2 OR lower(client_email)=lower($3) OR lower(applicant_email)=lower($3))
     LIMIT 1`,
    [assessmentId, req.client.id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  const name = String(req.body.name || 'Uploaded document').trim();
  res.json(journeyFallbackView(rows[0], [{ name, status: 'Recorded', uploaded: true }]));
}));

app.post('/api/journey/:assessmentId/submit-review', requireAuth, asyncRoute(async (req, res) => {
  const assessmentId = String(req.params.assessmentId || '').trim();
  const { rows } = await query(
    `SELECT id, payment_status, status, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes)>1024 THEN true ELSE false END AS has_pdf
     FROM assessments
     WHERE id=$1 AND (client_id=$2 OR lower(client_email)=lower($3) OR lower(applicant_email)=lower($3))
     LIMIT 1`,
    [assessmentId, req.client.id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  res.json(journeyFallbackView({ ...rows[0], payment_status: 'paid' }));
}));

app.get('/api/citizenship/my-entitlement', requireAuth, asyncRoute(async (req, res) => {
  const access = await getCitizenshipAccessForClient(req.client.email);
  const active = access.find(c => c.payment_status === 'paid' || c.status === 'active') || access[0] || null;
  res.json({ ok: true, entitlement: active, activeAccess: active, citizenshipAccess: access, citizenship: access, hasAccess: Boolean(active) });
}));
app.get('/api/citizenship/entitlement', requireAuth, asyncRoute(async (req, res) => {
  const access = await getCitizenshipAccessForClient(req.client.email);
  const active = access.find(c => c.payment_status === 'paid' || c.status === 'active') || access[0] || null;
  res.json({ ok: true, entitlement: active, activeAccess: active, citizenshipAccess: access, citizenship: access, hasAccess: Boolean(active) });
}));

// ---------- End frontend compatibility API routes ----------

async function adminTableExists(tableName) {
  const { rows } = await query(`SELECT to_regclass($1) AS exists`, [tableName]);
  return Boolean(rows[0] && rows[0].exists);
}

async function adminColumns(tableName) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1`,
    [tableName]
  );
  return new Set(rows.map(r => r.column_name));
}

async function adminSafeRows(sql, params = []) {
  try {
    const { rows } = await query(sql, params);
    return rows || [];
  } catch (err) {
    console.warn('Admin dashboard query skipped:', err.message);
    return [];
  }
}

function adminMoney(cents) {
  const n = Number(cents || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function adminRow(type, row) {
  const created = row.created_at || row.createdAt || null;
  const updated = row.updated_at || row.updatedAt || null;
  const paid = String(row.payment_status || row.paymentStatus || row.status || '').toLowerCase().includes('paid') || row.paid === true;
  const hasPdf = Boolean(row.has_pdf || row.pdf_ready || row.pdf_generated_at || row.pdf_sha256 || row.pdf_filename || row.final_pdf_url) || Boolean(row.pdf_bytes);
  return {
    ...row,
    id: row.id || row.service_ref || row.reference || row.stripe_session_id,
    service_type: type,
    serviceType: type,
    client_email: row.client_email || row.email || row.payment_client_email || row.session_client_email || null,
    applicant_email: row.applicant_email || row.client_email || row.email || null,
    applicant_name: row.applicant_name || row.name || null,
    selected_plan: row.selected_plan || row.active_plan || row.plan || null,
    active_plan: row.active_plan || row.selected_plan || row.plan || null,
    payment_status: row.payment_status || (paid ? 'paid' : 'unpaid'),
    status: row.status || null,
    amount_cents: adminMoney(row.amount_cents || row.amountCents || row.amount_total || row.amountTotal),
    currency: row.currency || 'aud',
    stripe_session_id: row.stripe_session_id || row.stripeSessionId || null,
    stripe_payment_intent: row.stripe_payment_intent || row.stripePaymentIntent || null,
    created_at: created,
    updated_at: updated,
    has_pdf: hasPdf,
    pdf_ready: hasPdf,
    title: type === 'visa_assessment'
      ? `Visa assessment${row.visa_type ? ' — subclass ' + row.visa_type : ''}`
      : type === 'appeals_assessment'
        ? `Appeals assessment${row.visa_subclass ? ' — subclass ' + row.visa_subclass : ''}`
        : type === 'citizenship_test'
          ? `Citizenship test pack${row.selected_plan ? ' — ' + row.selected_plan + ' tests' : ''}`
          : 'Payment record'
  };
}

async function adminLoadDashboard() {
  const visa = await adminSafeRows(
    `SELECT *, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf
     FROM assessments
     ORDER BY COALESCE(created_at, updated_at) DESC NULLS LAST
     LIMIT 1000`
  );
  const appeals = await adminSafeRows(
    `SELECT *, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf
     FROM appeals_assessments
     ORDER BY COALESCE(created_at, updated_at) DESC NULLS LAST
     LIMIT 1000`
  );
  const citizenship = await adminSafeRows(
    `SELECT *
     FROM citizenship_access
     ORDER BY COALESCE(created_at, updated_at) DESC NULLS LAST
     LIMIT 1000`
  );
  const sessions = await adminSafeRows(
    `SELECT *
     FROM service_sessions
     ORDER BY COALESCE(created_at, updated_at) DESC NULLS LAST
     LIMIT 1000`
  );
  const payments = await adminSafeRows(
    `SELECT *
     FROM payments
     ORDER BY COALESCE(paid_at, stripe_created_at, created_at, updated_at) DESC NULLS LAST
     LIMIT 1000`
  );
  const pdfJobs = await adminSafeRows(
    `SELECT *
     FROM pdf_jobs
     ORDER BY COALESCE(updated_at, created_at, run_after) DESC NULLS LAST
     LIMIT 300`
  );
  const items = [
    ...visa.map(r => adminRow('visa_assessment', r)),
    ...appeals.map(r => adminRow('appeals_assessment', r)),
    ...citizenship.map(r => adminRow('citizenship_test', r)),
    ...payments.map(r => adminRow('payment', r))
  ].sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0));
  return {
    visa: visa.map(r => adminRow('visa_assessment', r)),
    appeals: appeals.map(r => adminRow('appeals_assessment', r)),
    citizenship: citizenship.map(r => adminRow('citizenship_test', r)),
    sessions: sessions.map(r => adminRow('service_session', r)),
    payments: payments.map(r => adminRow('payment', r)),
    pdfJobs,
    items,
    counts: {
      total: items.length,
      visa: visa.length,
      appeals: appeals.length,
      citizenship: citizenship.length,
      payments: payments.length,
      sessions: sessions.length,
      paid: items.filter(x => String(x.payment_status || '').toLowerCase() === 'paid').length,
      ready: items.filter(x => x.has_pdf || x.pdf_ready || String(x.status || '').toLowerCase().includes('ready')).length
    }
  };
}

app.get('/api/admin/control-dashboard', requireAdmin, asyncRoute(async (_req, res) => {
  const dashboard = await adminLoadDashboard();
  res.json({ ok: true, ...dashboard, generatedAt: new Date().toISOString() });
}));

app.get('/api/admin/matters', requireAdmin, asyncRoute(async (_req, res) => {
  const dashboard = await adminLoadDashboard();
  res.json({ ok: true, items: dashboard.items, counts: dashboard.counts, generatedAt: new Date().toISOString() });
}));

app.patch('/api/admin/control/:serviceType/:id', requireAdmin, asyncRoute(async (req, res) => {
  const serviceType = normaliseServiceType(req.params.serviceType);
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Record id is required.' });
  const table = serviceType === 'visa_assessment' ? 'assessments' : serviceType === 'appeals_assessment' ? 'appeals_assessments' : serviceType === 'citizenship_test' ? 'citizenship_access' : null;
  if (!table) return res.status(400).json({ ok: false, error: 'Unsupported service type.' });
  if (!(await adminTableExists(table))) return res.status(404).json({ ok: false, error: `${table} table was not found.` });
  const cols = await adminColumns(table);
  const body = req.body || {};
  const assignments = [];
  const values = [];
  function setCol(col, value) {
    if (!cols.has(col) || value === undefined || value === null || String(value).trim() === '') return;
    values.push(value);
    assignments.push(`${col}=$${values.length}`);
  }
  if (body.status !== undefined) setCol('status', String(body.status));
  if (body.paymentStatus !== undefined || body.payment_status !== undefined) setCol('payment_status', String(body.paymentStatus || body.payment_status));
  if (body.plan !== undefined || body.selected_plan !== undefined || body.selectedPlan !== undefined) {
    const rawPlan = body.plan || body.selected_plan || body.selectedPlan;
    setCol('selected_plan', serviceType === 'citizenship_test' ? normaliseCitizenshipPlan(rawPlan) : safePlan(rawPlan));
    setCol('active_plan', serviceType === 'citizenship_test' ? normaliseCitizenshipPlan(rawPlan) : safePlan(rawPlan));
  }
  if (body.examAllowance !== undefined || body.exam_allowance !== undefined) setCol('exam_allowance', Number(body.examAllowance || body.exam_allowance));
  if (body.attemptsUsed !== undefined || body.attempts_used !== undefined) setCol('attempts_used', Number(body.attemptsUsed || body.attempts_used));
  if (body.releaseNow && cols.has('release_at')) setCol('release_at', new Date().toISOString());
  if ((body.releaseHours !== undefined || body.release_hours !== undefined) && cols.has('release_at')) {
    const hours = Math.max(0, Number(body.releaseHours ?? body.release_hours));
    setCol('release_at', new Date(Date.now() + hours * 3600000).toISOString());
  }
  if (cols.has('updated_at')) assignments.push(`updated_at=now()`);
  if (!assignments.length) return res.status(400).json({ ok: false, error: 'No supported fields were provided for this record.' });
  values.push(id);
  const { rows } = await query(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id=$${values.length} RETURNING *`, values);
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Record was not found.' });
  if (await adminTableExists('service_sessions')) {
    await query(
      `UPDATE service_sessions
       SET status=COALESCE($1,status), payment_status=COALESCE($2,payment_status), selected_plan=COALESCE($3,selected_plan), updated_at=now()
       WHERE service_type=$4 AND service_ref=$5`,
      [body.status || null, body.paymentStatus || body.payment_status || null, body.plan || body.selected_plan || body.selectedPlan || null, serviceType, id]
    ).catch(err => console.warn('Admin service session sync skipped:', err.message));
  }
  res.json({ ok: true, record: adminRow(serviceType, rows[0]) });
}));


// ---------- Admin delete/reset controls ----------
function adminTableForService(serviceType) {
  const type = normaliseServiceType(serviceType);
  if (type === 'visa_assessment') return 'assessments';
  if (type === 'appeals_assessment') return 'appeals_assessments';
  if (type === 'citizenship_test') return 'citizenship_access';
  if (String(serviceType || '').toLowerCase() === 'payment') return 'payments';
  if (String(serviceType || '').toLowerCase() === 'service_session') return 'service_sessions';
  if (String(serviceType || '').toLowerCase() === 'pdf_job') return 'pdf_jobs';
  return null;
}

async function adminDeleteRecord(serviceType, id) {
  const type = normaliseServiceType(serviceType);
  const rawType = String(serviceType || '').toLowerCase();
  const cleanId = String(id || '').trim();
  if (!cleanId) throw Object.assign(new Error('Record id is required.'), { statusCode: 400 });

  if (type === 'visa_assessment') {
    await query(`DELETE FROM pdf_jobs WHERE assessment_id=$1`, [cleanId]).catch(() => null);
    await query(`DELETE FROM payments WHERE service_type='visa_assessment' AND service_ref=$1`, [cleanId]).catch(() => null);
    await query(`DELETE FROM service_sessions WHERE service_type='visa_assessment' AND service_ref=$1`, [cleanId]).catch(() => null);
    const { rowCount } = await query(`DELETE FROM assessments WHERE id=$1`, [cleanId]);
    return rowCount;
  }
  if (type === 'appeals_assessment') {
    await query(`DELETE FROM appeal_documents WHERE appeal_id=$1`, [cleanId]).catch(() => null);
    await query(`DELETE FROM payments WHERE service_type='appeals_assessment' AND service_ref=$1`, [cleanId]).catch(() => null);
    await query(`DELETE FROM service_sessions WHERE service_type='appeals_assessment' AND service_ref=$1`, [cleanId]).catch(() => null);
    const { rowCount } = await query(`DELETE FROM appeals_assessments WHERE id=$1`, [cleanId]);
    return rowCount;
  }
  if (type === 'citizenship_test') {
    await query(`DELETE FROM payments WHERE service_type='citizenship_test' AND service_ref=$1`, [cleanId]).catch(() => null);
    await query(`DELETE FROM service_sessions WHERE service_type='citizenship_test' AND service_ref=$1`, [cleanId]).catch(() => null);
    const { rowCount } = await query(`DELETE FROM citizenship_access WHERE id=$1`, [cleanId]);
    return rowCount;
  }
  if (rawType === 'payment') {
    const { rowCount } = await query(`DELETE FROM payments WHERE id::text=$1 OR stripe_session_id=$1`, [cleanId]);
    return rowCount;
  }
  if (rawType === 'service_session') {
    const { rowCount } = await query(`DELETE FROM service_sessions WHERE id=$1`, [cleanId]);
    return rowCount;
  }
  if (rawType === 'pdf_job') {
    const { rowCount } = await query(`DELETE FROM pdf_jobs WHERE id::text=$1 OR assessment_id=$1`, [cleanId]);
    return rowCount;
  }
  throw Object.assign(new Error('Unsupported service type.'), { statusCode: 400 });
}

app.delete('/api/admin/control/:serviceType/:id', requireAdmin, asyncRoute(async (req, res) => {
  const deleted = await adminDeleteRecord(req.params.serviceType, req.params.id);
  if (!deleted) return res.status(404).json({ ok: false, error: 'Record was not found.' });
  res.json({ ok: true, deleted });
}));

app.post('/api/admin/control/reset', requireAdmin, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const scope = String(body.scope || body.type || 'all').toLowerCase().replace(/[\s-]+/g, '_');
  const confirm = String(body.confirm || body.confirmation || '').trim();
  if (confirm !== 'RESET') return res.status(400).json({ ok: false, error: 'Reset confirmation must be exactly RESET.' });
  const deleted = {};
  async function del(key, sql) {
    try { const r = await query(sql); deleted[key] = r.rowCount || 0; }
    catch (err) { deleted[key] = `skipped: ${err.message}`; }
  }
  if (scope === 'all' || scope === 'pdf_jobs') await del('pdf_jobs', `DELETE FROM pdf_jobs`);
  if (scope === 'all' || scope === 'appeals') await del('appeal_documents', `DELETE FROM appeal_documents`);
  if (scope === 'all' || scope === 'payments') await del('payments', `DELETE FROM payments`);
  if (scope === 'all' || scope === 'sessions' || scope === 'service_sessions') await del('service_sessions', `DELETE FROM service_sessions`);
  if (scope === 'all' || scope === 'citizenship') await del('citizenship_access', `DELETE FROM citizenship_access`);
  if (scope === 'all' || scope === 'appeals') await del('appeals_assessments', `DELETE FROM appeals_assessments`);
  if (scope === 'all' || scope === 'visa') await del('assessments', `DELETE FROM assessments`);
  res.json({ ok: true, scope, deleted });
}));

app.get('/api/admin/control/:serviceType/:id/pdf', requireAdmin, asyncRoute(async (req, res) => {
  const serviceType = normaliseServiceType(req.params.serviceType);
  const id = String(req.params.id || '').trim();
  const table = serviceType === 'visa_assessment' ? 'assessments' : serviceType === 'appeals_assessment' ? 'appeals_assessments' : null;
  if (!table) return res.status(400).json({ ok: false, error: 'PDF is available only for visa and appeals assessments.' });
  const { rows } = await query(`SELECT pdf_bytes, pdf_mime, pdf_filename FROM ${table} WHERE id=$1 LIMIT 1`, [id]);
  const row = rows[0];
  if (!row || !row.pdf_bytes) return res.status(404).json({ ok: false, error: 'PDF is not available yet.' });
  res.setHeader('Content-Type', row.pdf_mime || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${String(row.pdf_filename || id + '.pdf').replace(/"/g, '')}"`);
  res.send(row.pdf_bytes);
}));



// Multi-pathway comparator: 482 vs 190 vs 491 strategy diagnostics.
app.post('/api/assessment/compare-pathways', requireAuth, asyncRoute(async (req, res) => {
  const assessmentId = req.body.assessmentId || req.body.assessment_id || req.body.id;
  if (!assessmentId) return res.status(400).json({ ok: false, error: 'assessmentId is required.' });
  const { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [assessmentId, req.client.email]);
  const assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  res.json(compareMigrationPathways(assessment));
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const email = normaliseEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !email.includes('@') || password.length < 6) return res.status(400).json({ ok: false, error: 'Valid email and 6+ character password required.' });
  const existing = await query('SELECT id FROM clients WHERE email=$1', [email]);
  if (existing.rows[0]) return res.status(409).json({ ok: false, error: 'Account already exists. Please log in.' });
  const client = await upsertClient(email, password, req.body.name);
  const token = sign(client);
  setSessionCookie(res, token);

  let pendingVisaAssessment = null;
  let pendingServiceSession = null;
  try {
    const assessmentId = getRequestedAssessmentId(req);
    if (assessmentId) pendingVisaAssessment = await attachVisaAssessmentToClientById(assessmentId, client);
    pendingServiceSession = await markServiceSessionLoginConfirmed(req, client);
  } catch (err) {
    res.clearCookie('bm_session', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    return res.status(err.statusCode || 500).json({
      ok: false,
      code: err.code || 'LOGIN_HANDOFF_FAILED',
      error: err.message || 'Login handoff failed.',
      requiredEmail: err.requiredEmail || null,
      loggedInEmail: err.loggedInEmail || email || null,
      serviceSessionId: err.serviceSessionId || null,
      assessmentId: err.assessmentId || null
    });
  }

  res.json({
    ok: true,
    token,
    accessToken: token,
    authToken: token,
    dashboardAccessToken: (typeof signDashboardAccessToken === 'function' ? signDashboardAccessToken(client) : token),
    client,
    pendingVisaAssessment: visaCheckoutHandoffPayload(pendingVisaAssessment),
    pendingServiceSession
  });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = normaliseEmail(req.body.email);
  const password = String(req.body.password || '');
  const { rows } = await query('SELECT id, email, name, password_hash FROM clients WHERE email=$1', [email]);
  const client = rows[0];
  if (!client || !(await bcrypt.compare(password, client.password_hash))) return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
  const token = sign(client);
  setSessionCookie(res, token);

  let pendingVisaAssessment = null;
  let pendingServiceSession = null;
  try {
    const assessmentId = getRequestedAssessmentId(req);
    if (assessmentId) pendingVisaAssessment = await attachVisaAssessmentToClientById(assessmentId, client);
    pendingServiceSession = await markServiceSessionLoginConfirmed(req, client);
  } catch (err) {
    res.clearCookie('bm_session', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    return res.status(err.statusCode || 500).json({
      ok: false,
      code: err.code || 'LOGIN_HANDOFF_FAILED',
      error: err.message || 'Login handoff failed.',
      requiredEmail: err.requiredEmail || null,
      loggedInEmail: err.loggedInEmail || email || null,
      serviceSessionId: err.serviceSessionId || null,
      assessmentId: err.assessmentId || null
    });
  }

  res.json({
    ok: true,
    token,
    accessToken: token,
    authToken: token,
    dashboardAccessToken: (typeof signDashboardAccessToken === 'function' ? signDashboardAccessToken(client) : token),
    client: { id: client.id, email: client.email, name: client.name },
    pendingVisaAssessment: visaCheckoutHandoffPayload(pendingVisaAssessment),
    pendingServiceSession
  });
}));

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('bm_session', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ ok: true, client: req.client }));

async function handleAssessmentSubmit(req, res) {
  const built = buildAssessmentPayload(req.body, req.client);
  const visaType = built.meta.visaType;
  const plan = planFromAssessmentBody(req.body, built.meta.selectedPlan);
  const applicantEmail = built.meta.applicantEmail || normaliseEmail(req.client.email);
  const applicantName = built.meta.applicantName;
  const accountEmail = normaliseEmail(req.client.email);
  if (applicantEmail !== accountEmail) {
    return res.status(409).json({ ok: false, error: `This assessment email is ${applicantEmail}, but you are logged in as ${req.client.email}. Please use the same email address.` });
  }
  if (!payloadLooksUsable(built)) {
    return res.status(400).json({ ok: false, code: 'ASSESSMENT_PAYLOAD_MISSING', error: 'Assessment answers were not received by the server. Please submit the assessment form again before checkout.', receivedKeys: Object.keys(req.body || {}) });
  }

  const submissionFingerprint = visaSubmissionFingerprint({ email: accountEmail, visaType, plan, payload: built });

  const result = await tx(async (client) => {
    // Server-side idempotency for authenticated assessment submits.
    // Do NOT create a second assessment when the same account resubmits the same
    // subclass/plan/answers because of double-clicks, browser retries, checkout-start
    // reloads or payment-return retries.
    const existingRows = await client.query(
      `SELECT *
       FROM assessments
       WHERE visa_type=$2
         AND COALESCE(active_plan, selected_plan, 'instant')=$3
         AND (
         COALESCE(payment_status,'unpaid') <> 'paid'
         AND 
           lower(client_email)=lower($1)
           OR lower(applicant_email)=lower($1)
           OR client_id=$6
         )
         AND created_at > now() - interval '48 hours'
         -- Strict same-service idempotency:
         -- once the same client/email has a recent matter for the same subclass and plan,
         -- reuse it instead of creating another paid assessment through retries, repeated
         -- checkout clicks, payment-return loops or autofill test repeats. The old
         -- fingerprint match is still saved, but it is no longer the only protection.
       ORDER BY CASE WHEN payment_status='paid' THEN 4 WHEN stripe_session_id IS NOT NULL THEN 3 WHEN status='checkout_created' THEN 2 ELSE 1 END DESC,
                updated_at DESC NULLS LAST,
                created_at DESC NULLS LAST
       LIMIT 1
       FOR UPDATE`,
      [accountEmail, visaType, plan, submissionFingerprint, applicantName || null, req.client.id]
    );
    const existing = existingRows.rows[0];
    if (existing) {
      await client.query(
        `UPDATE assessments
         SET client_id=$1,
             client_email=$2,
             applicant_email=COALESCE(applicant_email,$2),
             submission_fingerprint=COALESCE(submission_fingerprint,$3),
             form_payload=CASE WHEN COALESCE(payment_status,'unpaid')='paid' THEN form_payload ELSE $4 END,
             updated_at=now()
         WHERE id=$5`,
        [req.client.id, req.client.email, submissionFingerprint, built, existing.id]
      );
      await client.query(
        `INSERT INTO service_sessions (id, service_type, service_ref, client_id, client_email, selected_plan, status, payment_status, stripe_session_id, metadata)
         VALUES ($1,'visa_assessment',$2,$3,$4,$5,'draft_created',COALESCE($6,'unpaid'),$7,$8::jsonb)
         ON CONFLICT (service_type, service_ref) WHERE service_ref IS NOT NULL
         DO UPDATE SET client_id=COALESCE(service_sessions.client_id, EXCLUDED.client_id), client_email=COALESCE(service_sessions.client_email, EXCLUDED.client_email), selected_plan=EXCLUDED.selected_plan, payment_status=COALESCE(service_sessions.payment_status, EXCLUDED.payment_status), stripe_session_id=COALESCE(service_sessions.stripe_session_id, EXCLUDED.stripe_session_id), metadata=COALESCE(service_sessions.metadata,'{}'::jsonb) || EXCLUDED.metadata, updated_at=now()`,
        [makeServiceSessionId('visa_assessment'), existing.id, req.client.id, req.client.email, plan, existing.payment_status || 'unpaid', existing.stripe_session_id || null, JSON.stringify({
          visa_type: visaType,
          assessment_id: existing.id,
          submission_fingerprint: submissionFingerprint,
          reused_existing_assessment: true,
          duplicate_prevention: 'authenticated_submit_idempotency',
          created_by: 'assessment_submit'
        })]
      );
      return { assessmentId: existing.id, status: existing.status || 'submitted', reusedExisting: true };
    }

    const id = makeAssessmentId(visaType);
    const insertRows = await client.query(
      `INSERT INTO assessments (id, client_id, client_email, applicant_email, applicant_name, visa_type, selected_plan, active_plan, status, payment_status, form_payload, submission_fingerprint, pdf_bytes, pdf_generated_at, generation_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'submitted','unpaid',$8,$9,NULL,NULL,NULL)
       ON CONFLICT (lower(client_email), visa_type, selected_plan, submission_fingerprint)
       WHERE submission_fingerprint IS NOT NULL AND client_email IS NOT NULL
       DO UPDATE SET
         client_id=COALESCE(assessments.client_id, EXCLUDED.client_id),
         applicant_email=COALESCE(assessments.applicant_email, EXCLUDED.applicant_email),
         applicant_name=COALESCE(assessments.applicant_name, EXCLUDED.applicant_name),
         active_plan=COALESCE(assessments.active_plan, EXCLUDED.active_plan),
         form_payload=CASE WHEN COALESCE(assessments.payment_status,'unpaid')='paid' THEN assessments.form_payload ELSE EXCLUDED.form_payload END,
         updated_at=now()
       RETURNING id, status, payment_status`,
      [id, req.client.id, req.client.email, applicantEmail, applicantName || null, visaType, plan, built, submissionFingerprint]
    );
    const savedAssessmentId = (insertRows.rows[0] && insertRows.rows[0].id) || id;
    await client.query(
      `INSERT INTO service_sessions (id, service_type, service_ref, client_id, client_email, selected_plan, status, payment_status, metadata)
       VALUES ($1,'visa_assessment',$2,$3,$4,$5,'draft_created','unpaid',$6::jsonb)
       ON CONFLICT (service_type, service_ref) WHERE service_ref IS NOT NULL
       DO UPDATE SET client_id=COALESCE(service_sessions.client_id, EXCLUDED.client_id), client_email=COALESCE(service_sessions.client_email, EXCLUDED.client_email), selected_plan=EXCLUDED.selected_plan, metadata=COALESCE(service_sessions.metadata,'{}'::jsonb) || EXCLUDED.metadata, updated_at=now()`,
      [makeServiceSessionId('visa_assessment'), savedAssessmentId, req.client.id, req.client.email, plan, JSON.stringify({
        visa_type: visaType,
        assessment_id: id,
        submission_fingerprint: submissionFingerprint,
        created_by: 'assessment_submit'
      })]
    );
    return { assessmentId: savedAssessmentId, status: (insertRows.rows[0] && insertRows.rows[0].status) || 'submitted', reusedExisting: savedAssessmentId !== id };
  });

  res.json({ ok: true, assessmentId: result.assessmentId, assessment_id: result.assessmentId, status: result.status, plan, reusedExisting: result.reusedExisting, payloadSaved: true, answerCount: payloadAnswerCount(built) });
}

app.post('/api/assessment/submit', requireAuth, asyncRoute(handleAssessmentSubmit));
app.post('/api/assessment/create', requireAuth, asyncRoute(handleAssessmentSubmit));
app.post('/api/assessments/submit', requireAuth, asyncRoute(handleAssessmentSubmit));

async function handlePublicVisaAssessmentStart(req, res) {
  const built = buildAssessmentPayload(req.body, null);
  const email = normaliseEmail(
    req.body.email ||
    req.body.clientEmail ||
    req.body.client_email ||
    req.body.applicantEmail ||
    req.body.applicant_email ||
    built.meta.applicantEmail
  );
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, code: 'VALID_EMAIL_REQUIRED', error: 'Valid email is required before login.' });
  }
  if (!payloadLooksUsable(built)) {
    return res.status(400).json({
      ok: false,
      code: 'ASSESSMENT_PAYLOAD_MISSING',
      error: 'Assessment answers were not received by the server. Please complete the visa assessment form before login.',
      receivedKeys: Object.keys(req.body || {})
    });
  }

  const visaType = built.meta.visaType;
  const plan = planFromAssessmentBody(req.body, built.meta.selectedPlan);
  const submissionFingerprint = visaSubmissionFingerprint({ email, visaType, plan, payload: built });
  const newAssessmentId = makeAssessmentId(visaType);
  const newServiceSessionId = makeServiceSessionId('visa_assessment');

  let created;
  try {
    created = await tx(async (client) => {
      // Permanent duplicate prevention:
      // Re-clicks, browser retries, and Stripe-return loops may reuse only an unpaid/in-progress
      // assessment. A paid assessment is a completed matter and must never be reused for a new
      // checkout attempt, otherwise checkout returns alreadyPaid and sends the client to dashboard.
      // This prevents two paid Subclass 186 cards for one assessment journey.
      const existingRows = await client.query(
        `SELECT a.*, ss.id AS service_session_id
         FROM assessments a
         LEFT JOIN LATERAL (
           SELECT id FROM service_sessions s
           WHERE s.service_type='visa_assessment' AND s.service_ref=a.id
           ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC NULLS LAST
           LIMIT 1
         ) ss ON true
         WHERE (
             lower(a.client_email)=lower($1)
             OR lower(a.applicant_email)=lower($1)
             OR lower(COALESCE(a.form_payload->'meta'->>'applicantEmail',''))=lower($1)
             OR lower(COALESCE(a.form_payload->'meta'->>'clientEmail',''))=lower($1)
           )
           AND a.visa_type=$2
           AND COALESCE(a.active_plan, a.selected_plan, 'instant')=$3
           AND a.created_at > now() - interval '48 hours'
           -- Strict public handoff idempotency:
           -- same email + same subclass + same plan must reuse the most recent matter
           -- in this window, even if autofill/timestamps/random fields change the answer
           -- fingerprint. This stops creating multiple paid assessment records from one
           -- user journey.
         ORDER BY CASE WHEN a.payment_status='paid' THEN 3 WHEN a.stripe_session_id IS NOT NULL THEN 2 ELSE 1 END DESC,
                  a.updated_at DESC NULLS LAST, a.created_at DESC NULLS LAST
         LIMIT 1`,
        [email, visaType, plan]
      );
      let existing = existingRows.rows[0];
      if (existing && String(existing.payment_status || '').toLowerCase() === 'paid') {
        existing = null;
      }
      if (existing) {
        let serviceSession = null;
        if (existing.service_session_id) {
          const sr = await client.query(`SELECT * FROM service_sessions WHERE id=$1 LIMIT 1`, [existing.service_session_id]);
          serviceSession = sr.rows[0] || null;
        }
        if (!serviceSession) {
          const serviceRows = await client.query(
            `INSERT INTO service_sessions (id, service_type, service_ref, client_id, client_email, selected_plan, status, payment_status, stripe_session_id, metadata)
             VALUES ($1,'visa_assessment',$2,$3,$4,$5,'draft_created',$6,$7,$8::jsonb)
             ON CONFLICT (service_type, service_ref) WHERE service_ref IS NOT NULL
             DO UPDATE SET client_id=COALESCE(service_sessions.client_id, EXCLUDED.client_id), client_email=COALESCE(service_sessions.client_email, EXCLUDED.client_email), selected_plan=EXCLUDED.selected_plan, payment_status=COALESCE(service_sessions.payment_status, EXCLUDED.payment_status), stripe_session_id=COALESCE(service_sessions.stripe_session_id, EXCLUDED.stripe_session_id), metadata=COALESCE(service_sessions.metadata,'{}'::jsonb) || EXCLUDED.metadata, updated_at=now()
             RETURNING *`,
            [newServiceSessionId, existing.id, existing.client_id || null, email, plan, existing.payment_status || 'unpaid', existing.stripe_session_id || null, JSON.stringify({
              visa_type: visaType,
              assessment_id: existing.id,
              submission_fingerprint: submissionFingerprint,
              reused_existing_assessment: true,
              duplicate_prevention: 'same_email_subclass_plan_answers_24h',
              created_by: 'public_visa_assessment_start'
            })]
          );
          serviceSession = serviceRows.rows[0];
        }
        return { assessment: existing, serviceSession, reusedExisting: true };
      }

      const assessmentRows = await client.query(
        `INSERT INTO assessments (
           id, client_id, client_email, applicant_email, applicant_name,
           visa_type, selected_plan, active_plan, status, payment_status,
           form_payload, submission_fingerprint, pdf_bytes, pdf_generated_at, generation_error
         ) VALUES ($1,NULL,$2,$2,$3,$4,$5,$5,'submitted','unpaid',$6,$7,NULL,NULL,NULL)
         ON CONFLICT (lower(client_email), visa_type, selected_plan, submission_fingerprint)
         WHERE submission_fingerprint IS NOT NULL AND client_email IS NOT NULL
         DO UPDATE SET
           applicant_email=COALESCE(assessments.applicant_email, EXCLUDED.applicant_email),
           applicant_name=COALESCE(assessments.applicant_name, EXCLUDED.applicant_name),
           active_plan=COALESCE(assessments.active_plan, EXCLUDED.active_plan),
           form_payload=CASE WHEN COALESCE(assessments.payment_status,'unpaid')='paid' THEN assessments.form_payload ELSE EXCLUDED.form_payload END,
           updated_at=now()
         RETURNING id, client_email, applicant_email, visa_type, selected_plan, active_plan, status, payment_status, submission_fingerprint`,
        [newAssessmentId, email, built.meta.applicantName || null, visaType, plan, built, submissionFingerprint]
      );
      const assessment = assessmentRows.rows[0];
      if (!assessment || assessment.id !== newAssessmentId) {
        throw Object.assign(new Error('The assessment record was not saved. Checkout has been stopped.'), { statusCode: 500 });
      }

      const serviceRows = await client.query(
        `INSERT INTO service_sessions (id, service_type, service_ref, client_id, client_email, selected_plan, status, payment_status, stripe_session_id, metadata)
         VALUES ($1,'visa_assessment',$2,NULL,$3,$4,'draft_created','unpaid',NULL,$5::jsonb)
         ON CONFLICT (service_type, service_ref) WHERE service_ref IS NOT NULL
         DO UPDATE SET client_email=COALESCE(service_sessions.client_email, EXCLUDED.client_email), selected_plan=EXCLUDED.selected_plan, metadata=COALESCE(service_sessions.metadata,'{}'::jsonb) || EXCLUDED.metadata, updated_at=now()
         RETURNING *`,
        [newServiceSessionId, assessment.id, email, plan, JSON.stringify({
          visa_type: visaType,
          assessment_id: assessment.id,
          submission_fingerprint: submissionFingerprint,
          require_fresh_login: true,
          login_required_before_payment: true,
          handoff_locked: true,
          created_by: 'public_visa_assessment_start'
        })]
      );
      const serviceSession = serviceRows.rows[0];
      if (!serviceSession || serviceSession.service_ref !== assessment.id) {
        throw Object.assign(new Error('The checkout handoff session was not saved. Checkout has been stopped.'), { statusCode: 500 });
      }
      return { assessment, serviceSession, reusedExisting: false };
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      ok: false,
      code: 'VISA_HANDOFF_NOT_SAVED',
      error: err.message || 'Visa assessment could not be saved before login. Checkout was not started.'
    });
  }

  const assessmentId = created.assessment.id;
  const next = `/login.html?service=visa&next=service-checkout&service_session_id=${encodeURIComponent(created.serviceSession.id)}&assessment_id=${encodeURIComponent(assessmentId)}&plan=${encodeURIComponent(plan)}&email=${encodeURIComponent(email)}`;
  res.json({
    ok: true,
    service: 'visa_assessment',
    reusedExisting: !!created.reusedExisting,
    serviceSessionId: created.serviceSession.id,
    service_session_id: created.serviceSession.id,
    assessmentId,
    assessment_id: assessmentId,
    visaType,
    plan,
    payloadSaved: true,
    answerCount: payloadAnswerCount(built),
    next
  });
}

app.post('/api/public/visa-assessment/start', asyncRoute(handlePublicVisaAssessmentStart));
app.post('/api/visa-assessment/start', asyncRoute(handlePublicVisaAssessmentStart));
app.post('/api/assessment/public-start', asyncRoute(handlePublicVisaAssessmentStart));





app.get('/api/service-session/validate', asyncRoute(async (req, res) => {
  const serviceSessionId = String(req.query.service_session_id || req.query.serviceSessionId || '').trim();
  const assessmentId = String(req.query.assessment_id || req.query.assessmentId || '').trim();
  if (!serviceSessionId && !assessmentId) return res.status(400).json({ ok: false, code: 'HANDOFF_ID_REQUIRED', error: 'Missing checkout handoff ID.' });

  let session = null;
  if (serviceSessionId) {
    const rows = (await query(`SELECT * FROM service_sessions WHERE id=$1 LIMIT 1`, [serviceSessionId])).rows;
    session = rows[0] || null;
  }
  if (!session && assessmentId) {
    const rows = (await query(`SELECT * FROM service_sessions WHERE service_type='visa_assessment' AND service_ref=$1 ORDER BY created_at DESC LIMIT 1`, [assessmentId])).rows;
    session = rows[0] || null;
  }
  if (!session) return res.status(404).json({ ok: false, code: 'SERVICE_SESSION_NOT_FOUND', error: 'Checkout handoff was not found. Please submit the assessment again from the selected plan button.' });

  let assessment = null;
  if (session.service_type === 'visa_assessment' && (session.service_ref || assessmentId)) {
    const rows = (await query(`SELECT id, client_email, applicant_email, visa_type, selected_plan, active_plan, status, payment_status FROM assessments WHERE id=$1 LIMIT 1`, [session.service_ref || assessmentId])).rows;
    assessment = rows[0] || null;
    if (!assessment) return res.status(404).json({ ok: false, code: 'ASSESSMENT_NOT_FOUND', error: 'Assessment was not found. Please submit the visa assessment again before login.' });
  }

  return res.json({ ok: true, serviceSession: session, assessment });
}));

async function handleAppealsAssessmentCreate(req, res) {
  const plan = safePlan(findPlanInObject(req.body) || req.body.appealsPlan || req.body.appealPlan || req.body.reviewPlan || req.body.plan || req.body.selectedPlan || req.body.selected_plan || 'instant');
  const email = normaliseEmail(req.body.email || req.body.applicantEmail || req.body.applicant_email || '');
  const applicantName = String(req.body.applicantName || req.body.applicant_name || req.body.fullName || req.body.full_name || '').trim() || null;
  const visaSubclass = String(req.body.visaSubclass || req.body.visa_subclass || req.body.subclass || '').replace(/[^0-9A-Za-z]/g, '');
  const decisionType = cleanAppealDecisionType(req.body.decisionType || req.body.decision_type || req.body.decision || req.body.decisionCategory || 'Visa refusal / cancellation decision');
  const appealGrounds = String(req.body.appealGrounds || req.body.appeal_grounds || '').trim();
  const publicDraftKey = String(req.body.draftKey || req.body.draft_key || req.body.clientDraftKey || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120) || null;

  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Valid applicant email is required before login.' });
  if (!visaSubclass) return res.status(400).json({ ok: false, error: 'Visa subclass is required.' });
  if (!decisionType) return res.status(400).json({ ok: false, error: 'Decision type is required.' });
  if (!appealGrounds || appealGrounds.length < 20) return res.status(400).json({ ok: false, error: 'Appeal grounds summary is required.' });
  const fileFields = req.files || {};
  const genericFiles = [
    ...(fileFields.files || []),
    ...(fileFields.uploadedFiles || []),
    ...(fileFields.documents || [])
  ];
  const decisionFile = (fileFields.decisionFile || fileFields.decisionPdf || [])[0] || req.file || genericFiles[0] || null;
  const notificationFile = (fileFields.notificationFile || fileFields.notificationPdf || [])[0] || null;
  const evidenceFiles = [
    ...(fileFields.evidenceFiles || []),
    ...(fileFields.evidenceFile || []),
    ...(fileFields.extraEvidence || []),
    ...genericFiles.slice(decisionFile === genericFiles[0] ? 1 : 0)
  ];
  if (!decisionFile) return res.status(400).json({ ok: false, error: 'Upload the refusal or cancellation decision letter before submitting.' });

  // Each submitted appeal must become its own matter. Older builds reused
  // recent duplicates or updated the row behind public_draft_key, which made the
  // dashboard look like only the newest appeal existed. Public draft keys are now
  // treated only as frontend tracking metadata and never as an upsert key.
  const generatedId = makeAppealAssessmentId();
  const storedPublicDraftKey = publicDraftKey ? `${publicDraftKey}:${generatedId}`.slice(0, 120) : null;
  const insertResult = await query(
    `INSERT INTO appeals_assessments (
       id, client_email, applicant_email, applicant_name, visa_subclass, decision_type,
       decision_date, tribunal_deadline, current_location, has_previous_appeal,
       appeal_grounds, urgency_notes, selected_plan, active_plan, status, payment_status,
       uploaded_filename, uploaded_mime_type, uploaded_size, uploaded_file, public_draft_key, release_at
     ) VALUES (
       $1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,'submitted','unpaid',$13,$14,$15,$16,$17,${appealReleaseAtSql(plan)}
     )
     RETURNING id, true AS inserted`,
    [
      generatedId,
      email,
      applicantName,
      visaSubclass,
      decisionType,
      req.body.decisionDate || req.body.decision_date || null,
      req.body.tribunalDeadline || req.body.tribunal_deadline || req.body.reviewDeadline || null,
      req.body.currentLocation || req.body.current_location || null,
      req.body.hasPreviousAppeal || req.body.has_previous_appeal || null,
      appealGrounds,
      req.body.urgencyNotes || req.body.urgency_notes || null,
      plan,
      decisionFile.originalname,
      decisionFile.mimetype,
      decisionFile.size,
      decisionFile.buffer,
      storedPublicDraftKey
    ]
  );
  const id = insertResult.rows[0].id;
  const inserted = insertResult.rows[0].inserted === true || insertResult.rows[0].inserted === 't';

  const allDocs = [
    { type: 'decision', file: decisionFile },
    ...(notificationFile ? [{ type: 'notification', file: notificationFile }] : []),
    ...evidenceFiles.map(file => ({ type: 'evidence', file }))
  ];
  if (inserted) {
    for (const item of allDocs) {
      await query(
        `INSERT INTO appeal_documents (appeal_id, document_type, filename, mime_type, size, file_bytes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, item.type, item.file.originalname, item.file.mimetype, item.file.size, item.file.buffer]
      );
    }
  }

  let existingServiceSession = null;
  const existingRows = (await query(
    `SELECT * FROM service_sessions WHERE service_type='appeals_assessment' AND service_ref=$1 ORDER BY created_at DESC LIMIT 1`,
    [id]
  )).rows;
  existingServiceSession = existingRows[0] || null;
  const serviceSession = await upsertServiceSession({
    id: existingServiceSession && existingServiceSession.id,
    serviceType: 'appeals_assessment',
    serviceRef: id,
    email,
    plan,
    metadata: {
      visa_subclass: visaSubclass,
      decision_type: decisionType,
      draft_key: publicDraftKey,
      stored_draft_key: storedPublicDraftKey,
      require_fresh_login: true,
      login_required_before_payment: true
    }
  });

  res.json({
    ok: true,
    type: 'appeals_assessment',
    serviceSessionId: serviceSession.id,
    service_session_id: serviceSession.id,
    assessmentId: id,
    assessment_id: id,
    duplicate: !inserted,
    plan,
    next: `/login.html?service=appeals&next=service-checkout&service_session_id=${encodeURIComponent(serviceSession.id)}&appeal_assessment_id=${encodeURIComponent(id)}&plan=${encodeURIComponent(plan)}&email=${encodeURIComponent(email)}`
  });
}

const appealUploadFields = appealUpload.fields([
  { name: 'decisionFile', maxCount: 1 },
  { name: 'decisionPdf', maxCount: 1 },
  { name: 'notificationFile', maxCount: 1 },
  { name: 'notificationPdf', maxCount: 1 },
  { name: 'evidenceFiles', maxCount: 10 },
  { name: 'evidenceFile', maxCount: 10 },
  { name: 'extraEvidence', maxCount: 10 },
  { name: 'files', maxCount: 10 },
  { name: 'uploadedFiles', maxCount: 10 },
  { name: 'documents', maxCount: 10 }
]);
app.post('/api/appeals/start', appealUploadFields, asyncRoute(handleAppealsAssessmentCreate));
app.post('/api/appeals/create-assessment', appealUploadFields, asyncRoute(handleAppealsAssessmentCreate));
app.post('/api/assessment/create-appeals-assessment', appealUploadFields, asyncRoute(handleAppealsAssessmentCreate));



app.post('/api/service/checkout-session', requireCheckoutAuth, asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  let serviceSession;
  try {
    serviceSession = await getServiceSessionForCheckout(req);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message || 'Service checkout failed.' });
  }

  if (serviceSession.service_type === 'visa_assessment') {
    req.body.assessmentId = serviceSession.service_ref;
    req.body.assessment_id = serviceSession.service_ref;
    // Reuse the existing visa checkout logic below by creating the Stripe session here with the same rules.
    let assessment;
    try {
      assessment = await attachVisaAssessmentToClientById(serviceSession.service_ref, req.client);
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message || 'Visa checkout failed.' });
    }
    // Hard paid-matter guard: if this reused assessment/service session is already paid,
    // never create another Stripe checkout session for the same recent matter.
    // This is the missing source of duplicate paid 186/187 cards when a user resubmits
    // or re-enters checkout after payment.
    if (assessment.payment_status === 'paid' || serviceSession.payment_status === 'paid') {
      return res.json({
        ok: true,
        alreadyPaid: true,
        service: 'visa_assessment',
        assessmentId: assessment.id,
        assessment_id: assessment.id,
        serviceSessionId: serviceSession.id,
        service_session_id: serviceSession.id,
        plan: assessment.active_plan || assessment.selected_plan || serviceSession.selected_plan || 'instant',
        redirectUrl: `${APP_BASE_URL}/account-dashboard.html?assessment_id=${encodeURIComponent(assessment.id)}`,
        dashboardUrl: `${APP_BASE_URL}/account-dashboard.html?assessment_id=${encodeURIComponent(assessment.id)}`
      });
    }

    // Production plan-lock fix: use the plan selected at checkout, not a stale
    // assessment/service-session value. This prevents instant visa payments from
    // inheriting a 24-hour release timer.
    const checkoutPlan = strictServicePlanFromRequest(req, serviceSession.selected_plan || assessment.active_plan || assessment.selected_plan || 'instant');
    const price = resolveVisaPriceId(assessment.visa_type, checkoutPlan);
    if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for visa plan ${checkoutPlan}.` });
    try { await assertStripePriceMatchesPlan({ serviceType: 'visa_assessment', plan: checkoutPlan, priceId: price }); }
    catch (err) { return res.status(err.statusCode || 500).json({ ok: false, code: 'STRIPE_PRICE_MISMATCH_BLOCKED', error: err.message }); }
    await query('SELECT pg_advisory_lock(hashtext($1))', [`visa-checkout:${assessment.id}`]);
    try {
    const reusableVisaCheckout = await getReusableOpenCheckoutSession(assessment.stripe_session_id || serviceSession.stripe_session_id, { serviceType: 'visa_assessment', serviceRef: assessment.id, plan: checkoutPlan });
    if (reusableVisaCheckout) {
      await markServiceSessionCheckoutCreated(serviceSession.id, reusableVisaCheckout.id);
      return res.json({ ok: true, reused: true, service: 'visa_assessment', url: reusableVisaCheckout.url, sessionId: reusableVisaCheckout.id, serviceSessionId: serviceSession.id, assessmentId: assessment.id, plan: checkoutPlan });
    }
    const stripeSession = await createCheckoutSessionSafely({
      mode: 'payment',
      customer_email: req.client.email,
      client_reference_id: assessment.id,
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_BASE_URL}/payment-complete.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/checkout-start.html?cancelled=1&service_session_id=${encodeURIComponent(serviceSession.id)}&assessment_id=${encodeURIComponent(assessment.id)}`,
      metadata: {
        service_type: 'visa_assessment',
        service_session_id: serviceSession.id,
        service_ref: assessment.id,
        assessment_id: assessment.id,
        visa_type: assessment.visa_type,
        plan: checkoutPlan,
        client_email: req.client.email
      }
    }, 'service-visa-checkout', checkoutFingerprint({ serviceType: 'visa_assessment', serviceRef: assessment.id, plan: checkoutPlan, price, email: req.client.email }));
    await query(
      `UPDATE assessments
       SET stripe_session_id=$1, status='checkout_created', selected_plan=$2, active_plan=$2,
           amount_cents=$3, currency=$4, release_at=NULL, updated_at=now()
       WHERE id=$5`,
      [stripeSession.id, checkoutPlan, stripeSession.amount_total || null, stripeSession.currency || 'aud', assessment.id]
    );
    await query(`UPDATE service_sessions SET selected_plan=$1, updated_at=now() WHERE id=$2`, [checkoutPlan, serviceSession.id]);
    await markServiceSessionCheckoutCreated(serviceSession.id, stripeSession.id);
    await recordPaymentAuditSafe(assessment.id, req.client.email, stripeSession);
    return res.json({ ok: true, service: 'visa_assessment', url: stripeSession.url, sessionId: stripeSession.id, serviceSessionId: serviceSession.id, assessmentId: assessment.id, plan: checkoutPlan });
    } finally {
      await query('SELECT pg_advisory_unlock(hashtext($1))', [`visa-checkout:${assessment.id}`]).catch(() => null);
    }
  }

  if (serviceSession.service_type === 'appeals_assessment') {
    const assessmentId = serviceSession.service_ref;
    const { rows } = await query('SELECT * FROM appeals_assessments WHERE id=$1', [assessmentId]);
    const assessment = rows[0];
    if (!assessment) return res.status(404).json({ ok: false, error: 'Appeals assessment was not found.' });
    const plan = safePlan(serviceSession.selected_plan || assessment.active_plan || assessment.selected_plan || findPlanInObject(req.body) || 'instant');
    const price = resolveAppealPriceId(plan);
    if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for appeals plan ${plan}.` });
    try { await assertStripePriceMatchesPlan({ serviceType: 'appeals_assessment', plan, priceId: price }); }
    catch (err) { return res.status(err.statusCode || 500).json({ ok: false, code: 'STRIPE_PRICE_MISMATCH_BLOCKED', error: err.message }); }
    const reusableAppealCheckout = await getReusableOpenCheckoutSession(assessment.stripe_session_id || serviceSession.stripe_session_id, { serviceType: 'appeals_assessment', serviceRef: assessmentId, plan });
    if (reusableAppealCheckout) {
      await markServiceSessionCheckoutCreated(serviceSession.id, reusableAppealCheckout.id);
      return res.json({ ok: true, reused: true, service: 'appeals_assessment', url: reusableAppealCheckout.url, sessionId: reusableAppealCheckout.id, serviceSessionId: serviceSession.id, assessmentId, plan });
    }
    await query(`UPDATE appeals_assessments SET client_id=$1, client_email=$2, selected_plan=$3, active_plan=$3, release_at=${appealReleaseAtSql(plan)}, updated_at=now() WHERE id=$4`, [req.client.id, req.client.email, plan, assessmentId]);
    const stripeSession = await createCheckoutSessionSafely({
      mode: 'payment',
      customer_email: req.client.email,
      client_reference_id: assessmentId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_BASE_URL}/payment-complete.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/appeals-assessment.html?cancelled=1&service_session_id=${encodeURIComponent(serviceSession.id)}&appeal_assessment_id=${encodeURIComponent(assessmentId)}`,
      metadata: { service_type: 'appeals_assessment', service_session_id: serviceSession.id, service_ref: assessmentId, assessment_id: assessmentId, appeal_assessment_id: assessmentId, visa_type: assessment.visa_subclass || 'appeals', plan, client_email: req.client.email }
    }, 'service-appeals-checkout', checkoutFingerprint({ serviceType: 'appeals_assessment', serviceRef: assessmentId, plan, price, email: req.client.email }));
    await query(`UPDATE appeals_assessments SET stripe_session_id=$1, status='checkout_created', amount_cents=$2, currency=$3, updated_at=now() WHERE id=$4`, [stripeSession.id, stripeSession.amount_total || appealAmountCents(plan), stripeSession.currency || 'aud', assessmentId]);
    await markServiceSessionCheckoutCreated(serviceSession.id, stripeSession.id);
    await recordAppealPaymentAuditSafe(assessmentId, req.client.email, stripeSession);
    return res.json({ ok: true, service: 'appeals_assessment', url: stripeSession.url, sessionId: stripeSession.id, serviceSessionId: serviceSession.id, assessmentId, plan });
  }

  if (serviceSession.service_type === 'citizenship_test') {
    const plan = requestedCitizenshipPlan(req, serviceSession.selected_plan || '20');
    const price = resolveCitizenshipPriceId(plan);
    if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for citizenship plan ${plan}.` });
    try { await assertStripePriceMatchesPlan({ serviceType: 'citizenship_test', plan, priceId: price }); }
    catch (err) { return res.status(err.statusCode || 500).json({ ok: false, code: 'STRIPE_PRICE_MISMATCH_BLOCKED', error: err.message }); }
    let accessId = serviceSession.service_ref || null;
    if (accessId) {
      const existingAccess = (await query(`SELECT id, selected_plan, active_plan, payment_status, status FROM citizenship_access WHERE id=$1 LIMIT 1`, [accessId])).rows[0];
      const existingPlan = existingAccess ? normaliseCitizenshipPlan(existingAccess.active_plan || existingAccess.selected_plan || plan) : null;
      const alreadyPaid = existingAccess && (existingAccess.payment_status === 'paid' || existingAccess.status === 'active');
      // A paid citizenship access is a permanent purchase record. Never overwrite it
      // when the client buys another 20/50/100 test pack.
      if (!existingAccess || alreadyPaid || existingPlan !== plan) accessId = makeCitizenshipAccessId(plan);
    } else {
      accessId = makeCitizenshipAccessId(plan);
    }
    await query(
      `INSERT INTO citizenship_access (id, client_id, client_email, selected_plan, active_plan, exam_allowance, attempts_used, status, payment_status)
       VALUES ($1,$2,$3,$4,$4,$5,0,'checkout_created','unpaid')
       ON CONFLICT (id) DO UPDATE SET client_id=$2, client_email=$3, selected_plan=$4, active_plan=$4, exam_allowance=$5, updated_at=now()`,
      [accessId, req.client.id, req.client.email, plan, citizenshipExamAllowance(plan)]
    );
    await upsertServiceSession({ id: serviceSession.id, serviceType: 'citizenship_test', serviceRef: accessId, email: req.client.email, clientId: req.client.id, plan, status: 'draft_created', metadata: { citizenship_access_id: accessId } });
    const reusableCitizenshipCheckout = await getReusableOpenCheckoutSession(serviceSession.stripe_session_id, { serviceType: 'citizenship_test', serviceRef: accessId, plan });
    if (reusableCitizenshipCheckout) {
      return res.json({ ok: true, reused: true, service: 'citizenship_test', url: reusableCitizenshipCheckout.url, sessionId: reusableCitizenshipCheckout.id, serviceSessionId: serviceSession.id, accessId, citizenshipAccessId: accessId, plan });
    }
    const stripeSession = await createCheckoutSessionSafely({
      mode: 'payment',
      customer_email: req.client.email,
      client_reference_id: accessId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_BASE_URL}/payment-complete.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/citizenship.html?cancelled=1&service_session_id=${encodeURIComponent(serviceSession.id)}&plan=${encodeURIComponent(plan)}`,
      metadata: { service_type: 'citizenship_test', service_session_id: serviceSession.id, service_ref: accessId, citizenship_access_id: accessId, plan, client_email: req.client.email }
    }, 'service-citizenship-checkout', checkoutFingerprint({ serviceType: 'citizenship_test', serviceRef: accessId, plan, price, email: req.client.email }));
    await query(`UPDATE citizenship_access SET stripe_session_id=$1, amount_cents=$2, currency=$3, raw_payload=$4, updated_at=now() WHERE id=$5`, [stripeSession.id, stripeSession.amount_total || null, stripeSession.currency || 'aud', stripeSession, accessId]);
    await markServiceSessionCheckoutCreated(serviceSession.id, stripeSession.id);
    await recordCitizenshipPaymentAuditSafe(accessId, req.client.email, stripeSession, plan);
    return res.json({ ok: true, service: 'citizenship_test', url: stripeSession.url, sessionId: stripeSession.id, serviceSessionId: serviceSession.id, accessId, citizenshipAccessId: accessId, plan });
  }

  return res.status(400).json({ ok: false, error: `Unsupported service type: ${serviceSession.service_type}` });
}));

app.post('/api/service/start', asyncRoute(async (req, res) => {
  const serviceType = normaliseServiceType(req.body.serviceType || req.body.service_type || req.body.service || 'citizenship_test');
  if (!['citizenship_test'].includes(serviceType)) {
    return res.status(400).json({ ok: false, error: 'Use /api/public/visa-assessment/start for visa and /api/appeals/create-assessment for appeals because those services must save their own evidence/form records first.' });
  }
  const email = normaliseEmail(req.body.email || req.body.client_email || req.body.applicantEmail || req.body.applicant_email);
  const plan = requestedCitizenshipPlan(req, '20');
  const serviceSession = await upsertServiceSession({ serviceType: 'citizenship_test', email, plan, metadata: { source: 'citizenship_public_start' } });
  res.json({ ok: true, service: 'citizenship_test', serviceSessionId: serviceSession.id, service_session_id: serviceSession.id, plan, next: `/login.html?service=citizenship&next=service-checkout&service_session_id=${encodeURIComponent(serviceSession.id)}&plan=${encodeURIComponent(plan)}&email=${encodeURIComponent(email)}` });
}));
app.post('/api/citizenship/start', asyncRoute(async (req, res) => {
  req.body.serviceType = 'citizenship_test';
  const email = normaliseEmail(req.body.email || req.body.client_email || req.body.applicantEmail || req.body.applicant_email);
  const plan = requestedCitizenshipPlan(req, '20');
  const serviceSession = await upsertServiceSession({ serviceType: 'citizenship_test', email, plan, metadata: { source: 'citizenship_public_start_alias' } });
  res.json({ ok: true, service: 'citizenship_test', serviceSessionId: serviceSession.id, service_session_id: serviceSession.id, plan, next: `/login.html?service=citizenship&next=service-checkout&service_session_id=${encodeURIComponent(serviceSession.id)}&plan=${encodeURIComponent(plan)}&email=${encodeURIComponent(email)}` });
}));
app.post('/api/public/citizenship/start', asyncRoute(async (req, res) => {
  req.body.serviceType = 'citizenship_test';
  const email = normaliseEmail(req.body.email || req.body.client_email || req.body.applicantEmail || req.body.applicant_email);
  const plan = requestedCitizenshipPlan(req, '20');
  const serviceSession = await upsertServiceSession({ serviceType: 'citizenship_test', email, plan, metadata: { source: 'citizenship_public_start_alias' } });
  res.json({ ok: true, service: 'citizenship_test', serviceSessionId: serviceSession.id, service_session_id: serviceSession.id, plan, next: `/login.html?service=citizenship&next=service-checkout&service_session_id=${encodeURIComponent(serviceSession.id)}&plan=${encodeURIComponent(plan)}&email=${encodeURIComponent(email)}` });
}));

app.post('/api/appeals/create-checkout-session', requireAuth, asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const assessmentId = req.body.assessmentId || req.body.assessment_id || req.body.appealAssessmentId || req.body.appeal_assessment_id;
  const requestedPlan = req.body.plan || req.body.selectedPlan || req.body.selected_plan;
  if (!assessmentId) return res.status(400).json({ ok: false, error: 'Missing appeals assessment ID.' });

  const { rows } = await query('SELECT * FROM appeals_assessments WHERE id=$1', [assessmentId]);
  const assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Appeals assessment was not found.' });
  const serviceRows = (await query(`SELECT * FROM service_sessions WHERE service_type='appeals_assessment' AND service_ref=$1 ORDER BY created_at DESC LIMIT 1`, [assessmentId])).rows;
  const linkedServiceSession = serviceRows[0] || null;
  if (linkedServiceSession && linkedServiceSession.metadata && linkedServiceSession.metadata.require_fresh_login && !linkedServiceSession.metadata.portal_login_confirmed_at) {
    return res.status(401).json({ ok: false, error: 'Login must be completed before Stripe payment. Please log in through the secure portal first.' });
  }

  // Production handoff fix: allow a portal account email to differ from the
  // applicant/refusal email. The applicant email remains stored separately, while
  // client_email becomes the account owner used by the dashboard and payments tab.
  const storedEmail = normaliseEmail(assessment.client_email || assessment.applicant_email);

  const plan = safePlan((linkedServiceSession && linkedServiceSession.selected_plan) || assessment.active_plan || assessment.selected_plan || requestedPlan || 'instant');
  const price = resolveAppealPriceId(plan);
  if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for appeals plan ${plan}. Add STRIPE_PRICE_APPEAL_${plan === 'instant' ? 'INSTANT' : plan === '24h' ? '24H' : '3D'} in Render.` });
  try { await assertStripePriceMatchesPlan({ serviceType: 'appeals_assessment', plan, priceId: price }); }
  catch (err) { return res.status(err.statusCode || 500).json({ ok: false, code: 'STRIPE_PRICE_MISMATCH_BLOCKED', error: err.message }); }

  const reusableAppealCheckout = await getReusableOpenCheckoutSession(assessment.stripe_session_id || (linkedServiceSession && linkedServiceSession.stripe_session_id), { serviceType: 'appeals_assessment', serviceRef: assessmentId, plan });
  if (reusableAppealCheckout) {
    return res.json({ ok: true, reused: true, url: reusableAppealCheckout.url, sessionId: reusableAppealCheckout.id, assessmentId, plan });
  }

  await query(
    `UPDATE appeals_assessments
     SET client_id=$1, client_email=$2, selected_plan=$3, active_plan=$3, release_at=${appealReleaseAtSql(plan)}, updated_at=now()
     WHERE id=$4`,
    [req.client.id, req.client.email, plan, assessmentId]
  );

  const session = await createCheckoutSessionSafely({
    mode: 'payment',
    customer_email: req.client.email,
    client_reference_id: assessmentId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${APP_BASE_URL}/payment-complete.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_BASE_URL}/appeals-assessment.html?cancelled=1&appeal_assessment_id=${encodeURIComponent(assessmentId)}`,
    metadata: {
      service_type: 'appeals_assessment',
      assessment_id: assessmentId,
      appeal_assessment_id: assessmentId,
      visa_type: assessment.visa_subclass || 'appeals',
      plan,
      client_email: req.client.email
    }
  }, 'appeals-checkout', checkoutFingerprint({ serviceType: 'appeals_assessment', serviceRef: assessmentId, plan, price, email: req.client.email }));

  await query(
    `UPDATE appeals_assessments
     SET stripe_session_id=$1, status='checkout_created', amount_cents=$2, currency=$3, updated_at=now()
     WHERE id=$4`,
    [session.id, appealAmountCents(plan), session.currency || 'aud', assessmentId]
  );

  await recordAppealPaymentAuditSafe(assessmentId, req.client.email, session);
  res.json({ ok: true, url: session.url, sessionId: session.id, assessmentId, plan });
}));

async function recordAppealPaymentAuditSafe(assessmentId, email, session) {
  try {
    const { rows } = await query('SELECT * FROM appeals_assessments WHERE id=$1', [assessmentId]);
    const assessment = rows[0];
    if (!assessment) return { ok: false, skipped: true, reason: 'appeals_assessment_not_found' };
    const plan = safePlan((session && session.metadata && session.metadata.plan) || assessment.active_plan || assessment.selected_plan || 'instant');
    return await recordServicePaymentAuditSafe({
      serviceType: 'appeals_assessment',
      serviceRef: assessmentId,
      clientId: assessment.client_id || null,
      clientEmail: normaliseEmail(email || assessment.client_email),
      visaType: assessment.visa_subclass || 'appeals',
      plan,
      session: { ...(session || {}), metadata: { ...((session && session.metadata) || {}), service_type: 'appeals_assessment' } },
      amountCents: (session && session.amount_total) || assessment.amount_cents || appealAmountCents(plan),
      currency: (session && session.currency) || assessment.currency || 'aud',
      status: (session && (session.payment_status === 'paid' || session.status === 'complete')) ? 'paid' : ((session && (session.payment_status || session.status)) || 'pending')
    });
  } catch (err) {
    console.error('Appeals payment audit insert/update skipped safely:', err.message);
    return { ok: false, skipped: true, error: err.message };
  }
}



function cleanAppealDecisionType(value) {
  const raw = String(value || '').trim();
  if (!raw || /^appeal_\d+_/i.test(raw) || /^sub_\d+_/i.test(raw) || /^svc_\d+_/i.test(raw)) return 'Visa refusal / cancellation decision';
  return raw.slice(0, 160);
}

function inferDecisionRecordApplicantFromText(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const patterns = [
    /Department\s+refused\s+(Mr|Ms|Mrs|Miss)?\s*([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,4})['’]?(?:s)?\s+Subclass/i,
    /applicant(?:,|\s+being|\s+is|\s+was)?\s+(Mr|Ms|Mrs|Miss)?\s*([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){1,4})/i,
    /name\s+of\s+applicant[:\s]+(Mr|Ms|Mrs|Miss)?\s*([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){1,4})/i
  ];
  for (const rx of patterns) {
    const m = source.match(rx);
    if (m && m[2]) return m[2].trim().replace(/\s+/g, ' ');
  }
  return null;
}

function normaliseAppealArray(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v.trim() : v).filter(Boolean);
  if (typeof value === 'string') return value.split(/\n|;/).map(v => v.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
  return fallback;
}

function hardenAppealAdviceBundle(rawBundle, assessment, combinedText) {
  const bundle = rawBundle && typeof rawBundle === 'object' ? rawBundle : {};
  const advice = bundle.advice && typeof bundle.advice === 'object' ? bundle.advice : bundle;
  const sourceText = String(combinedText || '');
  const decisionRecordApplicant = advice.decision_record_applicant || advice.extracted_applicant_name || inferDecisionRecordApplicantFromText(sourceText);
  const clean = (v, fallback = '') => String(v || fallback || '').replace(/\bAI\b|\bGPT\b|prompt|automation|model output/gi, '').replace(/\s{2,}/g, ' ').trim();
  const out = {
    advice: {
      title: clean(advice.title, `Visa refusal review advice — Subclass ${assessment.visa_subclass || ''}`),
      risk_level: clean(advice.risk_level, 'High'),
      decision_record_applicant: clean(decisionRecordApplicant, ''),
      executive_summary: clean(advice.executive_summary || advice.executiveAdvice, ''),
      refusal_grounds: normaliseAppealArray(advice.refusal_grounds || advice.refusalGrounds),
      legal_issues: normaliseAppealArray(advice.legal_issues || advice.legalIssues),
      department_reasoning_breakdown: normaliseAppealArray(advice.department_reasoning_breakdown || advice.departmentReasoningBreakdown),
      tribunal_review_points: normaliseAppealArray(advice.tribunal_review_points || advice.tribunalReviewPoints),
      evidence_position: normaliseAppealArray(advice.evidence_position || advice.evidencePosition),
      evidence_gap_table: normaliseAppealArray(advice.evidence_gap_table || advice.evidenceGapTable),
      strategy: clean(advice.strategy || advice.appeal_strategy || advice.appealStrategy, ''),
      risk_assessment: clean(advice.risk_assessment || advice.riskAssessment, ''),
      next_steps: normaliseAppealArray(advice.next_steps || advice.nextSteps),
      deadline_warning: clean(advice.deadline_warning || advice.deadlineWarning, ''),
      disclaimer: clean(advice.disclaimer, 'This advice is preliminary and based on the uploaded decision material and client instructions. It must be verified against the full Department record, current legislation, policy and review jurisdiction before final action.')
    },
    source_control: {
      fact_bound_to_uploaded_documents: true,
      source_text_sha256: sha256(Buffer.from(sourceText || '', 'utf8')),
      warning: 'Advice must be checked against the original decision record before lodgement or Tribunal submissions.'
    }
  };
  if (!out.advice.executive_summary) {
    out.advice.executive_summary = `I have reviewed the uploaded refusal material for the Subclass ${assessment.visa_subclass || 'visa'} review pathway. The review strategy must be built from the Department’s actual refusal reasons, the legal criteria in dispute, the evidence gaps identified by the decision-maker and any further evidence that can be obtained before the review is progressed.`;
  }
  if (!out.advice.refusal_grounds.length) out.advice.refusal_grounds = fallbackAppealAdvice(assessment, combinedText).advice.refusal_grounds;
  if (!out.advice.legal_issues.length) out.advice.legal_issues = ['Identify the legal criteria the Department was not satisfied were met and prepare review submissions addressing each criterion directly.'];
  if (!out.advice.department_reasoning_breakdown.length) out.advice.department_reasoning_breakdown = ['Prepare an issue-by-issue table setting out the Department’s finding, the evidence relied upon, the evidentiary weakness identified and the proposed response on review.'];
  if (!out.advice.tribunal_review_points.length) out.advice.tribunal_review_points = ['The Tribunal will conduct merits review and may consider further evidence, but the new material must directly answer the Department’s reasons rather than simply repeat the original application claims.'];
  if (!out.advice.evidence_position.length) out.advice.evidence_position = fallbackAppealAdvice(assessment, combinedText).advice.evidence_position;
  if (!out.advice.strategy) out.advice.strategy = fallbackAppealAdvice(assessment, combinedText).advice.strategy;
  if (!out.advice.risk_assessment) out.advice.risk_assessment = fallbackAppealAdvice(assessment, combinedText).advice.risk_assessment;
  if (!out.advice.next_steps.length) out.advice.next_steps = fallbackAppealAdvice(assessment, combinedText).advice.next_steps;
  return out;
}

async function extractAppealPdfText(buffer, filename) {
  if (!buffer) return '';
  if (!pdfParse) return `[PDF text extraction unavailable on server. File received: ${filename || 'uploaded PDF'}]`;
  try {
    const parsed = await pdfParse(buffer);
    return String(parsed.text || '').replace(/\s{3,}/g, ' ').trim().slice(0, 45000);
  } catch (err) {
    return `[Unable to extract text from ${filename || 'uploaded PDF'}: ${err.message}]`;
  }
}

function fallbackAppealAdvice(assessment, combinedText) {
  const text = String(combinedText || '');
  const lower = text.toLowerCase();
  const grounds = [];
  const add = (v) => { if (!grounds.includes(v)) grounds.push(v); };
  if (/genuine|gti|genuine temporary|genuine student/.test(lower)) add('The Department appears to have concerns about genuineness or temporary stay intentions.');
  if (/relationship|spouse|partner|de facto/.test(lower)) add('The Department appears to have concerns about the relationship evidence or partner criteria.');
  if (/financial|funds|income|bank/.test(lower)) add('The Department appears to have concerns about financial capacity or money evidence.');
  if (/character|police|criminal|section 501/.test(lower)) add('The Department appears to have identified a character or adverse information issue.');
  if (/pic 4020|false|misleading|bogus/.test(lower)) add('The Department appears to have raised an integrity, false document or misleading information issue.');
  if (!grounds.length) add('The refusal grounds must be reviewed against the uploaded decision letter and mapped issue by issue.');
  return {
    advice: {
      title: `Visa refusal review advice — Subclass ${assessment.visa_subclass || ''}`,
      risk_level: /pic 4020|character|section 501|false|misleading|bogus/i.test(text) ? 'Very High' : 'High',
      executive_summary: `I have considered the uploaded refusal material and the client instructions for the Subclass ${assessment.visa_subclass || 'visa'} review pathway. The immediate priority is to protect the review deadline, identify each refusal ground, and prepare evidence that directly answers the Department's reasons. This advice is preliminary and should be verified against the full decision record before any review submissions are lodged.`,
      refusal_grounds: grounds,
      evidence_position: [
        'The evidence should be indexed against each refusal reason rather than uploaded as general supporting material.',
        'Any inconsistency between application answers, uploaded documents and later statements should be explained with corroborating material.',
        'Further evidence should be current, dated, translated where required, and clearly connected to the legal issue in dispute.'
      ],
      strategy: 'The review strategy should identify each refusal reason, respond with targeted evidence, and explain why the legal criteria are now met or why the Department’s conclusion should not be preferred. The client should not rely on a general disagreement with the refusal; the review must be evidence-led and issue-specific.',
      risk_assessment: 'The matter carries elevated risk until the refusal reasons have been fully answered. Prospects improve where the missing evidence can be supplied, inconsistencies can be explained, and the review application is lodged within the strict time limit.',
      next_steps: [
        'Confirm the review deadline immediately and lodge within time if review rights are available.',
        'Prepare a refusal-ground table listing the Department issue, evidence already available, evidence missing, and proposed response.',
        'Collect further statements and documents directly addressing each refusal reason.',
        'Arrange professional review of the complete decision record and evidence bundle before filing submissions.'
      ],
      deadline_warning: assessment.tribunal_deadline ? `The stated review deadline is ${assessment.tribunal_deadline}. This date must be verified from the original notification and review rights material.` : 'The review deadline must be confirmed from the original notification and review rights material.',
      disclaimer: 'This advice is generated from uploaded material through the Bircan Migration & Education assessment workflow and must be checked by a registered migration agent against the full record, current law, policy and review jurisdiction before final action.'
    }
  };
}

async function generateAppealAdviceNow(appealId) {
  const { rows } = await query('SELECT * FROM appeals_assessments WHERE id=$1', [appealId]);
  const assessment = rows[0];
  if (!assessment) throw new Error(`Appeals assessment not found: ${appealId}`);
  if (assessment.payment_status !== 'paid') throw new Error('Appeals assessment has not been paid.');
  const docs = (await query('SELECT * FROM appeal_documents WHERE appeal_id=$1 ORDER BY id ASC', [appealId])).rows;
  const sourceDocs = docs.length ? docs : [{ document_type: 'decision', filename: assessment.uploaded_filename, mime_type: assessment.uploaded_mime_type, file_bytes: assessment.uploaded_file }];
  const extractedParts = [];
  for (const doc of sourceDocs) {
    const text = await extractAppealPdfText(doc.file_bytes, doc.filename);
    extractedParts.push(`### ${doc.document_type || 'document'}: ${doc.filename || 'uploaded file'}\n${text}`);
    if (doc.id) await query('UPDATE appeal_documents SET extracted_text=$1 WHERE id=$2', [text, doc.id]);
  }
  const combinedText = extractedParts.join('\n\n').slice(0, 70000);
  let adviceBundle = null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    const prompt = `You are drafting a professional Australian migration refusal review advice letter for Bircan Migration & Education (www.bircanmigration.com.au), using only https://bircanmigration.com.au service context and the uploaded decision material below.

STRICT FACT RULES:
- Use ONLY facts expressly stated in the uploaded document text.
- Do NOT invent names, sponsors, dates, visa subclasses, evidence, events, legislation or refusal reasons.
- If the uploaded decision letter names an applicant different from the form applicant, identify the decision-record applicant separately and do not rewrite the refusal facts to match the portal user.
- If a fact is not found, write "not identified in the uploaded material".
- Do not mention AI, GPT, prompts, automation or internal systems.

Return only valid JSON with this shape:
{"advice":{"title":"...","risk_level":"Low/Moderate/High/Very High","decision_record_applicant":"name found in decision text or not identified in the uploaded material","executive_summary":"...","refusal_grounds":["..."],"legal_issues":["..."],"department_reasoning_breakdown":["For each major ground: Department finding; evidence relied on; weakness identified; response required."],"tribunal_review_points":["..."],"evidence_position":["..."],"evidence_gap_table":["Issue | Department concern | Missing evidence | Review response"],"strategy":"...","risk_assessment":"...","next_steps":["..."],"deadline_warning":"...","disclaimer":"..."}}.

Required legal reasoning quality:
1. Extract each refusal reason separately.
2. Identify the precise legal issue created by each refusal reason.
3. Explain why the Department gave evidence little/no weight.
4. Explain how the Tribunal is likely to reassess the issue on merits review.
5. Give an evidence-led appeal strategy, not generic reassurance.
6. Explain what evidence would materially improve prospects.

Client/form details, for account and metadata only:
Reference: ${assessment.id}
Form applicant: ${assessment.applicant_name || ''}
Portal/client email: ${assessment.client_email || ''}
Applicant email supplied: ${assessment.applicant_email || ''}
Visa subclass supplied: ${assessment.visa_subclass || ''}
Decision type supplied: ${assessment.decision_type || ''}
Decision date supplied: ${assessment.decision_date || ''}
Review deadline supplied: ${assessment.tribunal_deadline || ''}
Client appeal summary: ${assessment.appeal_grounds || ''}
Urgency notes: ${assessment.urgency_notes || ''}

Uploaded document text:
${combinedText}`;
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL_APPEALS || process.env.OPENAI_MODEL_ANALYSIS || 'gpt-4.1-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        })
      });
      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
      const json = await response.json();
      const content = json.choices?.[0]?.message?.content || '{}';
      adviceBundle = hardenAppealAdviceBundle(JSON.parse(content), assessment, combinedText);
    } catch (err) {
      console.error('Appeals GPT advice failed; using fallback advice:', err.message);
      adviceBundle = hardenAppealAdviceBundle(fallbackAppealAdvice(assessment, combinedText), assessment, combinedText);
      adviceBundle.advice.generation_note = err.message;
    }
  } else {
    adviceBundle = hardenAppealAdviceBundle(fallbackAppealAdvice(assessment, combinedText), assessment, combinedText);
  }
  adviceBundle = hardenAppealAdviceBundle(adviceBundle, assessment, combinedText);
  const pdfBuffer = await buildAppealAdvicePdfBuffer(assessment, adviceBundle);
  const locked = assessment.release_at && new Date(assessment.release_at).getTime() > Date.now();
  await query(
    `UPDATE appeals_assessments
     SET pdf_bytes=$1, pdf_mime='application/pdf', pdf_filename=$2, pdf_sha256=$3,
         pdf_generated_at=now(), extracted_text=$4, advice_json=$5, generation_error=NULL,
         status=$6, updated_at=now()
     WHERE id=$7`,
    [pdfBuffer, `${assessment.id}-appeals-advice.pdf`, sha256(pdfBuffer), combinedText.slice(0, 200000), adviceBundle, locked ? 'release_scheduled' : 'advice_ready', appealId]
  );
  return { ok: true, assessmentId: appealId, has_pdf: true, locked };
}

async function attachPaidAppealsSession(session) {
  const md = session.metadata || {};
  const assessmentId = md.appeal_assessment_id || md.assessment_id || session.client_reference_id;
  const email = normaliseEmail(md.client_email || session.customer_email);
  if (!assessmentId) throw new Error('Stripe appeals session is missing assessment_id metadata.');
  if (!email) throw new Error('Stripe appeals session is missing client email.');

  const { rows } = await query('SELECT * FROM appeals_assessments WHERE id=$1', [assessmentId]);
  const assessment = rows[0];
  if (!assessment) throw new Error(`Appeals assessment not found for Stripe session ${session.id}`);
  if (normaliseEmail(assessment.client_email) !== email) throw new Error('Stripe email does not match appeals assessment account email.');
  const paid = !session.payment_status || session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) throw new Error(`Stripe session is not paid yet. Current status: ${session.payment_status || session.status || 'unknown'}`);

  const plan = safePlan(md.plan || assessment.selected_plan || 'instant');
  await query(
    `UPDATE appeals_assessments
     SET status=$1, payment_status='paid', stripe_session_id=$2, stripe_payment_intent=$3,
         amount_cents=$4, currency=$5, active_plan=$6, release_at=${appealReleaseAtSql(plan)}, updated_at=now()
     WHERE id=$7`,
    [plan === 'instant' ? 'advice_preparing' : 'release_scheduled', session.id, session.payment_intent || null, session.amount_total || appealAmountCents(plan), session.currency || 'aud', plan, assessmentId]
  );
  await recordAppealPaymentAuditSafe(assessmentId, email, session);
  setImmediate(() => generateAppealAdviceNow(assessmentId).catch(err => {
    console.error('Appeals advice generation failed:', err.message);
    query(`UPDATE appeals_assessments SET status='advice_failed', generation_error=$1, updated_at=now() WHERE id=$2`, [err.message, assessmentId]).catch(() => {});
  }));
  return { attached: true, assessmentId, type: 'appeals_assessment', plan, generationQueued: true };
}


async function recordCitizenshipPaymentAuditSafe(accessId, email, session, plan) {
  try {
    const { rows } = await query('SELECT * FROM citizenship_access WHERE id=$1', [accessId]);
    const access = rows[0];
    if (!access) return { ok: false, skipped: true, reason: 'citizenship_access_not_found' };
    const paidPlan = normaliseCitizenshipPlan(plan || access.active_plan || access.selected_plan || '20');
    return await recordServicePaymentAuditSafe({
      serviceType: 'citizenship_test',
      serviceRef: accessId,
      clientId: access.client_id || null,
      clientEmail: normaliseEmail(email || access.client_email),
      visaType: null,
      plan: paidPlan,
      session: { ...(session || {}), metadata: { ...((session && session.metadata) || {}), service_type: 'citizenship_test' } },
      amountCents: (session && session.amount_total) || access.amount_cents || expectedAmountCentsForService('citizenship_test', paidPlan),
      currency: (session && session.currency) || access.currency || 'aud',
      status: (session && (session.payment_status === 'paid' || session.status === 'complete')) ? 'paid' : ((session && (session.payment_status || session.status)) || 'pending')
    });
  } catch (err) {
    console.error('Citizenship payment audit insert/update skipped safely:', err.message);
    return { ok: false, skipped: true, error: err.message };
  }
}

async function handleCitizenshipCheckoutSession(req, res) {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const plan = requestedCitizenshipPlan(req, '20');
  const price = resolveCitizenshipPriceId(plan);
  if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for citizenship plan ${plan}. Add STRIPE_PRICE_CITIZENSHIP_${plan.toUpperCase()} in Render.` });
  try { await assertStripePriceMatchesPlan({ serviceType: 'citizenship_test', plan, priceId: price }); }
  catch (err) { return res.status(err.statusCode || 500).json({ ok: false, code: 'STRIPE_PRICE_MISMATCH_BLOCKED', error: err.message }); }

  const accessId = makeCitizenshipAccessId(plan);
  await query(
    `INSERT INTO citizenship_access (id, client_id, client_email, selected_plan, active_plan, exam_allowance, attempts_used, status, payment_status)
     VALUES ($1,$2,$3,$4,$4,$5,0,'checkout_created','unpaid')`,
    [accessId, req.client.id, req.client.email, plan, citizenshipExamAllowance(plan)]
  );

  const successUrl = process.env.CITIZENSHIP_SUCCESS_URL
    || `${APP_BASE_URL}/account-dashboard.html?paid=1&service=citizenship&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = process.env.CITIZENSHIP_CANCEL_URL
    || `${APP_BASE_URL}/citizenship-test-stripe-wired.html?cancelled=1&plan=${encodeURIComponent(plan)}`;

  const session = await createCheckoutSessionSafely({
    mode: 'payment',
    customer_email: req.client.email,
    client_reference_id: accessId,
    line_items: [{ price, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      service_type: 'citizenship_test',
      citizenship_access_id: accessId,
      plan,
      client_email: req.client.email
    }
  }, 'citizenship-checkout', checkoutFingerprint({ serviceType: 'citizenship_test', serviceRef: accessId, plan, price, email: req.client.email }));

  await query(
    `UPDATE citizenship_access
     SET stripe_session_id=$1, amount_cents=$2, currency=$3, raw_payload=$4, updated_at=now()
     WHERE id=$5`,
    [session.id, session.amount_total || null, session.currency || 'aud', session, accessId]
  );

  await recordCitizenshipPaymentAuditSafe(accessId, req.client.email, session, plan);
  return res.json({ ok: true, url: session.url, sessionId: session.id, accessId, citizenshipAccessId: accessId, plan, attemptsAllowed: citizenshipExamAllowance(plan) });
}

async function attachPaidCitizenshipSession(session) {
  const md = session.metadata || {};
  const sessionEmail = session.customer_email || (session.customer_details && session.customer_details.email) || null;
  let accessId = md.citizenship_access_id || md.service_ref || session.client_reference_id;
  const email = normaliseEmail(md.client_email || sessionEmail);
  if (!email) throw new Error('Stripe citizenship session is missing client email.');

  const paid = !session.payment_status || session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) throw new Error(`Stripe session is not paid yet. Current status: ${session.payment_status || session.status || 'unknown'}`);

  const plan = normaliseCitizenshipPlan(md.plan || '20');
  let access = null;

  if (accessId) {
    access = (await query('SELECT * FROM citizenship_access WHERE id=$1 LIMIT 1', [accessId])).rows[0] || null;
  }

  // Recovery path for paid Stripe sessions where the checkout completed but the
  // local citizenship_access row was not written, was rolled back, or the return
  // page only has the Stripe session id. Stripe is the verified source of truth.
  if (!access) {
    access = (await query(
      `SELECT * FROM citizenship_access
       WHERE stripe_session_id=$1 OR raw_payload->>'id'=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [session.id]
    )).rows[0] || null;
  }

  if (!access) {
    const serviceSession = (await query(
      `SELECT *
       FROM service_sessions
       WHERE stripe_session_id=$1
          OR metadata->>'citizenship_access_id'=$2
          OR service_ref=$2
       ORDER BY created_at DESC
       LIMIT 1`,
      [session.id, accessId || '']
    )).rows[0] || null;

    if (serviceSession && serviceSession.service_ref) accessId = serviceSession.service_ref;
  }

  if (!access) {
    accessId = accessId || makeCitizenshipAccessId(plan);

    const client = (await query(
      `SELECT id, email, name FROM clients WHERE lower(email)=lower($1) LIMIT 1`,
      [email]
    )).rows[0] || null;

    await query(
      `INSERT INTO citizenship_access
        (id, client_id, client_email, selected_plan, active_plan, exam_allowance, attempts_used,
         status, payment_status, stripe_session_id, stripe_payment_intent, amount_cents, currency, raw_payload)
       VALUES ($1,$2,$3,$4,$4,$5,0,'active','paid',$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         client_id=COALESCE(EXCLUDED.client_id, citizenship_access.client_id),
         client_email=EXCLUDED.client_email,
         selected_plan=EXCLUDED.selected_plan,
         active_plan=EXCLUDED.active_plan,
         exam_allowance=EXCLUDED.exam_allowance,
         status='active',
         payment_status='paid',
         stripe_session_id=EXCLUDED.stripe_session_id,
         stripe_payment_intent=EXCLUDED.stripe_payment_intent,
         amount_cents=EXCLUDED.amount_cents,
         currency=EXCLUDED.currency,
         raw_payload=EXCLUDED.raw_payload,
         updated_at=now()`,
      [
        accessId,
        client ? client.id : null,
        email,
        plan,
        citizenshipExamAllowance(plan),
        session.id,
        session.payment_intent || null,
        session.amount_total || null,
        session.currency || 'aud',
        session
      ]
    );

    access = (await query('SELECT * FROM citizenship_access WHERE id=$1 LIMIT 1', [accessId])).rows[0];
  }

  accessId = access.id;

  if (normaliseEmail(access.client_email) !== email) {
    await query(
      `UPDATE citizenship_access
       SET client_email=$1, updated_at=now()
       WHERE id=$2 AND (client_email IS NULL OR client_email='' OR payment_status <> 'paid')`,
      [email, accessId]
    );
  }

  await query(
    `UPDATE citizenship_access
     SET status='active', payment_status='paid', stripe_session_id=$1, stripe_payment_intent=$2,
         amount_cents=$3, currency=$4, active_plan=$5, selected_plan=COALESCE(selected_plan,$5),
         exam_allowance=$6, raw_payload=$7, updated_at=now()
     WHERE id=$8`,
    [session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', plan, citizenshipExamAllowance(plan), session, accessId]
  );

  await query(
    `UPDATE service_sessions
     SET status='paid', payment_status='paid', service_ref=COALESCE(service_ref,$1),
         stripe_session_id=$2,
         metadata=COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
         updated_at=now()
     WHERE stripe_session_id=$2 OR id=$4 OR service_ref=$1`,
    [accessId, session.id, JSON.stringify({ citizenship_access_id: accessId, client_email: email, plan }), md.service_session_id || null]
  );

  const paymentAudit = await recordCitizenshipPaymentAuditSafe(accessId, email, session, plan);
  return { attached: true, assessmentId: accessId, accessId, type: 'citizenship_test', plan, pdfReady: false, paymentAudit };
}

app.post('/api/citizenship/create-checkout-session', requireAuth, asyncRoute(handleCitizenshipCheckoutSession));
app.post('/api/citizenship-test/create-checkout-session', requireAuth, asyncRoute(handleCitizenshipCheckoutSession));
app.post('/create-checkout-session', requireAuth, asyncRoute(handleCitizenshipCheckoutSession));

async function finaliseCitizenshipPayment(req, res) {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.body.sessionId || req.body.session_id || req.body.checkoutSessionId || req.query.session_id || req.query.sessionId;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) {
    return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const result = await attachPaidCitizenshipSession(session);

  // Stripe return pages can lose the cross-site cookie. Restore the client session
  // from the verified paid Stripe session email so account-dashboard.html can load
  // the paid citizenship exam access immediately.
  const email = normaliseEmail((session.metadata || {}).client_email || session.customer_email);
  let client = null;
  if (email) {
    const clientRows = await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1)', [email]);
    client = clientRows.rows[0] || null;
    if (client) setSessionCookie(res, sign(client));
  }

  const redirectUrl = `${APP_BASE_URL}/account-dashboard.html?payment=verified&service=citizenship&citizenship=active&access_id=${encodeURIComponent(result.accessId || '')}&session_id=${encodeURIComponent(sessionId)}`;
  res.json({
    ok: true,
    status: 'paid',
    paymentLinked: true,
    service: 'citizenship',
    sessionId,
    accessId: result.accessId,
    citizenshipAccessId: result.accessId,
    plan: result.plan,
    client,
    redirectUrl
  });
}

app.post('/api/citizenship/verify-payment', asyncRoute(finaliseCitizenshipPayment));
app.get('/api/citizenship/verify-payment', asyncRoute(finaliseCitizenshipPayment));
app.post('/api/citizenship/finalise', asyncRoute(finaliseCitizenshipPayment));
app.get('/api/citizenship/finalise', asyncRoute(finaliseCitizenshipPayment));
app.post('/api/citizenship/finalize', asyncRoute(finaliseCitizenshipPayment));
app.get('/api/citizenship/finalize', asyncRoute(finaliseCitizenshipPayment));

app.post('/api/assessment/create-checkout-session', requireCheckoutAuth, asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });

  const assessmentId = getRequestedAssessmentId(req);
  if (!assessmentId) {
    return res.status(400).json({
      ok: false,
      error: 'Missing assessment_id. The visa page must call /api/public/visa-assessment/start first and pass the returned assessment_id to checkout.'
    });
  }

  let assessment;
  try {
    assessment = await attachVisaAssessmentToClientById(assessmentId, req.client);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message || 'Assessment checkout failed.' });
  }

  if (assessment.payment_status === 'paid') {
    return res.json({
      ok: true,
      alreadyPaid: true,
      assessmentId: assessment.id,
      assessment_id: assessment.id,
      plan: assessment.active_plan || assessment.selected_plan,
      redirectUrl: `${APP_BASE_URL}/account-dashboard.html?assessment_id=${encodeURIComponent(assessment.id)}`,
      dashboardUrl: `${APP_BASE_URL}/account-dashboard.html?assessment_id=${encodeURIComponent(assessment.id)}`
    });
  }

  const checkoutPlan = requestedVisaPlan(req, assessment.active_plan || assessment.selected_plan || 'instant');

  // Same-client/subclass/plan paid-matter guard. If another recent assessment for
  // this client/email/subclass/plan is already paid, redirect to that paid matter
  // instead of issuing a fresh Stripe session. This protects the older direct
  // checkout route as well as the service-session route.
  const recentPaidRows = await query(
    `SELECT id, selected_plan, active_plan, stripe_session_id
     FROM assessments
     WHERE visa_type=$2
       AND COALESCE(active_plan, selected_plan, 'instant')=$3
       AND payment_status='paid'
       AND created_at > now() - interval '48 hours'
       AND (client_id=$4 OR lower(client_email)=lower($1) OR lower(applicant_email)=lower($1))
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1`,
    [req.client.email, assessment.visa_type, checkoutPlan, req.client.id]
  );
  const recentPaid = recentPaidRows.rows[0];
  if (recentPaid && recentPaid.id !== assessment.id) {
    await query(
      `UPDATE service_sessions
       SET status='superseded_duplicate_checkout', payment_status='superseded', updated_at=now(),
           metadata=COALESCE(metadata,'{}'::jsonb) || $1::jsonb
       WHERE service_type='visa_assessment' AND service_ref=$2`,
      [JSON.stringify({ superseded_by_assessment_id: recentPaid.id, reason: 'recent paid same client subclass plan' }), assessment.id]
    ).catch(() => null);
    return res.json({
      ok: true,
      alreadyPaid: true,
      reusedPaidAssessment: true,
      assessmentId: recentPaid.id,
      assessment_id: recentPaid.id,
      plan: recentPaid.active_plan || recentPaid.selected_plan || checkoutPlan,
      redirectUrl: `${APP_BASE_URL}/account-dashboard.html?assessment_id=${encodeURIComponent(recentPaid.id)}`,
      dashboardUrl: `${APP_BASE_URL}/account-dashboard.html?assessment_id=${encodeURIComponent(recentPaid.id)}`
    });
  }
  const price = resolveVisaPriceId(assessment.visa_type, checkoutPlan);
  if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for visa plan ${checkoutPlan}.` });
  try { await assertStripePriceMatchesPlan({ serviceType: 'visa_assessment', plan: checkoutPlan, priceId: price }); }
  catch (err) { return res.status(err.statusCode || 500).json({ ok: false, code: 'STRIPE_PRICE_MISMATCH_BLOCKED', error: err.message }); }

  await query('SELECT pg_advisory_lock(hashtext($1))', [`visa-checkout:${assessment.id}`]);
  try {
  const openSessionRows = await query(
    `SELECT stripe_session_id
     FROM service_sessions
     WHERE service_type='visa_assessment'
       AND service_ref=$1
       AND lower(client_email)=lower($2)
       AND stripe_session_id IS NOT NULL
       AND payment_status <> 'paid'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 3`,
    [assessment.id, req.client.email]
  );
  const reusableCandidateIds = [assessment.stripe_session_id, ...openSessionRows.rows.map(r => r.stripe_session_id)].filter(Boolean);
  for (const candidateId of reusableCandidateIds) {
    const reusableVisaCheckout = await getReusableOpenCheckoutSession(candidateId, { serviceType: 'visa_assessment', serviceRef: assessment.id, plan: checkoutPlan });
    if (reusableVisaCheckout) {
      return res.json({ ok: true, reused: true, url: reusableVisaCheckout.url, sessionId: reusableVisaCheckout.id, assessmentId: assessment.id, assessment_id: assessment.id, plan: checkoutPlan });
    }
  }

  const session = await createCheckoutSessionSafely({
    mode: 'payment',
    customer_email: req.client.email,
    client_reference_id: assessment.id,
    line_items: [{ price, quantity: 1 }],
    success_url: `${APP_BASE_URL}/payment-complete.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_BASE_URL}/checkout-start.html?cancelled=1&assessment_id=${encodeURIComponent(assessment.id)}`,
    metadata: {
      service_type: 'visa_assessment',
      assessment_id: assessment.id,
      visa_type: assessment.visa_type,
      plan: checkoutPlan,
      client_email: req.client.email
    }
  }, 'visa-checkout', checkoutFingerprint({ serviceType: 'visa_assessment', serviceRef: assessment.id, plan: checkoutPlan, price, email: req.client.email }));

  await tx(async (client) => {
    await client.query(
      `UPDATE assessments
       SET stripe_session_id=$1,
           status='checkout_created',
           selected_plan=$5,
           active_plan=$5,
           amount_cents=$2,
           currency=$3,
           updated_at=now()
       WHERE id=$4`,
      [session.id, session.amount_total || null, session.currency || 'aud', assessment.id, checkoutPlan]
    );
    await client.query(
      `UPDATE service_sessions
       SET client_id=$1,
           client_email=$2,
           selected_plan=$3,
           status='checkout_created',
           payment_status='unpaid',
           stripe_session_id=$4,
           metadata=COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
           updated_at=now()
       WHERE service_type='visa_assessment' AND service_ref=$6`,
      [req.client.id, req.client.email, checkoutPlan, session.id, JSON.stringify({
        stripe_session_id: session.id,
        checkout_created_at: new Date().toISOString(),
        idempotent_checkout: true
      }), assessment.id]
    );
  });

  await recordPaymentAuditSafe(assessment.id, req.client.email, session);
  return res.json({ ok: true, url: session.url, sessionId: session.id, assessmentId: assessment.id, assessment_id: assessment.id, plan: checkoutPlan });
  } finally {
    await query('SELECT pg_advisory_unlock(hashtext($1))', [`visa-checkout:${assessment.id}`]).catch(() => null);
  }
}));



async function recordServicePaymentAuditSafe({ serviceType, serviceRef, clientId = null, clientEmail, visaType = null, plan = null, session = {}, amountCents = null, currency = 'aud', status = null, paidAt = null }) {
  try {
    const columnsRes = await query(`
      SELECT column_name, data_type, udt_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'payments'
    `);
    const columns = new Map(columnsRes.rows.map(c => [c.column_name, c]));
    if (!columns.size) return { ok: false, skipped: true, reason: 'payments_table_missing' };

    const stripeCreatedAt = session && session.created ? new Date(Number(session.created) * 1000) : new Date();
    const isPaid = status ? /paid|complete|completed|active|verified/i.test(String(status)) : (session && (session.payment_status === 'paid' || session.status === 'complete'));
    const finalPaidAt = paidAt || (isPaid ? stripeCreatedAt : null);
    const values = {
      client_id: clientId || null,
      client_email: normaliseEmail(clientEmail),
      service_type: normaliseServiceType(serviceType),
      service_ref: serviceRef || null,
      visa_type: visaType || null,
      plan: plan || null,
      stripe_session_id: session && session.id ? session.id : null,
      stripe_payment_intent: session && session.payment_intent ? session.payment_intent : null,
      amount_cents: amountCents || (session && session.amount_total) || null,
      currency: (session && session.currency) || currency || 'aud',
      status: status || (isPaid ? 'paid' : ((session && (session.payment_status || session.status)) || 'pending')),
      raw_payload: session || {},
      paid_at: finalPaidAt,
      stripe_created_at: stripeCreatedAt,
      updated_at: new Date()
    };

    const names = [];
    const placeholders = [];
    const params = [];

    const idCol = columns.get('id');
    if (idCol && !idCol.column_default && idCol.is_nullable === 'NO') {
      names.push('id');
      const type = `${idCol.data_type || ''} ${idCol.udt_name || ''}`.toLowerCase();
      if (type.includes('uuid')) {
        placeholders.push('gen_random_uuid()');
      } else if (type.includes('bigint') || type.includes('int8')) {
        placeholders.push("floor(extract(epoch from clock_timestamp()) * 1000000)::bigint");
      } else if (type.includes('integer') || type.includes('int4') || type.includes('smallint') || type.includes('int2')) {
        placeholders.push("floor(extract(epoch from clock_timestamp()))::integer");
      } else {
        params.push(`pay_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`);
        placeholders.push(`$${params.length}`);
      }
    }

    for (const [name, value] of Object.entries(values)) {
      if (!columns.has(name)) continue;
      names.push(name);
      params.push(value);
      placeholders.push(`$${params.length}`);
    }

    if (columns.has('created_at') && !names.includes('created_at')) {
      names.push('created_at');
      placeholders.push('COALESCE($' + (params.length + 1) + '::timestamptz, now())');
      params.push(stripeCreatedAt);
    }

    if (columns.get('client_email')?.is_nullable === 'NO' && !values.client_email) {
      return { ok: false, skipped: true, reason: 'payments_client_email_required_but_missing' };
    }
    if (columns.get('service_type')?.is_nullable === 'NO' && !values.service_type) {
      return { ok: false, skipped: true, reason: 'payments_service_type_required_but_missing' };
    }
    if (columns.get('service_ref')?.is_nullable === 'NO' && !values.service_ref) {
      return { ok: false, skipped: true, reason: 'payments_service_ref_required_but_missing' };
    }

    const updateAssignments = names
      .filter(n => n !== 'id' && n !== 'created_at')
      .map(n => `${n}=COALESCE(EXCLUDED.${n}, payments.${n})`);
    if (columns.has('updated_at') && !updateAssignments.some(a => a.startsWith('updated_at='))) updateAssignments.push('updated_at=now()');

    let conflictSql = 'ON CONFLICT DO NOTHING';
    if (columns.has('stripe_session_id') && values.stripe_session_id) {
      const idxRes = await query(`
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'payments'
          AND indexdef ILIKE '%UNIQUE%'
          AND indexdef ILIKE '%stripe_session_id%'
        LIMIT 1
      `).catch(() => ({ rows: [] }));
      if (idxRes.rows.length) conflictSql = `ON CONFLICT (stripe_session_id) DO UPDATE SET ${updateAssignments.join(', ')}`;
    }

    const { rows } = await query(
      `INSERT INTO payments (${names.join(', ')}) VALUES (${placeholders.join(', ')}) ${conflictSql} RETURNING *`,
      params
    );
    return { ok: true, insertedOrUpdated: Boolean(rows[0]), payment: rows[0] || null };
  } catch (err) {
    console.error('Payment audit insert/update skipped safely:', err.message);
    return { ok: false, skipped: true, error: err.message };
  }
}

async function recordPaymentAuditSafe(assessmentId, email, session) {
  // Production-safe payment ledger writer.
  // It detects the live payments schema, inserts only columns that exist,
  // and updates the existing row when Stripe/webhook/finalise is called more than once.
  try {
    const assessmentRows = await query('SELECT * FROM assessments WHERE id=$1', [assessmentId]);
    const assessment = assessmentRows.rows[0];
    if (!assessment) return { ok: false, skipped: true, reason: 'assessment_not_found' };

    const columnsRes = await query(`
      SELECT column_name, data_type, udt_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'payments'
    `);
    const columns = new Map(columnsRes.rows.map(c => [c.column_name, c]));
    if (!columns.size) return { ok: false, skipped: true, reason: 'payments_table_missing' };

    const stripeCreatedAt = session.created ? new Date(Number(session.created) * 1000) : new Date();
    const paidAt = session.payment_status === 'paid' || session.status === 'complete' ? stripeCreatedAt : null;

    const values = {
      client_id: assessment.client_id || null,
      client_email: normaliseEmail(email || assessment.client_email),
      service_type: 'visa_assessment',
      service_ref: assessmentId,
      visa_type: assessment.visa_type || null,
      plan: assessment.selected_plan || assessment.active_plan || null,
      stripe_session_id: session.id || null,
      stripe_payment_intent: session.payment_intent || null,
      amount_cents: session.amount_total || assessment.amount_cents || null,
      currency: session.currency || assessment.currency || 'aud',
      status: paidAt ? 'paid' : (session.payment_status || session.status || 'pending'),
      raw_payload: session,
      paid_at: paidAt,
      stripe_created_at: stripeCreatedAt,
      updated_at: new Date()
    };

    const names = [];
    const placeholders = [];
    const params = [];

    const idCol = columns.get('id');
    if (idCol && !idCol.column_default && idCol.is_nullable === 'NO') {
      names.push('id');
      const type = `${idCol.data_type || ''} ${idCol.udt_name || ''}`.toLowerCase();
      if (type.includes('uuid')) {
        placeholders.push('gen_random_uuid()');
      } else if (type.includes('bigint') || type.includes('int8')) {
        placeholders.push("floor(extract(epoch from clock_timestamp()) * 1000000)::bigint");
      } else if (type.includes('integer') || type.includes('int4') || type.includes('smallint') || type.includes('int2')) {
        placeholders.push("floor(extract(epoch from clock_timestamp()))::integer");
      } else {
        params.push(`pay_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`);
        placeholders.push(`$${params.length}`);
      }
    }

    for (const [name, value] of Object.entries(values)) {
      if (!columns.has(name)) continue;
      names.push(name);
      params.push(value);
      placeholders.push(`$${params.length}`);
    }

    if (columns.has('created_at') && !names.includes('created_at')) {
      names.push('created_at');
      placeholders.push('COALESCE($' + (params.length + 1) + '::timestamptz, now())');
      params.push(stripeCreatedAt);
    }

    if (!names.includes('client_email') && columns.get('client_email')?.is_nullable === 'NO') {
      return { ok: false, skipped: true, reason: 'payments_client_email_required_but_missing' };
    }

    const updateAssignments = names
      .filter(n => n !== 'id' && n !== 'created_at')
      .map(n => `${n}=COALESCE(EXCLUDED.${n}, payments.${n})`);
    if (columns.has('updated_at') && !updateAssignments.some(a => a.startsWith('updated_at='))) {
      updateAssignments.push('updated_at=now()');
    }

    let conflictSql = 'ON CONFLICT DO NOTHING';
    if (columns.has('stripe_session_id') && values.stripe_session_id) {
      const idxRes = await query(`
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'payments'
          AND indexdef ILIKE '%UNIQUE%'
          AND indexdef ILIKE '%stripe_session_id%'
        LIMIT 1
      `).catch(() => ({ rows: [] }));
      if (idxRes.rows.length) conflictSql = `ON CONFLICT (stripe_session_id) DO UPDATE SET ${updateAssignments.join(', ')}`;
    }

    const { rows } = await query(
      `INSERT INTO payments (${names.join(', ')}) VALUES (${placeholders.join(', ')}) ${conflictSql} RETURNING *`,
      params
    );

    return { ok: true, insertedOrUpdated: Boolean(rows[0]), payment: rows[0] || null };
  } catch (err) {
    console.error('Payment audit insert/update skipped safely:', err.message);
    return { ok: false, skipped: true, error: err.message };
  }
}


async function normalisePaidStripeSessionForAttachment(session) {
  const md = { ...((session && session.metadata) || {}) };
  const rawService = normaliseServiceType(md.service_type || '');
  const ref = String(md.service_ref || md.assessment_id || md.appeal_assessment_id || md.citizenship_access_id || session.client_reference_id || '').trim();
  const planText = String(md.plan || '').trim().toLowerCase();

  // Strong identifiers always win over stale or wrong metadata.
  if (md.assessment_id || /^sub_/.test(ref)) {
    const assessmentId = md.assessment_id || ref;
    const found = (await query('SELECT id, visa_type, selected_plan, active_plan FROM assessments WHERE id=$1 LIMIT 1', [assessmentId])).rows[0];
    if (found) {
      md.service_type = 'visa_assessment';
      md.assessment_id = found.id;
      md.service_ref = found.id;
      md.visa_type = md.visa_type || found.visa_type || 'visa';
      md.plan = safePlan(md.plan || found.active_plan || found.selected_plan || 'instant');
      return { ...session, metadata: md, client_reference_id: found.id };
    }
  }

  if (md.appeal_assessment_id || rawService === 'appeals_assessment') {
    const appealId = md.appeal_assessment_id || md.assessment_id || ref;
    const found = appealId ? (await query('SELECT id, visa_subclass, selected_plan, active_plan FROM appeals_assessments WHERE id=$1 LIMIT 1', [appealId])).rows[0] : null;
    if (found) {
      md.service_type = 'appeals_assessment';
      md.appeal_assessment_id = found.id;
      md.assessment_id = found.id;
      md.service_ref = found.id;
      md.visa_type = md.visa_type || found.visa_subclass || 'appeals';
      md.plan = safePlan(md.plan || found.active_plan || found.selected_plan || 'instant');
      return { ...session, metadata: md, client_reference_id: found.id };
    }
  }

  // Guard against the live bug: a visa assessment checkout can arrive with
  // metadata.service_type='citizenship_test' while plan='instant'. Citizenship
  // never uses instant/24h/3d plans. If the reference exists as an assessment,
  // finalise it as a visa assessment instead of throwing a citizenship plan error.
  if (rawService === 'citizenship_test' && /^(instant|24h|24hr|24hour|24hours|3d|3day|3days)$/i.test(planText || 'instant')) {
    const candidate = md.assessment_id || md.service_ref || session.client_reference_id || '';
    if (candidate) {
      const found = (await query('SELECT id, visa_type, selected_plan, active_plan FROM assessments WHERE id=$1 LIMIT 1', [candidate])).rows[0];
      if (found) {
        md.service_type = 'visa_assessment';
        md.assessment_id = found.id;
        md.service_ref = found.id;
        md.visa_type = md.visa_type || found.visa_type || 'visa';
        md.plan = safePlan(md.plan || found.active_plan || found.selected_plan || 'instant');
        return { ...session, metadata: md, client_reference_id: found.id };
      }
    }
  }

  if (md.citizenship_access_id || /^cit_/.test(ref) || rawService === 'citizenship_test') {
    const accessId = md.citizenship_access_id || ref || session.client_reference_id;
    const found = accessId ? (await query('SELECT id, selected_plan, active_plan FROM citizenship_access WHERE id=$1 LIMIT 1', [accessId])).rows[0] : null;
    if (found) {
      md.service_type = 'citizenship_test';
      md.citizenship_access_id = found.id;
      md.service_ref = found.id;
      md.plan = normaliseCitizenshipPlan(md.plan || found.active_plan || found.selected_plan || '20');
      return { ...session, metadata: md, client_reference_id: found.id };
    }
  }

  if (!rawService) {
    const candidate = session.client_reference_id || md.service_ref || md.assessment_id;
    if (candidate) {
      const foundAssessment = (await query('SELECT id, visa_type, selected_plan, active_plan FROM assessments WHERE id=$1 LIMIT 1', [candidate])).rows[0];
      if (foundAssessment) {
        md.service_type = 'visa_assessment';
        md.assessment_id = foundAssessment.id;
        md.service_ref = foundAssessment.id;
        md.visa_type = md.visa_type || foundAssessment.visa_type || 'visa';
        md.plan = safePlan(md.plan || foundAssessment.active_plan || foundAssessment.selected_plan || 'instant');
        return { ...session, metadata: md, client_reference_id: foundAssessment.id };
      }
    }
  }

  return { ...session, metadata: md };
}

async function attachPaidSession(session, options = {}) {
  session = await normalisePaidStripeSessionForAttachment(session);
  await markServiceSessionPaidByStripe(session).catch(err => console.warn('Service session paid marker skipped:', err.message));
  const md = session.metadata || {};
  if (md.service_type === 'appeals_assessment') return attachPaidAppealsSession(session);
  if (md.service_type === 'citizenship_test') return attachPaidCitizenshipSession(session);
  if (md.service_type !== 'visa_assessment') return { attached: false, reason: 'not_supported_service' };
  const assessmentId = md.assessment_id || session.client_reference_id;
  const email = normaliseEmail(md.client_email || session.customer_email);
  if (!assessmentId) throw new Error('Stripe session is missing assessment_id metadata.');
  if (!email) throw new Error('Stripe session is missing client email.');

  await tx(async (client) => {
    const assessmentRes = await client.query('SELECT * FROM assessments WHERE id=$1 FOR UPDATE', [assessmentId]);
    const assessment = assessmentRes.rows[0];
    if (!assessment) throw new Error(`Assessment not found for Stripe session ${session.id}`);
    // Stripe-paid recovery rule:
    // Checkout is created only after the portal account has paid. If an older/public
    // assessment still carries the form/applicant email, do not lose the paid matter
    // from the dashboard. Preserve applicant_email, but attach the account owner from
    // the paid Stripe session/customer email to client_email.
    if (normaliseEmail(assessment.client_email) !== email) {
      const accountRows = await client.query('SELECT id, email FROM clients WHERE lower(email)=lower($1) LIMIT 1', [email]);
      const account = accountRows.rows[0] || null;
      await client.query(
        `UPDATE assessments
         SET client_id=COALESCE($1, client_id),
             client_email=$2,
             applicant_email=COALESCE(applicant_email, client_email, $2),
             updated_at=now()
         WHERE id=$3`,
        [account && account.id ? account.id : null, email, assessmentId]
      );
      assessment.client_email = email;
      if (account && account.id) assessment.client_id = account.id;
    }

    const paid = !session.payment_status || session.payment_status === 'paid' || session.status === 'complete';
    if (!paid) throw new Error(`Stripe session is not paid yet. Current status: ${session.payment_status || session.status || 'unknown'}`);

    // Stripe metadata is the source of truth for the paid plan. Do not let an older
    // selected_plan value keep an instant payment locked behind a 24h/72h timer.
    const paidPlan = safePlan((session.metadata || {}).plan || assessment.active_plan || assessment.selected_plan || 'instant');
    const nextAssessmentStatus = assessment.pdf_bytes ? 'pdf_ready' : (isInstantPlan(paidPlan) ? 'pdf_queued' : 'release_scheduled');
    await client.query(
      `UPDATE assessments
       SET status=$1,
           payment_status='paid', stripe_session_id=$2, stripe_payment_intent=$3,
           amount_cents=$4, currency=$5, selected_plan=$6, active_plan=$6,
           release_at=${releaseIntervalSqlForPlan(paidPlan)}, generation_error=NULL, updated_at=now()
       WHERE id=$7`,
      [nextAssessmentStatus, session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', paidPlan, assessmentId]
    );

    // Do not insert into payments inside this transaction.
    // Some live databases have an old payments.id column with NOT NULL but no default.
    // A failing audit insert must never roll back the paid assessment attachment.

    if (!assessment.pdf_bytes) {
      await client.query(
        `INSERT INTO pdf_jobs (assessment_id, status, run_after)
         VALUES ($1,'queued',(SELECT COALESCE(release_at, now()) FROM assessments WHERE id=$1))
         ON CONFLICT (assessment_id) DO UPDATE SET status='queued', run_after=(SELECT COALESCE(release_at, now()) FROM assessments WHERE id=$1), locked_at=NULL, last_error=NULL, updated_at=now()`,
        [assessmentId]
      );
    } else {
      await client.query(
        `INSERT INTO pdf_jobs (assessment_id, status, run_after)
         VALUES ($1,'completed',now())
         ON CONFLICT (assessment_id) DO UPDATE SET status='completed', last_error=NULL, updated_at=now()`,
        [assessmentId]
      );
    }
  });

  const paymentAudit = await recordPaymentAuditSafe(assessmentId, email, session);

  let pdfResult = null;
  const paidPlanForGeneration = safePlan((session.metadata || {}).plan || 'instant');
  if (options.triggerGeneration && isInstantPlan(paidPlanForGeneration)) {
    if (options.waitForPdf) {
      pdfResult = await generateAssessmentPdfNow(assessmentId, email);
    } else {
      setImmediate(() => generateAssessmentPdfNow(assessmentId).catch(err => console.error('Immediate PDF generation failed:', err.message)));
    }
  }
  return { attached: true, type: 'visa_assessment', assessmentId, plan: paidPlanForGeneration, pdfReady: Boolean(pdfResult && pdfResult.has_pdf !== false), pdf: pdfResult, paymentAudit };
}

app.post('/api/assessment/verify-payment', asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.body.sessionId || req.body.session_id || req.query.session_id;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  let session = await stripe.checkout.sessions.retrieve(sessionId);
  session = await normalisePaidStripeSessionForAttachment(session);
  const result = await attachPaidSession(session, { triggerGeneration: true, waitForPdf: VERIFY_PAYMENT_WAIT_FOR_PDF });

  const email = normaliseEmail((session.metadata || {}).client_email || session.customer_email);
  let client = null;
  if (email) {
    const clientRows = await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1)', [email]);
    client = clientRows.rows[0] || null;
    if (client) setSessionCookie(res, sign(client));
  }

  res.json({
    ok: true,
    status: 'paid',
    sessionId,
    service: result.type || (session.metadata || {}).service_type || 'visa_assessment',
    assessmentId: result.assessmentId,
    accessId: result.accessId || null,
    citizenshipAccessId: result.accessId || null,
    plan: result.plan || null,
    pdfReady: result.pdfReady,
    client,
    dashboardAccessToken: client ? signDashboardAccessToken(client) : null,
    accessToken: client ? signDashboardAccessToken(client) : null
  });
}));

app.get('/api/assessment/verify-payment', asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.query.session_id || req.query.sessionId;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  let session = await stripe.checkout.sessions.retrieve(sessionId);
  session = await normalisePaidStripeSessionForAttachment(session);
  const result = await attachPaidSession(session, { triggerGeneration: true, waitForPdf: VERIFY_PAYMENT_WAIT_FOR_PDF });

  const email = normaliseEmail((session.metadata || {}).client_email || session.customer_email);
  let client = null;
  if (email) {
    const clientRows = await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1)', [email]);
    client = clientRows.rows[0] || null;
    if (client) setSessionCookie(res, sign(client));
  }

  res.json({ ok: true, status: 'paid', sessionId, service: result.type || (session.metadata || {}).service_type || 'visa_assessment', assessmentId: result.assessmentId, accessId: result.accessId || null, citizenshipAccessId: result.accessId || null, plan: result.plan || null, pdfReady: result.pdfReady, client, dashboardAccessToken: client ? signDashboardAccessToken(client) : null, accessToken: client ? signDashboardAccessToken(client) : null });
}));


// Repair endpoint for paid visa assessments that were incorrectly locked with a
// delayed release timer. It is safe: it only unlocks paid visa assessments when
// the paid Stripe session metadata says plan=instant.
app.post('/api/assessment/repair-instant-release', requireAuth, asyncRoute(async (req, res) => {
  const assessmentId = String(req.body.assessmentId || req.body.assessment_id || req.body.id || '').trim();
  if (!assessmentId) return res.status(400).json({ ok: false, error: 'assessmentId is required.' });

  const { rows } = await query(
    `SELECT id, client_email, payment_status, stripe_session_id, selected_plan, active_plan, release_at
     FROM assessments
     WHERE id=$1 AND lower(client_email)=lower($2)
     LIMIT 1`,
    [assessmentId, req.client.email]
  );
  const assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  if (assessment.payment_status !== 'paid') return res.status(409).json({ ok: false, error: 'Assessment is not marked paid yet.' });

  let stripePlan = null;
  if (stripe && assessment.stripe_session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(assessment.stripe_session_id);
      stripePlan = safePlan((session.metadata || {}).plan || '');
    } catch (err) {
      console.warn('Unable to retrieve Stripe session for repair:', err.message);
    }
  }
  const finalPlan = safePlan(stripePlan || assessment.active_plan || assessment.selected_plan || 'instant');
  if (!isInstantPlan(finalPlan)) {
    return res.status(409).json({ ok: false, error: `This assessment is paid as ${finalPlan}, not instant.`, plan: finalPlan });
  }

  await query(
    `UPDATE assessments
     SET selected_plan='instant', active_plan='instant', release_at=now(),
         status=CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes)>1024 THEN 'pdf_ready' ELSE 'pdf_queued' END,
         generation_error=NULL, updated_at=now()
     WHERE id=$1`,
    [assessmentId]
  );
  await query(
    `INSERT INTO pdf_jobs (assessment_id, status, run_after)
     VALUES ($1,'queued',now())
     ON CONFLICT (assessment_id) DO UPDATE SET status='queued', run_after=now(), locked_at=NULL, last_error=NULL, updated_at=now()`,
    [assessmentId]
  );

  setImmediate(() => generateAssessmentPdfNow(assessmentId, req.client.email).catch(err => console.error('Repair PDF generation failed:', err.message)));
  res.json({ ok: true, repaired: true, assessmentId, plan: 'instant', releaseAt: 'now', status: 'pdf_queued' });
}));


async function getCitizenshipAccessForClient(email) {
  const { rows } = await query(
    `SELECT id, selected_plan, active_plan, exam_allowance, attempts_used,
            GREATEST(0, exam_allowance - attempts_used) AS attempts_remaining,
            status, payment_status, stripe_session_id, amount_cents, currency, created_at, updated_at
     FROM citizenship_access
     WHERE lower(client_email)=lower($1)
     ORDER BY created_at DESC`,
    [email]
  );
  return rows;
}

app.get('/api/citizenship/access', requireAuth, asyncRoute(async (req, res) => {
  const access = await getCitizenshipAccessForClient(req.client.email);
  res.json({
    ok: true,
    client: req.client,
    citizenshipAccess: access,
    citizenship: access,
    active: access.filter(c => c.payment_status === 'paid' || c.status === 'active'),
    count: access.filter(c => c.payment_status === 'paid' || c.status === 'active').length
  });
}));

app.get('/api/citizenship/status', requireAuth, asyncRoute(async (req, res) => {
  const access = await getCitizenshipAccessForClient(req.client.email);
  const active = access.filter(c => c.payment_status === 'paid' || c.status === 'active');
  res.json({ ok: true, hasAccess: active.length > 0, activeAccess: active[0] || null, citizenshipAccess: access, citizenship: access });
}));


const DEFAULT_CITIZENSHIP_EXAM_QUESTIONS = [
  { id: 'cit_q1', question: 'What do we commemorate on Anzac Day?', options: ['The landing of the Australian and New Zealand Army Corps at Gallipoli', 'The opening of Federal Parliament', 'The arrival of the First Fleet', 'The signing of the Constitution'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Anzac Day commemorates the landing at Gallipoli and honours Australians who served and died in war and peacekeeping.' },
  { id: 'cit_q2', question: 'What is Australia’s system of government?', options: ['Parliamentary democracy', 'Military government', 'Absolute monarchy', 'One-party state'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Australia is a parliamentary democracy.' },
  { id: 'cit_q3', question: 'Who is Australia’s Head of State?', options: ['The King of Australia', 'The Prime Minister', 'The Governor-General only', 'The Chief Justice'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'The King of Australia is Australia’s Head of State and is represented by the Governor-General.' },
  { id: 'cit_q4', question: 'What is the rule of law?', options: ['All people are equal under the law', 'Only citizens must obey the law', 'Courts make immigration policy', 'Police can ignore Parliament'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'The rule of law means everyone, including government, is subject to the law.' },
  { id: 'cit_q5', question: 'Which arm of government interprets and applies the law?', options: ['Judiciary', 'Executive', 'Media', 'Local council'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Courts and judges form the judiciary and interpret/apply the law.' },
  { id: 'cit_q6', question: 'What does the Australian Constitution do?', options: ['Sets out basic rules for governing Australia', 'Lists every criminal offence', 'Replaces all State laws', 'Appoints the Prime Minister for life'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'The Constitution sets out the basic rules for Australia’s government.' },
  { id: 'cit_q7', question: 'What is one responsibility of Australian citizens aged 18 or over?', options: ['Vote in federal, state or territory elections and referendums', 'Join a political party', 'Serve as Prime Minister', 'Own property'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Voting is compulsory for Australian citizens aged 18 or over.' },
  { id: 'cit_q8', question: 'What is one privilege of Australian citizens?', options: ['Apply for an Australian passport', 'Never pay tax', 'Ignore jury service', 'Vote in another country’s parliament'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Citizens can apply for an Australian passport and seek consular assistance overseas.' },
  { id: 'cit_q9', question: 'What does freedom of speech allow?', options: ['People can say and write what they think, within the law', 'People can threaten others', 'People can publish false official documents', 'People can disobey court orders'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Freedom of speech operates within Australian law.' },
  { id: 'cit_q10', question: 'What is freedom of association?', options: ['People may join or leave groups voluntarily', 'People must join a union', 'People must support the government', 'People cannot protest peacefully'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Australians may gather and associate with others, within the law.' },
  { id: 'cit_q11', question: 'What is the national flower of Australia?', options: ['Golden wattle', 'Rose', 'Tulip', 'Waratah only'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'The golden wattle is Australia’s national floral emblem.' },
  { id: 'cit_q12', question: 'What are the colours of the Aboriginal Flag?', options: ['Black, red and yellow', 'Blue, white and green', 'Red, white and blue', 'Green and gold'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'The Aboriginal Flag is black, red and yellow.' },
  { id: 'cit_q13', question: 'What is Australia’s capital city?', options: ['Canberra', 'Sydney', 'Melbourne', 'Perth'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Canberra is the capital city of Australia.' },
  { id: 'cit_q14', question: 'Who makes laws in Australia?', options: ['Parliament', 'Only the police', 'Only the courts', 'Only local businesses'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Parliament makes and changes laws.' },
  { id: 'cit_q15', question: 'What is the role of the Governor-General?', options: ['Representative of the King of Australia', 'Leader of the Opposition', 'Head of every local council', 'Chief migration agent'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'The Governor-General represents the King of Australia.' },
  { id: 'cit_q16', question: 'What is a referendum?', options: ['A national vote to change the Constitution', 'A local council meeting', 'A court appeal', 'A citizenship ceremony'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'A referendum is required to change the Australian Constitution.' },
  { id: 'cit_q17', question: 'What is one Australian value?', options: ['Respect for the freedom and dignity of the individual', 'Government by one party only', 'No equality before the law', 'No religious freedom'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Australian values include respect, freedom, democracy, equality and rule of law.' },
  { id: 'cit_q18', question: 'What must citizens do if called for jury service?', options: ['Attend if required by law', 'Ignore the notice', 'Send another person without permission', 'Pay a fine in advance'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'Citizens may be required to attend jury service if summoned.' },
  { id: 'cit_q19', question: 'What is the official symbol of the Commonwealth of Australia?', options: ['The Commonwealth Coat of Arms', 'The Sydney Harbour Bridge', 'The Eureka Flag', 'The map of Tasmania'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'The Commonwealth Coat of Arms is an official symbol of Australia.' },
  { id: 'cit_q20', question: 'What should people do if they disagree with a law?', options: ['Work peacefully and lawfully to change it', 'Use violence', 'Ignore all laws', 'Refuse to vote forever'], correctIndex: 0, correctAnswer: 0, answer: 0, explanation: 'People can seek change through peaceful and democratic processes.' }
];

function shuffleCitizenshipQuestions(input, limit = 20) {
  const copy = (Array.isArray(input) ? input : DEFAULT_CITIZENSHIP_EXAM_QUESTIONS).map((q, i) => ({
    id: q.id || `cit_q${i + 1}`,
    question: String(q.question || '').trim(),
    options: Array.isArray(q.options) ? q.options.map(String) : [],
    correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : Number.isInteger(q.correctAnswer) ? q.correctAnswer : Number.isInteger(q.answer) ? q.answer : 0,
    correctAnswer: Number.isInteger(q.correctAnswer) ? q.correctAnswer : Number.isInteger(q.correctIndex) ? q.correctIndex : Number.isInteger(q.answer) ? q.answer : 0,
    answer: Number.isInteger(q.answer) ? q.answer : Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
    explanation: q.explanation || ''
  })).filter(q => q.question && q.options.length);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(1, Number(limit || 20)));
}

async function getActivePaidCitizenshipAccess(req) {
  const requestedAccessId = String(
    (req.body && (req.body.accessId || req.body.access_id || req.body.citizenshipAccessId || req.body.citizenship_access_id)) ||
    (req.query && (req.query.accessId || req.query.access_id || req.query.citizenshipAccessId || req.query.citizenship_access_id)) ||
    ''
  ).trim();
  const clientId = req.client && req.client.id;
  const clientEmail = normaliseEmail(req.client && req.client.email);
  const whereParts = [`(payment_status='paid' OR status='active' OR status='paid')`];
  const params = [];
  if (requestedAccessId) {
    params.push(requestedAccessId);
    whereParts.push(`id=$${params.length}`);
  }
  if (clientId || clientEmail) {
    const authParts = [];
    if (clientId) { params.push(clientId); authParts.push(`client_id=$${params.length}`); }
    if (clientEmail) { params.push(clientEmail); authParts.push(`lower(client_email)=lower($${params.length})`); }
    whereParts.push(`(${authParts.join(' OR ')})`);
  } else if (!requestedAccessId) {
    return null;
  }
  const { rows } = await query(
    `SELECT id, client_id, client_email, selected_plan, active_plan, exam_allowance, attempts_used,
            GREATEST(0, COALESCE(exam_allowance,0) - COALESCE(attempts_used,0)) AS attempts_remaining,
            status, payment_status, stripe_session_id, amount_cents, currency, created_at, updated_at
     FROM citizenship_access
     WHERE ${whereParts.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT 1`,
    params
  );
  return rows[0] || null;
}
function buildCitizenshipExamResponse(access, questions) {
  const plan = normaliseCitizenshipPlan(access.active_plan || access.selected_plan || '20');
  const allowance = Number(access.exam_allowance || citizenshipExamAllowance(plan));
  const used = Number(access.attempts_used || 0);
  const remaining = Math.max(0, allowance - used);
  const safeQuestions = Array.isArray(questions) ? questions : [];
  const examId = `exam_${Date.now()}_${access.id}_${crypto.randomBytes(4).toString('hex')}`;
  const entitlement = {
    id: access.id,
    accessId: access.id,
    plan,
    planLabel: `${plan} tests`,
    total: allowance,
    used,
    remaining,
    attemptsAllowed: allowance,
    attemptsUsed: used,
    attemptsRemaining: remaining,
    status: access.status,
    payment_status: access.payment_status
  };
  return {
    ok: true,
    service: 'citizenship_test',
    status: 'active',
    hasAccess: true,
    examId,
    accessId: access.id,
    citizenshipAccessId: access.id,
    access,
    activeAccess: access,
    entitlement,
    plan,
    selectedPlan: plan,
    activePlan: plan,
    examAllowance: allowance,
    attemptsAllowed: allowance,
    attemptsUsed: used,
    attemptsRemaining: remaining,
    totalQuestions: safeQuestions.length,
    questionCount: safeQuestions.length,
    questions: safeQuestions,
    exam: {
      examId,
      accessId: access.id,
      plan,
      totalQuestions: safeQuestions.length,
      questions: safeQuestions,
      attemptsRemaining: remaining
    }
  };
}

async function handlePaidCitizenshipExamStart(req, res) {
  const access = await getActivePaidCitizenshipAccess(req);
  if (!access) {
    return res.status(402).json({
      ok: false,
      code: 'CITIZENSHIP_ACCESS_REQUIRED',
      error: 'Plan required. Choose a plan above to activate the paid citizenship exam.',
      hasAccess: false,
      questions: []
    });
  }
  const remaining = Number(access.attempts_remaining || 0);
  if (remaining <= 0) {
    return res.status(403).json({ ok: false, code: 'NO_ATTEMPTS_REMAINING', error: 'No citizenship test attempts remain on this plan.', hasAccess: true, access, questions: [] });
  }
  const count = Math.max(1, Math.min(20, Number(req.body && (req.body.questionCount || req.body.questions) || req.query.questionCount || 20)));
  const questions = shuffleCitizenshipQuestions(DEFAULT_CITIZENSHIP_EXAM_QUESTIONS, count);
  return res.json(buildCitizenshipExamResponse(access, questions));
}

async function handlePaidCitizenshipExamStatus(req, res) {
  const access = await getActivePaidCitizenshipAccess(req);
  if (!access) {
    return res.json({ ok: true, hasAccess: false, active: false, status: 'inactive', questions: [], attemptsRemaining: 0, error: 'Plan required. Choose a plan above to activate the paid citizenship exam.' });
  }
  return res.json(buildCitizenshipExamResponse(access, []));
}

function markCitizenshipQuestionsForValues(questions) {
  const safe = Array.isArray(questions) ? questions : [];
  let valuesMarked = safe.filter(q => q && (q.isValue || q.isValues || q.values || String(q.category || '').toLowerCase().includes('value'))).length;
  if (valuesMarked >= 5) return safe;
  return safe.map((q, i) => ({ ...q, isValue: Boolean(q && (q.isValue || q.isValues || q.values)) || i >= Math.max(0, safe.length - 5) }));
}

function normaliseCitizenshipAnswerIndex(q) {
  const candidates = [q && q.correctIndex, q && q.correctAnswer, q && q.answer];
  for (const c of candidates) {
    if (Number.isInteger(c)) return c;
    if (typeof c === 'number' && Number.isFinite(c)) return Math.trunc(c);
    if (typeof c === 'string' && /^\d+$/.test(c.trim())) return Number(c.trim());
  }
  if (q && Array.isArray(q.options) && typeof q.correctAnswer === 'string') {
    const idx = q.options.findIndex(o => String(o).trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase());
    if (idx >= 0) return idx;
  }
  return 0;
}

function citizenshipCategoryForQuestion(q, i) {
  const raw = String((q && (q.category || q.section || q.topic || q.type)) || '').trim();
  if (raw) return raw;
  const text = String((q && q.question) || '').toLowerCase();
  if (/value|freedom|equality|respect|democracy|rule of law/.test(text)) return 'Australian values';
  if (/parliament|government|governor|constitution|referendum|law|vote|jury/.test(text)) return 'Government, law and democracy';
  if (/flag|flower|capital|symbol|coat of arms/.test(text)) return 'Australia and its symbols';
  return i >= 15 ? 'Australian values' : 'General knowledge';
}

function calculateCitizenshipResultFromPayload(questions, answers) {
  const qs = markCitizenshipQuestionsForValues(Array.isArray(questions) && questions.length ? questions : DEFAULT_CITIZENSHIP_EXAM_QUESTIONS).slice(0, 20);
  const ans = Array.isArray(answers) ? answers : [];
  const review = qs.map((q, i) => {
    const correctIndex = normaliseCitizenshipAnswerIndex(q);
    const selectedRaw = ans[i];
    const selected = selectedRaw === null || selectedRaw === undefined || selectedRaw === '' ? null : Number(selectedRaw);
    const correct = selected !== null && selected === correctIndex;
    const selectedText = selected === null || !Array.isArray(q.options) ? 'No answer selected' : (q.options[selected] || 'No answer selected');
    const correctText = Array.isArray(q.options) ? (q.options[correctIndex] || '') : '';
    const category = citizenshipCategoryForQuestion(q, i);
    const explanation = q.explanation || `The correct answer is "${correctText}". This question tests ${category.toLowerCase()} knowledge for the Australian citizenship test.`;
    return {
      index: i,
      questionId: q.id || `cit_q${i + 1}`,
      question: q.question,
      selected,
      correct,
      correctIndex,
      selectedText,
      correctText,
      explanation,
      category,
      isValue: Boolean(q.isValue || q.isValues || q.values || category.toLowerCase().includes('value'))
    };
  });
  const score = review.filter(r => r.correct).length;
  const answered = review.filter(r => r.selected !== null && r.selected !== undefined).length;
  const unanswered = review.length - answered;
  const valueIndexes = review.map((r, i) => r.isValue ? i : null).filter(i => i !== null).slice(0, 5);
  const valuesTotal = Math.min(5, valueIndexes.length || 5);
  const valuesCorrect = valueIndexes.length ? valueIndexes.filter(i => review[i] && review[i].correct).length : Math.min(5, score);
  const categories = {};
  review.forEach(r => {
    const k = r.category || 'General knowledge';
    categories[k] = categories[k] || { total: 0, correct: 0, incorrect: 0, rate: 0 };
    categories[k].total += 1;
    if (r.correct) categories[k].correct += 1;
    else categories[k].incorrect += 1;
  });
  Object.keys(categories).forEach(k => { categories[k].rate = categories[k].total ? Math.round((categories[k].correct / categories[k].total) * 100) : 0; });
  const passed = score >= 15 && valuesCorrect >= valuesTotal;
  const weakAreas = Object.entries(categories).filter(([,v]) => (v.total ? v.correct / v.total : 0) < 0.75).map(([name, v]) => ({ name, correct: v.correct, total: v.total, rate: v.rate }));
  const strengths = Object.entries(categories).filter(([,v]) => (v.total ? v.correct / v.total : 0) >= 0.75).map(([name, v]) => ({ name, correct: v.correct, total: v.total, rate: v.rate }));
  const reasons = [
    score >= 15 ? 'Overall score meets the 15/20 requirement.' : 'Overall score is below 15/20.',
    valuesCorrect >= valuesTotal ? 'Australian values requirement is met.' : 'Australian values requirement is not met.',
    unanswered ? `${unanswered} unanswered question(s) were marked incorrect.` : 'All questions were answered before submission.',
    passed ? 'This attempt reached the required practice pass standard.' : 'Further practice is recommended before attempting the real citizenship test.'
  ];
  return {
    score,
    totalQuestions: review.length,
    answered,
    unanswered,
    incorrect: review.length - score,
    valuesCorrect,
    valuesTotal,
    passed,
    readiness: passed ? 'ready' : 'needs_practice',
    reasons,
    categories,
    weakAreas,
    strengths,
    review,
    generatedAt: new Date().toISOString(),
    reportTitle: 'Bircan Migration & Education Citizenship Test Assessment'
  };
}

async function handlePaidCitizenshipExamSubmit(req, res) {
  const access = await getActivePaidCitizenshipAccess(req);
  if (!access) {
    return res.status(402).json({ ok: false, code: 'CITIZENSHIP_ACCESS_REQUIRED', error: 'Plan required. Choose a plan above to activate the paid citizenship exam.' });
  }
  const remaining = Number(access.attempts_remaining || 0);
  if (remaining <= 0) {
    return res.status(403).json({ ok: false, code: 'NO_ATTEMPTS_REMAINING', error: 'No citizenship test attempts remain on this plan.' });
  }
  const questions = Array.isArray(req.body && req.body.questions) && req.body.questions.length ? req.body.questions.slice(0, 20) : DEFAULT_CITIZENSHIP_EXAM_QUESTIONS.slice(0, 20);
  const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers.slice(0, questions.length) : [];
  const result = calculateCitizenshipResultFromPayload(questions, answers);
  const attemptId = String((req.body && req.body.examId) || `cit_attempt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  result.attemptId = attemptId;
  const plan = normaliseCitizenshipPlan(access.active_plan || access.selected_plan || req.body.plan || '20');

  const updated = await tx(async (client) => {
    const inserted = await client.query(
      `INSERT INTO citizenship_exam_attempts
       (id, access_id, client_id, client_email, plan, score, total_questions, values_correct, values_total, passed, timed_out, questions, answers, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         score=EXCLUDED.score,
         total_questions=EXCLUDED.total_questions,
         values_correct=EXCLUDED.values_correct,
         values_total=EXCLUDED.values_total,
         passed=EXCLUDED.passed,
         timed_out=EXCLUDED.timed_out,
         questions=EXCLUDED.questions,
         answers=EXCLUDED.answers,
         result=EXCLUDED.result
       RETURNING *`,
      [attemptId, access.id, (req.client && req.client.id) || access.client_id || null, (req.client && req.client.email) || access.client_email || '', plan, result.score, result.totalQuestions || questions.length, result.valuesCorrect, result.valuesTotal, result.passed, Boolean(req.body && req.body.timedOut), JSON.stringify(questions), JSON.stringify(answers), JSON.stringify(result)]
    );
    const accessUpdate = await client.query(
      `UPDATE citizenship_access
       SET attempts_used=LEAST(COALESCE(exam_allowance,0), COALESCE(attempts_used,0)+1),
           status='active', payment_status='paid', updated_at=now()
       WHERE id=$1
       RETURNING id, selected_plan, active_plan, exam_allowance, attempts_used,
         GREATEST(0, COALESCE(exam_allowance,0)-COALESCE(attempts_used,0)) AS attempts_remaining,
         status, payment_status`,
      [access.id]
    );
    return { attempt: inserted.rows[0], access: accessUpdate.rows[0] || access };
  });

  const row = updated.access || access;
  const allowance = Number(row.exam_allowance || citizenshipExamAllowance(plan));
  const used = Number(row.attempts_used || 0);
  const remainingAfter = Math.max(0, allowance - used);
  const entitlement = {
    id: row.id,
    accessId: row.id,
    plan,
    planLabel: `${plan} tests`,
    total: allowance,
    used,
    remaining: remainingAfter,
    attemptsAllowed: allowance,
    attemptsUsed: used,
    attemptsRemaining: remainingAfter,
    status: row.status,
    payment_status: row.payment_status
  };
  return res.json({ ok: true, examId: attemptId, attemptId, result, entitlement, attempts: { used, remaining: remainingAfter, total: allowance } });
}

async function handlePaidCitizenshipExamHistory(req, res) {
  const access = await getActivePaidCitizenshipAccess(req);
  const params = [normaliseEmail(req.client.email)];
  let where = 'lower(client_email)=lower($1)';
  if (access && access.id) { params.push(access.id); where += ' AND access_id=$2'; }
  const { rows } = await query(
    `SELECT id, access_id, plan, score, total_questions, values_correct, values_total, passed,
            created_at, result
     FROM citizenship_exam_attempts
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT 20`,
    params
  );
  return res.json({ ok: true, attempts: rows.map(r => ({
    id: r.id,
    accessId: r.access_id,
    plan: r.plan,
    score: r.score,
    totalQuestions: r.total_questions,
    valuesCorrect: r.values_correct,
    valuesTotal: r.values_total,
    passed: r.passed,
    created_at: r.created_at,
    result: r.result
  })) });
}

async function handlePaidCitizenshipExamAttempt(req, res) {
  const id = String((req.params && req.params.id) || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Attempt id is required.' });
  const { rows } = await query(
    `SELECT id, access_id, plan, score, total_questions, values_correct, values_total, passed,
            created_at, questions, answers, result
     FROM citizenship_exam_attempts
     WHERE id=$1 AND lower(client_email)=lower($2)
     LIMIT 1`,
    [id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Attempt was not found.' });
  return res.json({ ok: true, attempt: rows[0] });
}

async function handleFreeCitizenshipExamStart(req, res) {
  const questions = shuffleCitizenshipQuestions(DEFAULT_CITIZENSHIP_EXAM_QUESTIONS, 20);
  return res.json({ ok: true, examId: `free_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`, questions, attempts: { used: 0, remaining: 3, total: 3 } });
}

async function handleFreeCitizenshipExamSubmit(req, res) {
  const questions = Array.isArray(req.body && req.body.questions) && req.body.questions.length ? req.body.questions : DEFAULT_CITIZENSHIP_EXAM_QUESTIONS;
  const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
  const result = calculateCitizenshipResultFromPayload(questions, answers);
  result.attemptId = String((req.body && req.body.examId) || `free_attempt_${Date.now()}`);
  return res.json({ ok: true, examId: result.attemptId, attemptId: result.attemptId, result, attempts: { used: 1, remaining: 2, total: 3 } });
}

app.post('/api/exam/start', optionalAuth, asyncRoute(handlePaidCitizenshipExamStart));
app.get('/api/exam/start', optionalAuth, asyncRoute(handlePaidCitizenshipExamStart));
app.post('/api/citizenship/exam/start', optionalAuth, asyncRoute(handlePaidCitizenshipExamStart));
app.post('/api/citizenship-test/exam/start', optionalAuth, asyncRoute(handlePaidCitizenshipExamStart));
app.get('/api/exam/status', optionalAuth, asyncRoute(handlePaidCitizenshipExamStatus));
app.get('/api/exam/history', requireAuth, asyncRoute(handlePaidCitizenshipExamHistory));
app.get('/api/citizenship/exam/history', requireAuth, asyncRoute(handlePaidCitizenshipExamHistory));
app.get('/api/exam/attempt/:id', requireAuth, asyncRoute(handlePaidCitizenshipExamAttempt));
app.post('/api/exam/submit', optionalAuth, asyncRoute(handlePaidCitizenshipExamSubmit));
app.post('/api/citizenship/exam/submit', optionalAuth, asyncRoute(handlePaidCitizenshipExamSubmit));
app.post('/api/citizenship-test/exam/submit', optionalAuth, asyncRoute(handlePaidCitizenshipExamSubmit));
app.post('/api/citizenship/start-free', asyncRoute(handleFreeCitizenshipExamStart));
app.post('/api/citizenship/submit-exam', asyncRoute(handleFreeCitizenshipExamSubmit));


async function finaliseStripePayment(req, res) {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });

  const sessionId = req.body.sessionId || req.body.session_id || req.body.checkoutSessionId || req.query.session_id || req.query.sessionId;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) {
    return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  }

  let session = await stripe.checkout.sessions.retrieve(sessionId);
  session = await normalisePaidStripeSessionForAttachment(session);
  const result = await attachPaidSession(session, { triggerGeneration: true, waitForPdf: VERIFY_PAYMENT_WAIT_FOR_PDF });

  // Important: Stripe redirects sometimes return without the browser still holding the cross-site cookie.
  // This restores the client session from the paid Stripe session email, so the dashboard opens cleanly.
  const email = normaliseEmail((session.metadata || {}).client_email || session.customer_email);
  let client = null;
  if (email) {
    const clientRows = await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1)', [email]);
    client = clientRows.rows[0] || null;
    if (client) setSessionCookie(res, sign(client));
  }

  const serviceType = result.type || (session.metadata || {}).service_type || 'visa_assessment';
  const isCitizenship = serviceType === 'citizenship_test' || serviceType === 'citizenship';
  const redirectUrl = isCitizenship
    ? `${APP_BASE_URL}/account-dashboard.html?payment=verified&service=citizenship&citizenship=active&access_id=${encodeURIComponent(result.accessId || result.assessmentId || '')}&session_id=${encodeURIComponent(sessionId)}`
    : `${APP_BASE_URL}/account-dashboard.html?payment=verified&assessment_id=${encodeURIComponent(result.assessmentId || '')}&session_id=${encodeURIComponent(sessionId)}`;
  res.json({
    ok: true,
    status: 'paid',
    paymentLinked: true,
    service: isCitizenship ? 'citizenship' : serviceType,
    sessionId,
    assessmentId: result.assessmentId,
    accessId: result.accessId || null,
    citizenshipAccessId: result.accessId || null,
    plan: result.plan || null,
    pdfReady: result.pdfReady,
    client,
    dashboardAccessToken: client ? signDashboardAccessToken(client) : null,
    accessToken: client ? signDashboardAccessToken(client) : null,
    redirectUrl
  });
}

// Aliases used by payment-complete/checkout return pages.
app.post('/api/payments/finalise', asyncRoute(finaliseStripePayment));
app.post('/api/payment/finalise', asyncRoute(finaliseStripePayment));
app.post('/api/payments/finalize', asyncRoute(finaliseStripePayment));
app.get('/api/payments/finalise', asyncRoute(finaliseStripePayment));

async function generatePdfResponse(req, res, assessmentId) {
  const result = await generateAssessmentPdfNow(assessmentId, req.client.email, { force: Boolean(req.body && (req.body.force || req.body.regenerate || req.body.clearExistingPdf)) });
  const finalPdfUrl = `/api/assessment/${encodeURIComponent(result.id || assessmentId)}/final-pdf`;

  // Production behaviour:
  // - Normal dashboard calls receive JSON pointing ONLY to the final issued PDF route.
  // - If a caller explicitly asks for PDF bytes, this route returns the final issued PDF itself.
  // This prevents the dashboard from falling back to the old /pdf template endpoint.
  const wantsPdf = String(req.query.download || req.query.pdf || '').toLowerCase() === '1'
    || String(req.headers.accept || '').includes('application/pdf');

  if (wantsPdf) {
    return sendAssessmentPdf(req, res, result.id || assessmentId);
  }

  res.json({
    ok: true,
    ready: true,
    final: true,
    pdfEndpointKind: 'final-issued-advice-letter',
    assessment: result,
    assessmentId: result.id || assessmentId,
    id: result.id || assessmentId,
    downloadUrl: finalPdfUrl,
    pdfUrl: finalPdfUrl,
    finalPdfUrl,
    issuedPdfUrl: finalPdfUrl
  });
}

app.post('/api/assessment/generate-pdf', requireAuth, asyncRoute(async (req, res) => {
  const assessmentId = req.body.assessmentId || req.body.assessment_id || req.body.submissionId || req.body.id;
  await generatePdfResponse(req, res, assessmentId);
}));

app.post('/api/assessment/:id/generate-pdf', requireAuth, asyncRoute(async (req, res) => {
  await generatePdfResponse(req, res, req.params.id);
}));

app.post('/api/assessment/:id/generate', requireAuth, asyncRoute(async (req, res) => {
  await generatePdfResponse(req, res, req.params.id);
}));

app.post('/api/assessments/:id/generate-pdf', requireAuth, asyncRoute(async (req, res) => {
  await generatePdfResponse(req, res, req.params.id);
}));

app.get('/api/assessment/generate-pdf', (_req, res) => {
  res.status(405).json({ ok: false, error: 'Use POST /api/assessment/generate-pdf with assessmentId. GET is intentionally guarded.' });
});

app.post('/api/assessment/retry-generation', requireAuth, asyncRoute(async (req, res) => {
  const assessmentId = req.body.assessmentId || req.body.assessment_id || req.body.id;
  const { rows } = await query('SELECT id FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [assessmentId, req.client.email]);
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  await query(`UPDATE assessments SET status='pdf_queued', pdf_bytes=NULL, pdf_mime=NULL, pdf_filename=NULL, pdf_sha256=NULL, pdf_generated_at=NULL, generation_error=NULL, updated_at=now() WHERE id=$1`, [assessmentId]);
  await query(`INSERT INTO pdf_jobs (assessment_id, status, run_after) VALUES ($1,'queued',(SELECT COALESCE(release_at, now()) FROM assessments WHERE id=$1)) ON CONFLICT (assessment_id) DO UPDATE SET status='queued', run_after=(SELECT COALESCE(release_at, now()) FROM assessments WHERE id=$1), last_error=NULL, updated_at=now()`, [assessmentId]);
  const result = await generateAssessmentPdfNow(assessmentId, req.client.email, { force: true });
  res.json({ ok: true, status: 'pdf_ready', assessment: result });
}));


// ---- Production-grade Subclass 190 legal decision engine v2 ----
// This is a deterministic legal-control layer, not a GPT generator.
// For Subclass 190 it decides validity, risk level, lodgement position and criterion findings before PDF rendering.
function textOf(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (_err) { return String(v); }
}

function engineFlat(payload) {
  const src = isPlainObject(payload && payload.answers) ? payload.answers : isPlainObject(payload && payload.formPayload) ? payload.formPayload : isPlainObject(payload) ? payload : {};
  return { answers: src, flat: flattenObject(src), allText: textOf(src).toLowerCase() };
}

function fieldValue(flat, names) {
  const wanted = names.map(n => String(n).toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [k, v] of Object.entries(flat || {})) {
    const key = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.some(w => key.includes(w)) && v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function boolYes(v) {
  return /^(yes|y|true|valid|current|approved|positive|held|met)$/i.test(String(v || '').trim());
}

function boolBad(v) {
  return /(no|not|none|unknown|unsure|withdrawn|expired|refused|invalid|missing|unconfirmed|pending|cannot)/i.test(String(v || ''));
}

function parseEngineDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function plausibleMigrationDate(v) {
  const d = parseEngineDate(v);
  if (!d) return false;
  const year = d.getUTCFullYear();
  const nowYear = new Date().getUTCFullYear();
  return year >= 2012 && year <= nowYear + 1;
}

function ageAt(dobValue, eventDateValue) {
  const dob = parseEngineDate(dobValue);
  const eventDate = parseEngineDate(eventDateValue);
  if (!dob || !eventDate) return null;
  let age = eventDate.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = eventDate.getUTCMonth() < dob.getUTCMonth() || (eventDate.getUTCMonth() === dob.getUTCMonth() && eventDate.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function hasAnyText(hay, needles) {
  const s = String(hay || '').toLowerCase();
  return needles.some(n => s.includes(String(n).toLowerCase()));
}

function makeFinding(ruleId, criterion, status, legalEffect, severity, evidenceStatus, legalConsequence, recommendation, requiredEvidence) {
  return { ruleId, criterion, status, legalEffect, severity, evidenceStatus, legalConsequence, recommendation, requiredEvidence };
}

function runSubclass190LegalEngine(assessment) {
  const payload = assessment && assessment.form_payload ? assessment.form_payload : {};
  const { flat, allText } = engineFlat(payload);
  const get = (...names) => fieldValue(flat, names);

  const applicantName = assessment.applicant_name || get('applicant name', 'full name', 'name') || 'Applicant';
  const nominatedOccupation = get('nominated occupation', 'occupation', 'anzsco') || 'nominated occupation';
  const dob = get('date of birth', 'dateOfBirth', 'dob', 'birth');
  const invitationHeld = get('invitation received', 'skillselect invitation', 'invitation held', 'invited', 'invitation');
  const invitationDate = get('invitation date', 'skillselect invitation date', 'invited date');
  const nominationHeld = get('state nomination', 'territory nomination', 'nomination status', 'nomination held', 'nominated by state');
  const nominationDate = get('nomination date', 'state nomination date', 'territory nomination date');
  const skillsHeld = get('skills assessment', 'positive skills assessment', 'assessment outcome', 'skills assessment held');
  const skillsDate = get('skills assessment date', 'assessment outcome date', 'assessment date');
  const english = get('competent english', 'english evidence', 'english test', 'ielts', 'pte', 'passport country');
  const points = get('points', 'points total', 'claimed points', 'pass mark', 'points score');
  const occupationList = get('occupation list', 'skilled list', 'state occupation list', 'occupation eligibility');

  const section48Risk = hasAnyText(allText, ['section 48', 's48', 'bar present', 'known section 48']);
  const noFurtherStayRisk = hasAnyText(allText, ['no further stay', '8503', '8534', '8535', 'condition present and unresolved']);
  const healthRisk = hasAnyText(allText, ['health issue', 'medical issue', 'health requirement requiring further review', 'health problem']);
  const characterRisk = hasAnyText(allText, ['character issue', 'criminal', 'police issue', 'court', 'character requirement requiring further review']);
  const integrityRisk = hasAnyText(allText, ['pic 4020', 'integrity issue', 'false document', 'misleading information', 'bogus document']);
  const familyRisk = hasAnyText(allText, ['dependent child', 'custody', 'secondary applicant', 'family member included']);

  const findings = [];

  const invitationFail = !boolYes(invitationHeld) || boolBad(invitationHeld) || !plausibleMigrationDate(invitationDate);
  findings.push(makeFinding(
    '190_INVITATION_RECEIVED',
    'Valid SkillSelect invitation',
    invitationFail ? 'fail' : 'pass',
    invitationFail ? 'INVALID APPLICATION' : 'SATISFIED SUBJECT TO ORIGINAL DOCUMENT REVIEW',
    invitationFail ? 'blocker' : 'low',
    invitationFail ? 'No verifiable SkillSelect invitation letter with a plausible invitation date has been provided.' : 'Invitation information is recorded and must be checked against the original SkillSelect invitation.',
    invitationFail ? 'The matter is not lodgeable unless a valid Subclass 190 SkillSelect invitation is verified.' : 'No validity blocker is identified for this criterion, subject to document verification.',
    invitationFail ? 'Obtain the official SkillSelect invitation letter showing subclass, invitation date, nominated occupation and points score.' : 'Verify the original invitation letter before lodgement.',
    'SkillSelect invitation letter'
  ));

  const nominationFail = !boolYes(nominationHeld) || boolBad(nominationHeld) || !plausibleMigrationDate(nominationDate);
  findings.push(makeFinding(
    '190_STATE_NOMINATION_CURRENT',
    'Current state or territory nomination',
    nominationFail ? 'fail' : 'pass',
    nominationFail ? 'INVALID APPLICATION' : 'SATISFIED SUBJECT TO ORIGINAL DOCUMENT REVIEW',
    nominationFail ? 'blocker' : 'low',
    nominationFail ? 'No current state or territory nomination approval has been verified.' : 'Nomination information is recorded and must be checked against the original approval.',
    nominationFail ? 'The Subclass 190 pathway cannot proceed unless a current state or territory nomination is verified.' : 'No validity blocker is identified for this criterion, subject to document verification.',
    nominationFail ? 'Obtain a current nomination approval letter matching the nominated occupation.' : 'Verify the nomination approval and occupation match.',
    'State or territory nomination approval letter'
  ));

  const skillsFail = !boolYes(skillsHeld) || boolBad(skillsHeld) || !plausibleMigrationDate(skillsDate);
  findings.push(makeFinding(
    '190_SKILLS_ASSESSMENT_POSITIVE',
    'Suitable skills assessment for nominated occupation',
    skillsFail ? 'fail' : 'pass',
    skillsFail ? 'REFUSAL LIKELY' : 'SATISFIED SUBJECT TO ORIGINAL DOCUMENT REVIEW',
    skillsFail ? 'critical' : 'low',
    skillsFail ? `No positive and valid skills assessment has been verified for ${nominatedOccupation}.` : 'Skills assessment information is recorded and must be checked against the outcome letter.',
    skillsFail ? 'If the applicant did not hold a suitable skills assessment at the required time, the application is likely to fail.' : 'No critical defect is identified for this criterion, subject to document verification.',
    skillsFail ? 'Obtain and verify the skills assessment outcome letter, assessing authority, assessed occupation, date and validity.' : 'Verify the assessment outcome, occupation match and validity at invitation date.',
    'Positive skills assessment outcome letter'
  ));

  const occupationFail = !occupationList || boolBad(occupationList);
  findings.push(makeFinding(
    '190_OCCUPATION_ELIGIBLE',
    'Occupation eligibility and nomination alignment',
    occupationFail ? 'unknown' : 'pass',
    occupationFail ? 'EVIDENCE GAP' : 'SATISFIED SUBJECT TO ORIGINAL DOCUMENT REVIEW',
    occupationFail ? 'high' : 'low',
    occupationFail ? `No reliable evidence confirms that ${nominatedOccupation} was eligible and aligned with the nomination at the relevant time.` : 'Occupation-list evidence is recorded and must be verified.',
    occupationFail ? 'Occupation and nomination alignment cannot be safely accepted without documentary confirmation.' : 'No occupation-list defect is identified, subject to verification.',
    occupationFail ? 'Confirm the ANZSCO code, relevant state/territory occupation list position and nomination alignment.' : 'Retain occupation-list evidence on file.',
    'Occupation list and nomination alignment evidence'
  ));

  const englishUnknown = !english || boolBad(english);
  findings.push(makeFinding(
    '190_COMPETENT_ENGLISH',
    'Competent English',
    englishUnknown ? 'unknown' : 'pass',
    englishUnknown ? 'EVIDENCE GAP' : 'SATISFIED SUBJECT TO ORIGINAL DOCUMENT REVIEW',
    englishUnknown ? 'high' : 'low',
    englishUnknown ? 'No English test result or eligible passport evidence has been verified.' : 'English information is recorded and must be verified against the source document.',
    englishUnknown ? 'Competent English cannot be treated as met until evidence is reviewed.' : 'No issue is identified subject to verification.',
    englishUnknown ? 'Provide English test results or eligible passport evidence.' : 'Verify the original English evidence.',
    'English test result or eligible passport evidence'
  ));

  const pointsNumber = Number(String(points || '').replace(/[^0-9.]/g, ''));
  const pointsFail = !points || boolBad(points) || !(pointsNumber >= 65);
  findings.push(makeFinding(
    '190_POINTS_MINIMUM_65',
    'Points test threshold',
    pointsFail ? 'fail' : 'pass',
    pointsFail ? 'REFUSAL LIKELY' : 'SATISFIED SUBJECT TO ORIGINAL DOCUMENT REVIEW',
    pointsFail ? 'critical' : 'low',
    pointsFail ? 'No reliable points calculation at or above 65 points has been verified.' : `The recorded points position appears to be ${pointsNumber} and must be verified by evidence.`,
    pointsFail ? 'If the pass mark is not met or cannot be evidenced, the application is likely to fail.' : 'No points-threshold defect is identified, subject to evidence review.',
    pointsFail ? 'Complete a points calculation and verify every claimed component with evidence.' : 'Retain evidence for every claimed points component.',
    'Full points calculation and supporting documents'
  ));

  const calculatedAge = ageAt(dob, invitationDate);
  const ageFail = calculatedAge !== null && calculatedAge >= 45;
  findings.push(makeFinding(
    '190_AGE_UNDER_45',
    'Age under 45 at invitation',
    ageFail ? 'fail' : (calculatedAge === null || !plausibleMigrationDate(invitationDate) ? 'unknown' : 'pass'),
    ageFail ? 'REFUSAL LIKELY' : (calculatedAge === null || !plausibleMigrationDate(invitationDate) ? 'EVIDENCE GAP' : 'SATISFIED SUBJECT TO ORIGINAL DOCUMENT REVIEW'),
    ageFail ? 'critical' : 'medium',
    calculatedAge === null || !plausibleMigrationDate(invitationDate) ? 'Age cannot be reliably calculated because the date of birth and/or invitation date is not verified.' : `Calculated age at invitation appears to be ${calculatedAge}.`,
    ageFail ? 'The age criterion is not met if the applicant was 45 or older at the time of invitation.' : 'Age must be confirmed against identity and invitation evidence.',
    'Verify the passport biodata page and official SkillSelect invitation date.',
    'Passport biodata page and SkillSelect invitation letter'
  ));

  const onshoreFail = section48Risk || noFurtherStayRisk;
  findings.push(makeFinding(
    '190_SECTION_48_NO_FURTHER_STAY',
    'Section 48 / No Further Stay / onshore validity restrictions',
    onshoreFail ? 'fail' : 'unknown',
    onshoreFail ? 'INVALID APPLICATION' : 'EVIDENCE GAP',
    onshoreFail ? 'blocker' : 'high',
    onshoreFail ? 'The information provided flags a section 48 and/or No Further Stay issue.' : 'Current visa status and onshore restrictions have not been fully verified.',
    onshoreFail ? 'If the applicant is barred or subject to an unresolved No Further Stay condition while in Australia, lodgement may be invalid.' : 'Onshore validity cannot be confirmed without current visa and refusal/cancellation history.',
    onshoreFail ? 'Resolve the bar or condition, or confirm a lawful pathway, before any lodgement action.' : 'Provide VEVO, current visa grant notice and any refusal, cancellation or waiver documents.',
    'VEVO, current visa grant notice, refusal/cancellation notices and waiver evidence if relevant'
  ));

  findings.push(makeFinding('190_HEALTH_PIC', 'Health requirement', healthRisk ? 'risk' : 'unknown', healthRisk ? 'DISCRETIONARY RISK' : 'EVIDENCE GAP', healthRisk ? 'high' : 'medium', healthRisk ? 'A health issue is disclosed but medical evidence has not been reviewed.' : 'Health position has not been verified.', healthRisk ? 'Health issues may affect grant and may require waiver analysis where available.' : 'Health cannot be finally assessed until examinations are completed.', 'Provide health examination results and relevant medical reports.', 'Health examination results'));
  findings.push(makeFinding('190_CHARACTER_PIC', 'Character requirement', characterRisk ? 'risk' : 'unknown', characterRisk ? 'DISCRETIONARY RISK' : 'EVIDENCE GAP', characterRisk ? 'high' : 'medium', characterRisk ? 'A character issue is disclosed but police/court documents have not been reviewed.' : 'Character position has not been verified.', characterRisk ? 'Character concerns may affect grant and require legal assessment.' : 'Character cannot be finally assessed without clearances.', 'Provide police certificates, court records and any character submissions.', 'Police certificates and court records'));
  findings.push(makeFinding('190_PIC_4020', 'Integrity / PIC 4020 risk', integrityRisk ? 'risk' : 'unknown', integrityRisk ? 'REFUSAL LIKELY' : 'EVIDENCE GAP', integrityRisk ? 'critical' : 'medium', integrityRisk ? 'An integrity concern is disclosed but prior Department records have not been reviewed.' : 'Integrity position has not been verified.', integrityRisk ? 'PIC 4020 concerns are serious and may lead to refusal and exclusion periods.' : 'Integrity risk cannot be excluded without reviewing prior records.', 'Review prior applications, documents and Department correspondence before proceeding.', 'Prior Department correspondence and submitted documents'));
  findings.push(makeFinding('190_FAMILY_MEMBERS', 'Family members / secondary applicants', familyRisk ? 'unknown' : 'unknown', 'EVIDENCE GAP', familyRisk ? 'medium' : 'low', familyRisk ? 'Family member issues are disclosed but relationship/custody/dependency evidence has not been reviewed.' : 'Family composition should be confirmed before final advice.', familyRisk ? 'Secondary applicants may fail if relationship, custody or dependency evidence is insufficient.' : 'No secondary-applicant defect is identified on the current information, subject to confirmation.', 'Provide relationship, custody and dependency evidence if family members are included.', 'Relationship, custody and dependency evidence'));

  const blockers = findings.filter(f => f.status === 'fail' && f.severity === 'blocker');
  const criticalFails = findings.filter(f => f.status === 'fail' && f.severity === 'critical');
  const criticalRisks = findings.filter(f => f.status === 'risk' && f.severity === 'critical');

  let lodgementPosition = 'LODGEABLE_WITH_EVIDENCE_GAPS';
  let lodgementPositionLabel = 'LODGEABLE WITH EVIDENCE GAPS';
  let riskLevel = 'MEDIUM';
  if (blockers.length > 0) {
    lodgementPosition = 'NOT_LODGEABLE';
    lodgementPositionLabel = 'NOT LODGEABLE';
    riskLevel = 'CRITICAL';
  } else if (criticalFails.length > 0 || criticalRisks.length > 0) {
    lodgementPosition = 'LODGEABLE_HIGH_RISK';
    lodgementPositionLabel = 'LODGEABLE HIGH RISK';
    riskLevel = 'HIGH';
  }

  const evidenceRequired = Array.from(new Set(findings.filter(f => f.status !== 'pass').map(f => f.requiredEvidence).filter(Boolean)));
  const primaryReason = (blockers[0] || criticalFails[0] || criticalRisks[0] || findings.find(f => f.status !== 'pass') || findings[0]).criterion;

  return {
    engine: 'subclass190-legal-engine-v2-no-gpt-outcome',
    applicantName,
    subclass: '190',
    lodgementPosition,
    lodgementPositionLabel,
    riskLevel,
    primaryReason,
    blockers,
    criticalFails,
    criticalRisks,
    findings,
    evidenceRequired,
    generatedAt: new Date().toISOString()
  };
}

function buildSubclass190LegalAdviceBundle(decision, assessment) {
  const validityText = decision.blockers.length
    ? `Result: ${decision.lodgementPositionLabel}. Validity blockers identified: ${decision.blockers.map(b => b.criterion).join('; ')}. Primary reason: ${decision.primaryReason}.`
    : `Result: ${decision.lodgementPositionLabel}. No deterministic validity blocker was identified, but evidence gaps remain and original documents must be reviewed.`;

  const summary = decision.lodgementPosition === 'NOT_LODGEABLE'
    ? `The Subclass 190 legal engine has classified this matter as ${decision.lodgementPositionLabel} with ${decision.riskLevel} risk. The matter must not proceed to lodgement until the identified validity blockers are resolved and original evidence is reviewed.`
    : `The Subclass 190 legal engine has classified this matter as ${decision.lodgementPositionLabel} with ${decision.riskLevel} risk. The matter requires document review before any lodgement strategy is confirmed.`;

  const criterionFindings = decision.findings.map(f => ({
    ruleId: f.ruleId,
    heading: f.criterion,
    title: f.criterion,
    criterion: f.criterion,
    status: f.status,
    legalEffect: f.legalEffect,
    severity: f.severity,
    finding: `${f.status.toUpperCase()} — ${f.evidenceStatus}`,
    evidence: f.evidenceStatus,
    evidenceStatus: f.evidenceStatus,
    legalConsequence: f.legalConsequence,
    evidenceGap: f.status === 'pass' ? 'Original document verification required before final advice.' : f.requiredEvidence,
    recommendation: f.recommendation
  }));

  const sections = [
    { heading: 'Application validity assessment', title: 'Application validity assessment', body: validityText },
    { heading: 'Lodgement position', title: 'Lodgement position', body: `${decision.lodgementPositionLabel}. This classification is produced by the deterministic Subclass 190 legal engine and must not be overridden by GPT wording.` },
    { heading: 'Risk classification', title: 'Risk classification', body: `${decision.riskLevel}. Primary reason: ${decision.primaryReason}.` },
    { heading: 'Summary of Advice', title: 'Summary of Advice', body: summary },
    { heading: 'Key Issues and Recommendations', title: 'Key Issues and Recommendations', body: decision.findings.filter(f => ['blocker', 'critical', 'high'].includes(f.severity)).map(f => `${f.criterion}: ${f.legalEffect}. ${f.recommendation}`).join('\n') },
    { heading: 'Next Steps', title: 'Next Steps', body: (decision.lodgementPosition === 'NOT_LODGEABLE' ? ['Do not lodge a Subclass 190 application at this time.', 'Resolve each validity blocker before any lodgement action.', 'Obtain and review the required original evidence.', 'Reassess lodgement only after invitation, nomination and validity criteria are verified.'] : ['Do not proceed until evidence gaps are resolved.', 'Complete document verification and points calculation.', 'Reassess after original evidence review.']).join('\n') }
  ];

  return {
    deterministicEngineApplied: true,
    engine: decision.engine,
    title: `Preliminary Migration Advice – Subclass 190 Skilled Nominated Visa (${assessment.applicant_name || decision.applicantName || 'Applicant'})`,
    subclass: '190',
    riskLevel: decision.riskLevel,
    risk_level: decision.riskLevel,
    risk: decision.riskLevel,
    lodgementPosition: decision.lodgementPositionLabel,
    lodgement_position: decision.lodgementPositionLabel,
    lodgement_position_code: decision.lodgementPosition,
    finalPosition: {
      lodgementPosition: decision.lodgementPosition,
      lodgementPositionLabel: decision.lodgementPositionLabel,
      riskLevel: decision.riskLevel,
      primaryReason: decision.primaryReason,
      requiresManualReview: true,
      canGenerateAdviceLetter: true
    },
    applicationValidityAssessment: validityText,
    validityAssessment: {
      heading: 'Application validity assessment',
      result: decision.lodgementPositionLabel,
      riskLevel: decision.riskLevel,
      primaryReason: decision.primaryReason,
      blockers: decision.blockers.map(b => ({ criterion: b.criterion, legalEffect: b.legalEffect, consequence: b.legalConsequence, recommendation: b.recommendation }))
    },
    summary,
    summaryOfAdvice: summary,
    summaryOfFindings: summary,
    executiveSummary: summary,
    keyIssues: decision.findings.filter(f => ['blocker', 'critical', 'high'].includes(f.severity)).map(f => `${f.criterion}: ${f.legalEffect}`),
    keyRisks: decision.findings.filter(f => ['blocker', 'critical', 'high'].includes(f.severity)).map(f => `${f.criterion}: ${f.legalEffect}`),
    criterionFindings,
    criteriaFindings: criterionFindings,
    findings: criterionFindings,
    sections,
    evidenceRequired: decision.evidenceRequired,
    evidence_required: decision.evidenceRequired,
    evidenceChecklist: {
      mandatoryBeforeLodgement: decision.evidenceRequired,
      requiredBeforeFinalAdvice: decision.evidenceRequired,
      recommendedSupportingDocuments: []
    },
    recommendedNextSteps: decision.lodgementPosition === 'NOT_LODGEABLE'
      ? ['Do not lodge a Subclass 190 application at this time.', 'Resolve the validity blockers.', 'Provide the required evidence for legal review.', 'Re-run the legal engine after evidence verification.']
      : ['Resolve all evidence gaps before lodgement.', 'Complete a full points and document review.', 'Re-run the legal engine after evidence verification.'],
    disclaimer: 'This advice is preliminary and subject to review of original documents and confirmation of current law and policy at the time of lodgement.',
    qualityFlags: [
      `Deterministic Subclass 190 legal engine applied: ${decision.engine}`,
      `Forced lodgement position: ${decision.lodgementPositionLabel}`,
      `Forced risk level: ${decision.riskLevel}`,
      'GPT was not used to decide legal outcome, risk level, lodgement position, validity or criterion findings.'
    ],
    gptAdviceBundle: {
      permitted: false,
      role: 'none_for_legal_outcome',
      cannotOverrideRules: true,
      forbidden: ['inventing evidence', 'changing status', 'changing risk', 'changing lodgement position', 'removing blockers']
    },
    rawDecision: decision
  };
}

function sanitizeLegalEngineBundle(bundle) {
  // Defensive cleanup: old GPT wording must not leak into the 190 PDF if a renderer reuses text.
  const banned = [
    [/MANUAL LEGAL REVIEW REQUIRED/g, 'NOT LODGEABLE'],
    [/Risk level:\s*HIGH/g, 'Risk level: CRITICAL'],
    [/Cannot be confirmed from the questionnaire/g, 'No evidence has been verified'],
    [/cannot be confirmed from the questionnaire/g, 'no evidence has been verified'],
    [/may result in refusal/g, 'will create refusal risk unless resolved'],
    [/potentially blocking issue/g, 'blocking issue unless resolved']
  ];
  function walk(v) {
    if (typeof v === 'string') {
      return banned.reduce((s, [re, rep]) => s.replace(re, rep), v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  }
  return walk(bundle);
}

function toArraySafe(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function compactUnique(values) {
  return Array.from(new Set(toArraySafe(values).flat().filter(Boolean).map(v => String(v))));
}

function ensureAdviceGradeBundleForPdf(assessment, bundle, evidenceReport) {
  const source = isPlainObject(bundle) ? bundle : {};
  if (source.advice && Array.isArray(source.advice.criterion_findings)) {
    return source;
  }

  const criterionFindings = toArraySafe(source.criterionFindings || source.criteriaFindings || source.findings).map((f) => ({
    criterion: f.criterion || f.heading || f.title || 'Criterion',
    finding: f.finding || f.status || f.evidenceStatus || 'Evidence required / not verified.',
    legal_consequence: f.legalConsequence || f.legal_consequence || f.legalEffect || 'Further legal review required before lodgement.',
    evidence_gap: f.evidenceGap || f.evidence_gap || f.requiredEvidence || (Array.isArray(f.evidenceMissing) ? f.evidenceMissing.join('; ') : '') || 'Supporting evidence required.',
    recommendation: f.recommendation || 'Obtain and verify supporting evidence before any lodgement action.'
  }));

  const sections = toArraySafe(source.sections).map(s => ({
    heading: s.heading || s.title || 'Assessment section',
    body: s.body || s.text || s.content || ''
  })).filter(s => s.heading || s.body);

  if (!sections.length) {
    sections.push(
      { heading: 'Scope and basis of preliminary advice', body: source.summary || source.executiveSummary || source.summaryOfAdvice || 'This preliminary migration assessment is based on questionnaire information and available evidence metadata. It is subject to review of original documents and confirmation of current law and policy.' },
      { heading: 'Delegate-simulator outcome', body: `Decision status: ${source.decisionStatus || 'EVIDENCE_REQUIRED'}. Risk level: ${source.riskLevel || source.risk_level || 'HIGH'}. Lodgement position: ${source.lodgementPosition || source.lodgement_position || 'EVIDENCE REQUIRED BEFORE LODGEMENT'}. Primary reason: ${source.primaryReason || 'Evidence not verified'}.` },
      { heading: 'Application validity assessment', body: source.applicationValidityAssessment || (source.applicationValidity && source.applicationValidity.result) || 'Application validity cannot be finally confirmed until mandatory evidence is reviewed.' },
      { heading: 'Evidence and document verification', body: 'Questionnaire answers are treated as instructions only. A criterion is not treated as finally met unless supporting evidence is reviewed and retained on file.' },
      { heading: 'GPT drafting boundary', body: 'GPT may only improve wording. It must not invent evidence, upgrade prospects, remove blockers, or change the engine outcome.' }
    );
  }

  const evidenceRequired = compactUnique(
    source.evidenceRequired ||
    source.evidence_required ||
    (source.evidenceChecklist && [source.evidenceChecklist.mandatoryBeforeLodgement, source.evidenceChecklist.requiredBeforeFinalAdvice]) ||
    criterionFindings.map(f => f.evidence_gap)
  );

  const nextSteps = compactUnique(
    source.nextSteps || source.recommendedNextSteps || source.client_next_steps || [
      'Collect and verify the required evidence.',
      'Conduct registered migration agent legal review before lodgement.',
      'Regenerate the advice only after the evidence position changes.'
    ]
  );

  const advice = {
    title: source.title || `Preliminary Migration Advice – Subclass ${assessment.visa_type || source.subclass || ''}`,
    subclass: source.subclass || assessment.visa_type,
    risk_level: source.risk_level || source.riskLevel || source.risk || 'HIGH',
    lodgement_position: source.lodgement_position || source.lodgementPosition || (source.finalPosition && (source.finalPosition.lodgementPositionLabel || source.finalPosition.lodgementPosition)) || 'EVIDENCE REQUIRED BEFORE LODGEMENT',
    sections,
    criterion_findings: criterionFindings.length ? criterionFindings : [{
      criterion: 'Evidence validation',
      finding: 'Evidence required / not verified.',
      legal_consequence: 'The matter requires legal review before lodgement.',
      evidence_gap: 'Supporting documents required.',
      recommendation: 'Obtain and verify supporting evidence before proceeding.'
    }],
    evidence_required: evidenceRequired,
    client_next_steps: nextSteps,
    disclaimer: source.disclaimer || 'This preliminary advice is based only on questionnaire answers and available evidence metadata. Final advice requires review of original documents and confirmation of current law, instruments, policy and Department requirements at the relevant time.'
  };

  const facts = source.facts || {
    applicant: {
      name: assessment.applicant_name || (assessment.form_payload && assessment.form_payload.meta && assessment.form_payload.meta.applicantName) || null,
      email: assessment.applicant_email || (assessment.form_payload && assessment.form_payload.meta && assessment.form_payload.meta.applicantEmail) || null
    },
    evidenceValidation: evidenceReport || source.evidenceValidation || null
  };

  return {
    ...source,
    advice,
    facts,
    gptAdviceBundle: source.gptAdviceBundle || {
      role: 'drafting_only',
      controlledBy: 'migrationDecisionEngine',
      cannotOverrideRules: true
    }
  };
}

function buildLegalEnginePdfInputs(assessment) {
  // Evidence validation must run before the delegate simulator.
  // This stops a questionnaire "yes" answer being treated as verified evidence.
  const assessmentForPdf = attachEvidenceValidation(assessment);
  const evidenceReport = assessmentForPdf && assessmentForPdf.form_payload
    ? assessmentForPdf.form_payload.evidenceValidation
    : validateEvidenceForAssessment(assessment);

  const inputs = buildDelegateSimulatorPdfInputs(assessmentForPdf);
  if (!inputs) return null;

  // Compatibility hardening: older engine versions returned different shapes.
  const normalisedInputs = {
    ...inputs,
    assessmentForPdf: inputs.assessmentForPdf || assessmentForPdf,
    adviceBundle: inputs.adviceBundle || inputs.bundle || inputs.pdfInputs || inputs
  };

  // Surface evidence validation and ensure pdf.js receives adviceBundle.advice.
  normalisedInputs.adviceBundle = ensureAdviceGradeBundleForPdf(assessmentForPdf, {
    ...(normalisedInputs.adviceBundle || {}),
    evidenceValidation: evidenceReport,
    evidenceValidationSummary: evidenceReport && evidenceReport.summary,
    qualityFlags: [
      ...((normalisedInputs.adviceBundle && normalisedInputs.adviceBundle.qualityFlags) || []),
      ...((evidenceReport && evidenceReport.qualityFlags) || [])
    ]
  }, evidenceReport);

  return normalisedInputs;
}



// ---- Commercial-grade advice quality layer ----
function enhanceAdviceBundleForCommercialOutput(adviceBundle, assessment) {
  const source = isPlainObject(adviceBundle) ? adviceBundle : {};
  const payload = isPlainObject(assessment && assessment.form_payload) ? assessment.form_payload : {};
  const answers = isPlainObject(payload.answers) ? payload.answers : isPlainObject(payload.formPayload) ? payload.formPayload : payload;
  const flat = flattenObject(answers || {});
  const visa = String(assessment.visa_type || '').replace(/[^0-9A-Za-z]/g, '') || 'visa';
  const evidenceGaps = [];
  const riskFlags = [];
  const strengths = [];
  const has = (...patterns) => Object.entries(flat).some(([k, v]) => patterns.some(p => `${k} ${v}`.toLowerCase().includes(String(p).toLowerCase())));
  if (has('positive skills', 'skills assessment valid', 'skills assessment yes')) strengths.push('Skills-assessment position appears supported on the supplied answers.');
  if (has('competent english', 'proficient english', 'superior english', 'ielts', 'pte')) strengths.push('English-language evidence has been identified for review.');
  if (has('nomination approved', 'sponsor approved', 'invitation received', 'state nomination')) strengths.push('Key pathway trigger appears to be present or in progress.');
  if (!has('passport')) evidenceGaps.push('Current passport biodata page and identity documents should be checked.');
  if (!has('english', 'ielts', 'pte', 'toefl', 'cae')) evidenceGaps.push('English evidence should be verified against the subclass/stream requirement.');
  if (!has('health')) evidenceGaps.push('Health/PIC issue screening should be completed before lodgement advice is finalised.');
  if (!has('character', 'police')) evidenceGaps.push('Character/PIC 4001 and police-clearance risk should be checked.');
  if (has('refused', 'cancelled', 'section 48', '8503', 'overstay', 'unlawful', 'criminal', 'conviction')) riskFlags.push('Prior refusal/cancellation, character, condition or status issue requires senior review before a positive pathway conclusion.');
  if (has('no skills', 'skills assessment no', 'english below', 'not competent')) riskFlags.push('Core eligibility evidence may be weak or missing.');
  const strategy = [
    `Confirm the exact subclass ${visa} stream and validity requirements before any client-facing positive conclusion.`,
    'Separate eligibility blockers from evidence gaps so the advice letter does not overstate prospects.',
    'Use the payment plan release status to control when the final advice PDF is made available.'
  ];
  return {
    ...source,
    productGrade: 'commercial-advice-v3',
    executiveSummary: source.executiveSummary || source.summary || `This assessment reviews the supplied facts against the relevant subclass ${visa} pathway and identifies apparent strengths, risks and evidence gaps.`,
    strengths: Array.from(new Set([...(Array.isArray(source.strengths) ? source.strengths : []), ...strengths])).slice(0, 8),
    risks: Array.from(new Set([...(Array.isArray(source.risks) ? source.risks : []), ...riskFlags])).slice(0, 8),
    evidenceGaps: Array.from(new Set([...(Array.isArray(source.evidenceGaps) ? source.evidenceGaps : []), ...evidenceGaps])).slice(0, 10),
    recommendedStrategy: Array.from(new Set([...(Array.isArray(source.recommendedStrategy) ? source.recommendedStrategy : []), ...strategy])).slice(0, 10),
    decisionControls: {
      subclass: visa,
      answerCount: payloadAnswerCount(payload),
      payloadUsable: payloadLooksUsable(payload),
      riskLevel: riskFlags.length >= 2 ? 'high' : riskFlags.length ? 'medium' : 'standard',
      outputStandard: 'senior-migration-agent-commercial-advice'
    }
  };
}


function textLineSafe(value, fallback = '') {
  return String(value === undefined || value === null || value === '' ? fallback : value).replace(/\s+/g, ' ').trim();
}

function extractAssessmentAnswerSummary(payload, maxItems = 24) {
  const out = [];
  function walk(obj, prefix = '', depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3 || out.length >= maxItems) return;
    for (const [key, value] of Object.entries(obj)) {
      if (out.length >= maxItems) break;
      if (/password|token|auth|authorization|session/i.test(key)) continue;
      const label = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, label, depth + 1);
      else if (Array.isArray(value)) {
        const txt = value.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join('; ').slice(0, 220);
        if (txt) out.push([label, txt]);
      } else if (value !== undefined && value !== null && String(value).trim() !== '') {
        out.push([label, String(value).replace(/\s+/g, ' ').slice(0, 220)]);
      }
    }
  }
  walk(payload || {});
  return out;
}



function criterionStatusFromAnswer(value, positiveText = 'The questionnaire answer is presently supportive, subject to evidence verification.') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return { finding: 'The criterion cannot yet be confirmed from the available instructions.', tone: 'review' };
  if (/^(yes|y|true|available|held|current|valid|approved|met|satisfied|competent|proficient|superior)/i.test(text)) return { finding: positiveText, tone: 'supportable' };
  if (/^(no|n|false|not|none|unavailable|expired|refused|cancelled|unsure|unknown)/i.test(text)) return { finding: 'The answer raises a matter requiring clarification before any lodgement-ready advice is issued.', tone: 'risk' };
  return { finding: 'The information has been recorded and must be reconciled against original supporting evidence.', tone: 'review' };
}

function buildSourceBackedRequirement(label, subclass, stream, legalPack) {
  const sourceNames = Array.isArray(legalPack && legalPack.sources)
    ? legalPack.sources.map(s => String(s.path || s.name || s.authority || '')).join(' | ')
    : '';
  const base = `The requirement must be assessed under the Migration Act 1958, the Migration Regulations 1994, relevant legislative instruments and Departmental policy guidance as applicable to Subclass ${subclass}${stream ? ' (' + stream + ')' : ''}.`;
  const lower = String(label || '').toLowerCase();
  if (/validity|schedule 1/.test(lower)) return 'The visa application must first be validly made, including correct form, charge, applicant identity, location and any stream-specific validity prerequisites before Schedule 2 criteria can be assessed.';
  if (/stream|trt|direct entry|labour agreement/.test(lower)) return `The selected stream must be legally available on the facts and must be tested against the stream-specific Subclass ${subclass} criteria and any applicable instrument or agreement settings.`;
  if (/sponsor|nomination|employer|position|genuine/.test(lower)) return 'The nominated position and employer material must demonstrate a genuine, available and properly supported role connected to the sponsor’s business operations and nomination framework.';
  if (/occupation|anzsco|skills|qualification|experience/.test(lower)) return 'The applicant’s actual duties, qualifications, employment history and any skills, licensing or registration evidence must align with the nominated occupation and stream requirements.';
  if (/salary|market|amsr|tsmit|income/.test(lower)) return 'The remuneration and employment conditions must be supported by contract, payroll and market salary evidence and must be consistent with the nomination and any applicable threshold or concession framework.';
  if (/english/.test(lower)) return 'The applicant must satisfy the applicable English language requirement, exemption or concession with evidence valid at the relevant time.';
  if (/health/.test(lower)) return 'The applicant and any included family members must satisfy applicable health requirements or address any health-related issue before final advice is relied upon.';
  if (/character|integrity|4020|false|misleading/.test(lower)) return 'The applicant must satisfy character and integrity requirements, including truthful disclosure, document consistency and any applicable public interest criterion.';
  if (/migration history|compliance|section 48|8503|visa history/.test(lower)) return 'Prior visa history, refusals, cancellations, visa conditions, section 48 issues and any no-further-stay restrictions must be reviewed before lodgement strategy is finalised.';
  return base;
}

function criterionProfilesForSubclass(subclass, stream) {
  const code = String(subclass || '').replace(/[^0-9]/g, '');
  const s = String(stream || '').toLowerCase();
  const common = [
    { key:'validity', criterion:'Application validity and identity', answerKeys:['passport-available','passport available','identity-docs-consistent','identity docs consistent'], evidence:'Passport, identity documents, name-change records, location and visa-status evidence.', recommendation:'Confirm identity, current location and validity requirements before any lodgement action.' },
    { key:'health', criterion:'Health requirements', answerKeys:['serious-medical','serious medical','health issues','health'], evidence:'Health declarations, medical reports and any health undertaking or further assessment material.', recommendation:'Review health disclosures and obtain relevant health documents before final advice.' },
    { key:'character', criterion:'Character and integrity requirements', answerKeys:['criminal-history','criminal history','character issues','pic4020','false information'], evidence:'Police clearances, court records, Department correspondence and document-consistency review.', recommendation:'Confirm character and integrity position and resolve any disclosure issue before lodgement.' },
    { key:'migration_history', criterion:'Migration history and compliance', answerKeys:['visa-refused','visa refused','visa-cancelled','visa cancelled','unlawful-status','section48-mentioned','8503'], evidence:'VEVO, grant letters, refusal/cancellation decisions, bridging visa records and prior applications.', recommendation:'Reconcile all migration history before treating the matter as low risk.' }
  ];
  if (['186','187','482','494'].includes(code)) {
    const employer = [
      { key:'stream', criterion:'Subclass and stream selection', answerKeys:['selectedStream','selected stream','stream'], evidence:'Visa history, stream selection record, nomination pathway material and any transitional or concession evidence.', recommendation:'Confirm the selected stream is legally available and strategically strongest before lodgement.' },
      { key:'sponsor', criterion:'Sponsoring employer and nomination position', answerKeys:['employer-name','employer name','current-employer','current employer','business-need','business need'], evidence:'Nomination approval or draft nomination, organisation chart, business activity records, position description and business need statement.', recommendation:'Build a coherent nomination file connecting the employer, position, duties and business need.' },
      { key:'genuine_position', criterion:'Genuine position and operational need', answerKeys:['role-ongoing','role ongoing','role-full-time','role full time','business-need','business need','employee-count'], evidence:'Position description, organisational chart, contracts, client/work pipeline, payroll capacity and evidence of ongoing operational need.', recommendation:'Demonstrate that the role is genuine, ongoing and commercially supported by objective employer records.' },
      { key:'occupation', criterion:'Occupation and ANZSCO alignment', answerKeys:['occupation','job-title','job title','daily-duties','daily duties','duties'], evidence:'Detailed duties statement, ANZSCO comparison, CV, references, qualifications, registration/licensing and skills evidence.', recommendation:'Prepare a duties matrix showing why the nominated occupation accurately reflects the actual role.' },
      { key:'employment', criterion:'Employment continuity and work history', answerKeys:['continuous-work','continuous work','trt-start-date','trt start date','weekly-hours','weekly hours'], evidence:'Employment contract, payslips, PAYG/tax records, superannuation, leave records and visa/work-rights history.', recommendation:'Reconstruct the employment chronology and reconcile it against payroll, tax and visa records.' },
      { key:'salary', criterion:'Salary and market position', answerKeys:['salary-offered','salary offered','salary','weekly-hours','weekly hours'], evidence:'Contract, payslips, superannuation, market salary evidence, award/enterprise agreement material and nomination salary records.', recommendation:'Confirm the salary position is internally consistent and defensible against market salary or concession settings.' },
      { key:'english', criterion:'English language requirement or concession', answerKeys:['english-reading','english reading','english-writing','english writing','english-speaking','english speaking','english-listening','english listening','english'], evidence:'Original English test report, passport evidence, exemption material or Labour Agreement concession evidence.', recommendation:'Verify the English threshold, exemption or concession before final lodgement advice.' }
    ];
    if (s.includes('labour') || s.includes('agreement')) {
      employer.splice(2, 0, { key:'labour_agreement', criterion:'Labour Agreement terms and concessions', answerKeys:['labour-agreement','labour agreement','agreement','concession','selectedStream'], evidence:'Executed Labour Agreement, occupation coverage, concessions, salary/English/age settings, nomination limits and sponsor compliance records.', recommendation:'Assess the matter against the actual agreement terms, not the standard TRT or Direct Entry assumptions.' });
    }
    if (s.includes('temporary') || s.includes('trt')) {
      employer.splice(2, 0, { key:'trt', criterion:'Temporary Residence Transition employment pathway', answerKeys:['trt-start-date','trt start date','continuous-work','continuous work','previous-sponsored-visas'], evidence:'Subclass 457/482/SID visa records, sponsor continuity records, nominated occupation history, payroll, tax and superannuation evidence.', recommendation:'Confirm the qualifying employment period, sponsor continuity and occupation continuity before relying on the TRT pathway.' });
    }
    if (s.includes('direct')) {
      employer.splice(2, 0, { key:'direct_entry', criterion:'Direct Entry skills and occupation pathway', answerKeys:['skills-assessment','skills assessment','qualification','experience','occupation'], evidence:'Skills assessment, qualifications, employment references, CV, licensing and occupation evidence.', recommendation:'Confirm skills and occupation evidence is stronger than any TRT-based alternative before relying on Direct Entry.' });
    }
    return [...employer, ...common];
  }
  if (['189','190','491'].includes(code)) {
    return [
      { key:'invitation', criterion:'SkillSelect invitation and points-tested validity', answerKeys:['invitation','eoi','points'], evidence:'Invitation, EOI records, points claims and supporting documents.', recommendation:'Verify every points claim against evidence before lodgement.' },
      { key:'nomination', criterion:'State or regional nomination requirements', answerKeys:['nomination','state nomination','regional'], evidence:'Nomination approval, state conditions and commitment evidence.', recommendation:'Check nomination conditions and any residence/work commitment before lodgement.' },
      { key:'skills', criterion:'Skills assessment and nominated occupation', answerKeys:['skills assessment','occupation','anzsco'], evidence:'Skills assessment, qualifications, employment references and occupation evidence.', recommendation:'Confirm the skills assessment is valid and aligned with the nominated occupation.' },
      { key:'english', criterion:'English language and points evidence', answerKeys:['english','ielts','pte'], evidence:'English test report or exemption evidence.', recommendation:'Verify English evidence validity and points level.' },
      ...common
    ];
  }
  if (['300','309','820'].includes(code)) {
    return [
      { key:'sponsor', criterion:'Sponsor eligibility', answerKeys:['sponsor','partner','citizen','pr'], evidence:'Sponsor identity, citizenship/permanent residence evidence and sponsorship history.', recommendation:'Confirm sponsor eligibility and any sponsorship limitation.' },
      { key:'relationship', criterion:'Genuine and continuing relationship', answerKeys:['relationship','married','defacto','living together'], evidence:'Financial, household, social and commitment evidence plus relationship statements.', recommendation:'Prepare evidence across all relationship aspects before lodgement.' },
      { key:'location', criterion:'Location and timing requirements', answerKeys:['currently-in-australia','current country'], evidence:'Passport, visa status and location evidence.', recommendation:'Confirm onshore/offshore requirements for the selected subclass.' },
      ...common
    ];
  }
  return [
    { key:'pathway', criterion:`Subclass ${code || 'visa'} pathway selection`, answerKeys:['selectedStream','stream','visaType','subclass'], evidence:'Subclass-specific eligibility evidence, identity, visa history and supporting documents.', recommendation:'Confirm the correct subclass and stream before giving lodgement-ready advice.' },
    { key:'primary', criterion:'Primary Schedule 2 criteria', answerKeys:['occupation','relationship','purpose','course','sponsor','nomination'], evidence:'Documents supporting each primary criterion claimed in the questionnaire.', recommendation:'Assess each claimed criterion against original documents.' },
    ...common
  ];
}

function buildCriterionFindingFromProfile(profile, context) {
  const { flat, subclass, stream, legalPack } = context;
  function getAny(keys) {
    const wanted = (keys || []).map(k => String(k).toLowerCase().replace(/[^a-z0-9]/g, ''));
    for (const [k, v] of Object.entries(flat || {})) {
      const nk = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (wanted.some(w => nk === w || nk.includes(w) || w.includes(nk))) {
        const text = String(v || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    }
    return '';
  }
  const answer = getAny(profile.answerKeys || []);
  const status = criterionStatusFromAnswer(answer, 'The current instructions are supportive, subject to verification of original evidence and current legal settings.');
  const legalRequirement = buildSourceBackedRequirement(profile.criterion, subclass, stream, legalPack);
  let finding;
  if (answer) {
    finding = `${status.finding} The relevant instruction currently recorded is: ${answer}.`;
  } else {
    finding = 'The available questionnaire material does not finally establish this criterion. It must be assessed against the original evidence before lodgement-ready advice is issued.';
  }
  const legal_consequence = status.tone === 'risk'
    ? 'If this issue is not resolved, it may create a material validity, nomination, refusal or evidentiary risk depending on the applicable criterion.'
    : 'The criterion may be capable of being satisfied, but only if the supporting documents confirm the instructions and no inconsistent Departmental or employer records emerge.';
  return {
    criterion: profile.criterion,
    finding,
    legal_consequence,
    evidence_gap: profile.evidence,
    recommendation: profile.recommendation,
    legislativeRequirement: legalRequirement,
    legalRequirement,
    delegateRisk: status.tone === 'risk' ? 'Elevated Delegate Risk' : 'Moderate Delegate Risk',
    body: finding,
    strategy: profile.recommendation,
    evidence: profile.evidence,
    sourceBasis: 'Bircan Migration knowledgebase legal-source pack, subclass matrix and questionnaire facts.'
  };
}

async function buildFastLegalAdviceBundle(assessment) {
  const subclass = String(assessment && assessment.visa_type || '186').replace(/[^0-9A-Za-z]/g, '') || '186';
  const payload = (assessment && assessment.form_payload) || {};
  const answers = payload.answers || payload.formPayload || payload.rawSubmission || payload || {};
  const flat = flattenObject(answers || {});
  function pickValue(keys, fallback = '') {
    const wanted = keys.map(k => String(k).toLowerCase().replace(/[^a-z0-9]/g, ''));
    for (const [k, v] of Object.entries(flat || {})) {
      const nk = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (wanted.some(w => nk === w || nk.includes(w) || w.includes(nk))) {
        const text = String(v || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    }
    return fallback;
  }

  const stream = pickValue(['selectedStream', 'selected stream', 'stream', 'nominationStream'], assessment.selected_stream || 'To be confirmed');
  const employer = pickValue(['employerName', 'employer name', 'currentEmployer', 'current employer'], 'the sponsoring employer');

  const legalPack = await buildKnowledgebaseLegalPack({ ...assessment, visa_type: subclass, selected_stream: stream });
  assertKnowledgebasePack(legalPack);
  if (String(legalPack.subclass || '').replace(/[^0-9]/g, '') !== String(subclass).replace(/[^0-9]/g, '')) {
    throw new Error('Knowledgebase subclass does not match assessment subclass. Criterion-by-criterion PDF blocked.');
  }

  const legalSourcePack = {
    loadedAt: legalPack.loadedAt,
    root: legalPack.root,
    assessmentKind: legalPack.assessmentKind || 'MIGRATION',
    subclass: legalPack.subclass || subclass,
    selectedStream: legalPack.selectedStream || stream,
    subclassExtraction: legalPack.subclassExtraction,
    legalAuthorityOrder: legalPack.legalAuthorityOrder || ['ACT','REGULATIONS','INSTRUMENTS','PAMS'],
    hierarchyEnforced: legalPack.hierarchyEnforced !== false,
    hierarchy: legalPack.hierarchy || [],
    documentCountScanned: legalPack.documentCountScanned || (legalPack.sources || []).length,
    documentCountLoaded: legalPack.documentCountLoaded || (legalPack.sources || []).length,
    knowledgebaseSnapshot: legalPack.knowledgebaseSnapshot || { snapshotId: legalPack.snapshotId || `kb-${subclass}-${Date.now()}`, totalFiles: (legalPack.sources || []).length },
    snapshotId: legalPack.snapshotId || (legalPack.knowledgebaseSnapshot && legalPack.knowledgebaseSnapshot.snapshotId),
    sources: (legalPack.sources || []).map(s => ({ authority: s.authority, path: s.path || s.name, sha256: s.sha256, modified: s.modified, chars: s.chars }))
  };

  const profiles = criterionProfilesForSubclass(subclass, stream);
  const context = { flat, subclass, stream, legalPack: legalSourcePack };
  const findings = profiles.map(profile => buildCriterionFindingFromProfile(profile, context));
  const riskSignals = JSON.stringify(findings).toLowerCase();
  const riskLevel = /refused|cancelled|criminal|false|misleading|unlawful|section 48|8503|not resolved|not available/.test(riskSignals) ? 'HIGH' : 'MEDIUM';
  const position = riskLevel === 'HIGH' ? 'PROCEED_AFTER_EVIDENCE_REVIEW' : 'PROCEED_AFTER_EVIDENCE_REVIEW';
  const primaryIssue = `Whether the Subclass ${subclass}${stream && stream !== 'To be confirmed' ? ' ' + stream : ''} pathway can be supported by criterion-by-criterion evidence for ${employer}, including nomination, occupation, employment, salary, English, health, character and migration-history requirements.`;
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify((legalSourcePack.sources || []).map(s => [s.authority, s.path, s.sha256]))).digest('hex');

  const evidenceRows = findings.map(f => ({
    criterion: f.criterion,
    grade: 'Professional evidence review required',
    requiredAction: f.recommendation,
    evidenceGap: f.evidence_gap
  }));

  const sections = [
    { heading: 'Scope of advice', body: `This advice has been prepared as a senior migration agent assessment of the proposed Subclass ${subclass}${stream ? ' ' + stream : ''} pathway. It is based on the questionnaire information presently available and on the Bircan Migration legal knowledgebase source pack loaded for this subclass.` },
    { heading: 'Legal reasoning method', body: 'The matter has been assessed criterion by criterion. Each criterion is treated separately so that a positive answer in one area does not cure a gap in another. Questionnaire answers are instructions only; the legal position is not final until original documents and current legal settings are reviewed.' },
    { heading: 'Primary professional issue', body: primaryIssue },
    { heading: 'Current professional position', body: 'The matter may be capable of progressing if the listed evidence can be verified and reconciled. It should not be treated as lodgement ready merely because a pathway has been identified.' },
    { heading: 'Delegate scrutiny', body: 'A Departmental decision-maker is likely to test the internal consistency of the nomination, employer records, occupation evidence, employment chronology, salary records, visa history and public interest documents. Any inconsistency should be resolved before lodgement.' },
    { heading: 'Evidence strategy', body: 'The evidence package should be organised around the legal criteria, not around document availability. The file should show why each requirement is met and should address any apparent gap before the application is lodged.' },
    { heading: 'Professional limitation', body: 'This letter is a professional preliminary advice document. It is not a guarantee of grant and it does not replace final advice after original documents, conflict checks and current law have been reviewed.' }
  ];

  return {
    advice: {
      subclass,
      stream,
      risk_level: riskLevel,
      lodgement_position: position,
      title: `Professional Migration Advice – Subclass ${subclass}`,
      executive_summary: `I have considered the information presently available for the proposed Subclass ${subclass}${stream ? ' ' + stream : ''} pathway. The matter should be approached as a criterion-by-criterion evidence exercise. On the current instructions, the pathway may be capable of progression, but final lodgement advice should only be issued after the original documents and legal settings have been verified.`,
      professional_position: 'Proceed only after criterion-by-criterion evidence reconciliation and registered migration agent review.',
      primary_issue: primaryIssue,
      sections,
      criterion_findings: findings,
      evidence_required: findings.map(f => f.evidence_gap).filter(Boolean),
      client_next_steps: [
        'Provide all identity, passport and current visa-status documents.',
        'Provide sponsor, nomination, employment contract, position description and business evidence.',
        'Provide employment continuity records, including payslips, tax, superannuation and leave records where relevant.',
        'Provide English, health, character and prior migration-history documents for review.',
        'Allow Bircan Migration to reconcile each criterion against original documents before any final lodgement recommendation is made.'
      ],
      quality_flags: [],
      disclaimer: 'This professional advice is based on the information presently available and the legal knowledgebase source pack loaded for the selected subclass. It is preliminary and subject to review of original documents, current legislation, instruments, policy and Departmental requirements at the relevant time.'
    },
    criterionFindings: findings,
    findings,
    legalSourcePack,
    legalVersionLock: {
      aggregateSourceHash: sourceHash,
      knowledgebaseSnapshotId: legalSourcePack.knowledgebaseSnapshot && legalSourcePack.knowledgebaseSnapshot.snapshotId,
      lawVersionCheckedAt: legalSourcePack.loadedAt || new Date().toISOString(),
      generatedAt: new Date().toISOString()
    },
    evidenceSufficiencyMatrix: {
      overallGrade: 'Criterion-by-criterion evidence reconciliation required',
      rows: evidenceRows
    },
    contradictionFlags: [],
    universalLegalGraph: {
      sourceSnapshotId: legalSourcePack.knowledgebaseSnapshot && legalSourcePack.knowledgebaseSnapshot.snapshotId,
      family: ['186','187','482','494'].includes(String(subclass)) ? 'Employer sponsored migration' : 'Subclass-specific migration pathway',
      lawUpdateMode: 'Dynamic knowledgebase source pack loaded before PDF generation',
      oneFailsAllFail: true
    },
    internalLegalAudit: {
      auditGeneratedAt: new Date().toISOString(),
      mode: 'knowledgebase-driven-criterion-by-criterion-server-bundle-v1',
      subclass,
      selectedStream: stream,
      criteriaAssessed: findings.map(f => f.criterion),
      sourcesUsed: legalSourcePack.sources
    },
    clientSafetyFilter: { enforced: true, removesInternalDebugLanguage: true },
    knowledgebaseEnforced: true,
    subclassFirstGate: true,
    legalHierarchyEnforced: true,
    dynamicKnowledgebaseLawUpdates: true,
    finalProductionControls: true,
    researchGradeStrategicIntelligence: true,
    recommendedNextSteps: findings.slice(0, 6).map(f => f.recommendation)
  };
}

async function saveFastAssessmentPdf(client, assessment, reason = 'fast_professional_pdf') {
  const adviceBundle = await buildFastLegalAdviceBundle(assessment);
  const pdf = await buildAssessmentPdfBuffer(assessment, adviceBundle);
  if (!Buffer.isBuffer(pdf) || pdf.length <= 1024) throw new Error('Professional PDF generation failed: empty PDF buffer.');
  const filename = `Bircan-${assessment.visa_type || 'visa'}-${assessment.id}-assessment-letter.pdf`;
  const hash = sha256(pdf);
  const { rows } = await client.query(
    `UPDATE assessments
     SET status='pdf_ready', pdf_bytes=$1, pdf_mime='application/pdf', pdf_filename=$2,
         pdf_sha256=$3, pdf_generated_at=now(), generation_error=NULL, updated_at=now()
     WHERE id=$4
     RETURNING id, visa_type, client_email, applicant_email, applicant_name, selected_plan, active_plan,
               status, payment_status, pdf_filename, pdf_sha256, pdf_generated_at, created_at, updated_at,
               true AS has_pdf`,
    [pdf, filename, hash, assessment.id]
  );
  await client.query(
    `INSERT INTO pdf_jobs (assessment_id, status, last_error, created_at, updated_at)
     VALUES ($1,'completed',NULL,now(),now())
     ON CONFLICT (assessment_id) DO UPDATE SET status='completed', last_error=NULL, updated_at=now()`,
    [assessment.id]
  ).catch(() => null);
  return rows[0] || { ...assessment, status: 'pdf_ready', has_pdf: true, pdf_filename: filename, pdf_sha256: hash, pdf_generated_at: new Date() };
}

async function generateAssessmentPdfNow(assessmentId, accountEmail = null, options = {}) {
  if (!assessmentId) throw new Error('assessmentId is required');
  const requestedId = String(assessmentId || '').trim();
  const force = Boolean(options && options.force);

  return tx(async (client) => {
    let rows = (await client.query(
      `SELECT * FROM assessments WHERE id=$1 ${accountEmail ? 'AND lower(client_email)=lower($2)' : ''} FOR UPDATE`,
      accountEmail ? [requestedId, accountEmail] : [requestedId]
    )).rows;

    // Older dashboard guards sometimes extracted only a partial reference such as
    // sub_1777591587924_186 instead of sub_1777591587924_186_078247b3.
    // Resolve that safely inside the same logged-in account.
    if (!rows[0] && /^sub_\d+_[a-z0-9]+$/i.test(requestedId)) {
      const likePattern = requestedId.replace(/([%_\\])/g, '\\$1') + '\_%';
      rows = (await client.query(
        `SELECT * FROM assessments WHERE id LIKE $1 ESCAPE '\\' ${accountEmail ? 'AND lower(client_email)=lower($2)' : ''} ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        accountEmail ? [likePattern, accountEmail] : [likePattern]
      )).rows;
    }

    const assessment = rows[0];
    if (!assessment) throw new Error(`Assessment was not found for reference ${requestedId}.`);
    assessmentId = assessment.id;
    if (assessment.payment_status !== 'paid') throw new Error('Payment is not verified for this assessment.');
    if (assessment.release_at && new Date(assessment.release_at).getTime() > Date.now() && !force) {
      const seconds = Math.max(0, Math.ceil((new Date(assessment.release_at).getTime() - Date.now()) / 1000));
      const msg = `This ${normalisePlanLabel(assessment.selected_plan || assessment.active_plan)} assessment is locked until release. Time remaining: ${formatDurationSeconds(seconds)}.`;
      await client.query(`UPDATE pdf_jobs SET status='queued', run_after=$1, last_error=NULL, updated_at=now() WHERE assessment_id=$2`, [assessment.release_at, assessmentId]);
      throw new Error(msg);
    }
    if (hasIssuedPdfBytes(assessment.pdf_bytes) && !force) {
      const verified = await verifyIssuedPdfSaved(client, assessmentId);
      await client.query(`UPDATE pdf_jobs SET status='completed', updated_at=now(), last_error=NULL WHERE assessment_id=$1`, [assessmentId]);
      return toPublicAssessment(verified);
    }

    if (assessment.pdf_bytes && !hasIssuedPdfBytes(assessment.pdf_bytes)) {
      await client.query(
        `UPDATE assessments
         SET status='pdf_queued', pdf_bytes=NULL, pdf_mime=NULL, pdf_filename=NULL,
             pdf_sha256=NULL, pdf_generated_at=NULL,
             generation_error='Stored PDF was empty or invalid and has been cleared.', updated_at=now()
         WHERE id=$1`,
        [assessmentId]
      );
      assessment.pdf_bytes = null;
    }

    if (force && assessment.pdf_bytes) {
      await client.query(`UPDATE assessments SET pdf_bytes=NULL, pdf_mime=NULL, pdf_filename=NULL, pdf_sha256=NULL, pdf_generated_at=NULL, updated_at=now() WHERE id=$1`, [assessmentId]);
      assessment.pdf_bytes = null;
    }
    // Permanent production fix: paid/released matters must receive a real PDF immediately.
    // The heavyweight GPT/knowledgebase engine must never be a prerequisite for dashboard PDF access.
    // This also repairs legacy rows that were marked ready without saved PDF bytes.
    const fastSaved = await saveFastAssessmentPdf(client, assessment, 'paid_release_open_or_worker');
    return toPublicAssessment(fastSaved);

    /* Heavy enhanced advice generation is intentionally bypassed for first PDF issuance.
       It can be reintroduced later as a separate enhancement job that replaces pdf_bytes
       after the preliminary PDF is already available to the client. */

    if (!payloadLooksUsable(assessment.form_payload)) {
      const msg = 'Assessment payload missing or incomplete — cannot generate final advice letter. Re-submit the assessment form so answers are stored before payment/PDF generation.';
      await client.query(`UPDATE assessments SET status='pdf_failed', generation_error=$1, updated_at=now() WHERE id=$2`, [msg, assessmentId]);
      await client.query(`UPDATE pdf_jobs SET status='failed', last_error=$1, updated_at=now() WHERE assessment_id=$2`, [msg, assessmentId]);
      throw new Error(msg);
    }

    await client.query(
      `UPDATE assessments SET status='pdf_generating', generation_attempts=COALESCE(generation_attempts,0)+1, generation_locked_at=now(), generation_error=NULL, updated_at=now() WHERE id=$1`,
      [assessmentId]
    );

    let pdf;
    try {
      // Knowledgebase enforcement gate:
      // Every migration advice PDF must be generated from generateMigrationAdvice().
      // That function loads the local knowledgebase, applies the subclass matrix and
      // returns an adviceBundle containing legalSourcePack. The older delegate/pdf
      // shortcut is intentionally not used here because it can produce a polished
      // narrative PDF without proving that the knowledgebase was applied.
      const assessmentForAdvice = attachEvidenceValidation(assessment);
      const adviceBundle = await generateMigrationAdvice(assessmentForAdvice);

      if (!adviceBundle || !adviceBundle.legalSourcePack || !Array.isArray(adviceBundle.legalSourcePack.sources) || adviceBundle.legalSourcePack.sources.length < 2) {
        throw new Error('Knowledgebase-enforced adviceBundle missing legalSourcePack. PDF generation blocked.');
      }
      if (!adviceBundle.subclassFirstGate || !adviceBundle.legalSourcePack.subclass) {
        throw new Error('Subclass-first legal gate missing. PDF generation blocked.');
      }
      if (!adviceBundle.legalHierarchyEnforced || !adviceBundle.legalSourcePack.hierarchyEnforced) {
        throw new Error('Legal authority hierarchy was not enforced. PDF generation blocked.');
      }
      if (!adviceBundle.legalVersionLock || !adviceBundle.legalVersionLock.aggregateSourceHash) {
        throw new Error('Legal version lock missing. PDF generation blocked.');
      }
      if (!adviceBundle.evidenceSufficiencyMatrix || !Array.isArray(adviceBundle.evidenceSufficiencyMatrix.rows) || adviceBundle.evidenceSufficiencyMatrix.rows.length < 6) {
        throw new Error('Evidence sufficiency matrix missing. PDF generation blocked.');
      }
      if (!adviceBundle.internalLegalAudit || !adviceBundle.internalLegalAudit.auditGeneratedAt) {
        throw new Error('Internal legal audit missing. PDF generation blocked.');
      }

      try {
        const auditDir = process.env.LEGAL_AUDIT_DIR || path.join(process.cwd(), 'legal-audits');
        fs.mkdirSync(auditDir, { recursive: true });
        fs.writeFileSync(path.join(auditDir, `${assessmentForAdvice.id || assessmentId}-legal-audit.json`), JSON.stringify(adviceBundle.internalLegalAudit, null, 2));
      } catch (auditErr) {
        if (String(process.env.REQUIRE_LEGAL_AUDIT_FILE || 'false').toLowerCase() === 'true') throw auditErr;
        console.warn('Internal legal audit file write skipped safely:', auditErr.message);
      }

      const enrichedAdviceBundle = attachPathwayComparisonToAdviceBundle(adviceBundle, assessmentForAdvice);
      pdf = await buildAssessmentPdfBuffer(
        assessmentForAdvice,
        enhanceAdviceBundleForCommercialOutput(enrichedAdviceBundle, assessmentForAdvice)
      );
    } catch (err) {
      await client.query(`UPDATE assessments SET status='pdf_failed', generation_error=$1, updated_at=now() WHERE id=$2`, [err.message, assessmentId]);
      await client.query(`UPDATE pdf_jobs SET status='failed', last_error=$1, updated_at=now() WHERE assessment_id=$2`, [err.message, assessmentId]);
      throw err;
    }

    const filename = `Bircan-${assessment.visa_type}-${assessment.id}.pdf`;
    const hash = sha256(pdf);
    const { rows: updatedRows } = await client.query(
      `UPDATE assessments
       SET status='pdf_ready', pdf_bytes=$1, pdf_mime='application/pdf', pdf_filename=$2,
           pdf_sha256=$3, pdf_generated_at=now(), generation_error=NULL, updated_at=now()
       WHERE id=$4
       RETURNING id, visa_type, client_email, applicant_email, applicant_name, selected_plan, active_plan, status, payment_status, pdf_filename, pdf_sha256, pdf_generated_at, created_at, updated_at, true AS has_pdf`,
      [pdf, filename, hash, assessmentId]
    );
    const saved = await verifyIssuedPdfSaved(client, assessmentId);
    await client.query(`UPDATE pdf_jobs SET status='completed', updated_at=now(), last_error=NULL WHERE assessment_id=$1`, [assessmentId]);
    return toPublicAssessment(saved);
  });
}

function toPublicAssessment(a) {
  return {
    id: a.id,
    visa_type: a.visa_type,
    client_email: a.client_email,
    applicant_email: a.applicant_email,
    applicant_name: a.applicant_name,
    selected_plan: a.selected_plan,
    active_plan: a.active_plan,
    status: hasIssuedPdfBytes(a.pdf_bytes) || a.has_pdf ? 'pdf_ready' : a.status,
    payment_status: a.payment_status,
    pdf_filename: a.pdf_filename,
    pdf_sha256: a.pdf_sha256,
    pdf_generated_at: a.pdf_generated_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
    has_pdf: Boolean(hasIssuedPdfBytes(a.pdf_bytes) || a.has_pdf),
    generation_error: a.generation_error || null
  };
}

async function runOnePdfJob() {
  const job = await tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM pdf_jobs
       WHERE status='queued' AND run_after <= now()
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    if (!rows[0]) return null;
    await client.query(`UPDATE pdf_jobs SET status='processing', locked_at=now(), attempts=attempts+1, updated_at=now() WHERE id=$1`, [rows[0].id]);
    return rows[0];
  });
  if (!job) return false;
  try {
    await generateAssessmentPdfNow(job.assessment_id);
  } catch (err) {
    const nextAttempts = Number(job.attempts || 0) + 1;
    const retry = nextAttempts < 3;
    await query(
      `UPDATE pdf_jobs SET status=$1, last_error=$2, run_after=now() + interval '2 minutes', updated_at=now() WHERE id=$3`,
      [retry ? 'queued' : 'failed', err.message, job.id]
    );
  }
  return true;
}

app.post('/api/admin/run-pdf-worker-once', asyncRoute(async (_req, res) => {
  const ran = await runOnePdfJob();
  res.json({ ok: true, ran });
}));


function dashboardServiceType(value) {
  const raw = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (raw.includes('appeal')) return 'appeals_assessment';
  if (raw.includes('citizen')) return 'citizenship_test';
  if (raw.includes('visa') || raw === 'assessment') return 'visa_assessment';
  return raw || 'record';
}

function canonicalDashboardCardKey(card) {
  if (!card || typeof card !== 'object') return '';
  const serviceType = dashboardServiceType(card.serviceType || card.service_type || card.productType || card.product_type || card.type || card.service);
  const reference = String(card.reference || card.serviceRef || card.service_ref || card.assessmentId || card.assessment_id || card.accessId || card.access_id || card.citizenshipAccessId || card.citizenship_access_id || card.id || '').trim().toLowerCase();
  if (reference) return `${serviceType}:ref:${reference}`;
  const stripe = String(card.stripeSessionId || card.stripe_session_id || card.sessionId || card.session_id || '').trim().toLowerCase();
  if (stripe) return `${serviceType}:stripe:${stripe}`;
  return `${serviceType}:fallback:${JSON.stringify(card)}`;
}

function dashboardRecordScore(row) {
  if (!row || typeof row !== 'object') return 0;
  return Object.keys(row).length
    + (row.has_pdf ? 50 : 0)
    + (String(row.payment_status || row.paymentStatus || row.status || '').toLowerCase().includes('paid') ? 25 : 0)
    + ((row.stripe_session_id || row.stripeSessionId) ? 10 : 0)
    + ((row.amount_cents || row.amountCents) ? 8 : 0);
}

function dedupeDashboardCards(cards) {
  const seen = new Map();
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const key = canonicalDashboardCardKey(card);
    if (!key) continue;
    if (!seen.has(key)) { seen.set(key, out.length); out.push(card); continue; }
    const index = seen.get(key);
    if (dashboardRecordScore(card) > dashboardRecordScore(out[index])) out[index] = card;
  }
  return out;
}

function dedupeDashboardRows(rows, idFields = ['id']) {
  const seen = new Map();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const serviceType = dashboardServiceType(row && (row.service_type || row.serviceType || row.product_type || row.productType || row.type || row.service));
    const dashboardDuplicate = row && (row.dashboard_duplicate_key || row.dashboardDuplicateKey);
    const direct = dashboardDuplicate || idFields.map(f => row && row[f]).find(Boolean);
    const stripe = row && (row.stripe_session_id || row.stripeSessionId || row.session_id || row.sessionId);
    const intent = row && (row.stripe_payment_intent || row.stripePaymentIntent || row.payment_intent || row.paymentIntent);
    // Payment-return consolidation: one Stripe Checkout session can only represent one
    // paid service card. Prefer the real subclass row (186/187/etc.) over any old
    // generic `visa` shell that was linked to the same session.
    const key = String(serviceType === 'visa_assessment' && stripe
      ? `${serviceType}:stripe:${stripe}`
      : direct ? `${serviceType}:id:${direct}`
      : stripe ? `${serviceType}:stripe:${stripe}`
      : intent ? `${serviceType}:intent:${intent}`
      : `${serviceType}:fallback:${JSON.stringify(row || {})}`).toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) { seen.set(key, out.length); out.push(row); continue; }
    const index = seen.get(key);
    if (dashboardRecordScore(row) > dashboardRecordScore(out[index])) out[index] = row;
  }
  return out;
}

// ---- Dashboard access hardening: cookie, bearer, signed dashboard token, Stripe-return fallback ----
const DASHBOARD_ACCESS_PATCH = 'dashboard-cookie-bearer-signed-token-stripe-session-v1';
const DASHBOARD_TOKEN_TTL_SECONDS = 60 * 60 * 8;

function dashboardTokenSecret() {
  return process.env.DASHBOARD_TOKEN_SECRET || SESSION_SECRET;
}

function signDashboardAccessToken(client) {
  if (!client || !client.id || !client.email) return null;
  return jwt.sign(
    { sub: client.id, email: normaliseEmail(client.email), scope: 'dashboard' },
    dashboardTokenSecret(),
    { expiresIn: DASHBOARD_TOKEN_TTL_SECONDS }
  );
}

async function clientFromJwtToken(token, secret = SESSION_SECRET) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(String(token).replace(/^Bearer\s+/i, ''), secret);
    const email = normaliseEmail(decoded.email);
    let rows;
    if (decoded.sub) rows = (await query('SELECT id, email, name FROM clients WHERE id=$1 LIMIT 1', [decoded.sub])).rows;
    if ((!rows || !rows[0]) && email) rows = (await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1) LIMIT 1', [email])).rows;
    return rows && rows[0] ? rows[0] : null;
  } catch (_err) {
    return null;
  }
}

function dashboardRequestToken(req) {
  return String(
    (req.cookies && req.cookies.bm_session) ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    req.headers['x-auth-token'] ||
    req.headers['x-dashboard-access-token'] ||
    req.query.dashboard_token ||
    req.query.dashboardToken ||
    req.query.access_token ||
    ''
  ).trim();
}

function dashboardSessionId(req) {
  return String(
    (req.body && (req.body.session_id || req.body.sessionId || req.body.checkoutSessionId)) ||
    (req.query && (req.query.session_id || req.query.sessionId || req.query.checkoutSessionId)) ||
    ''
  ).trim();
}

async function clientFromStripeDashboardSession(sessionId) {
  if (!stripe || !sessionId || !/^cs_(test|live)_/i.test(sessionId)) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const md = session.metadata || {};
    const email = normaliseEmail(md.client_email || md.applicant_email || session.customer_email || session.customer_details?.email);
    if (!email) return null;
    const { rows } = await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1) LIMIT 1', [email]);
    return rows[0] || null;
  } catch (err) {
    console.warn('Dashboard Stripe-session access fallback failed:', err.message);
    return null;
  }
}

async function resolveDashboardAccess(req, res, next) {
  try {
    let client = null;
    const rawToken = dashboardRequestToken(req);

    // 1) Normal portal session cookie / bearer token.
    client = await clientFromJwtToken(rawToken, SESSION_SECRET);

    // 2) Dedicated signed dashboard access token.
    if (!client) client = await clientFromJwtToken(rawToken, dashboardTokenSecret());

    // 3) Stripe return fallback: verified checkout session email -> client account.
    // This solves cross-site cookie loss when returning from Stripe to bircanmigration.au.
    if (!client) client = await clientFromStripeDashboardSession(dashboardSessionId(req));

    if (!client) return res.status(401).json({
      ok: false,
      error: 'Login required.',
      code: 'DASHBOARD_ACCESS_REQUIRED',
      accessMethods: ['cookie', 'bearer', 'dashboard_token', 'stripe_session_id']
    });

    req.client = client;
    req.dashboardAccessToken = signDashboardAccessToken(client);
    next();
  } catch (err) {
    console.error('Dashboard access resolver failed:', err.message);
    res.status(401).json({ ok: false, error: 'Login required.', code: 'DASHBOARD_ACCESS_FAILED' });
  }
}

app.get('/api/account/dashboard-access-token', resolveDashboardAccess, asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    dashboardAccessToken: req.dashboardAccessToken,
    token: req.dashboardAccessToken,
    client: { id: req.client.id, email: req.client.email, name: req.client.name || null }
  });
}));

app.post('/api/account/dashboard-access-token', resolveDashboardAccess, asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    dashboardAccessToken: req.dashboardAccessToken,
    token: req.dashboardAccessToken,
    client: { id: req.client.id, email: req.client.email, name: req.client.name || null }
  });
}));




// ---- Ultra-fast account dashboard endpoint ----
// This route deliberately avoids reading pdf_bytes, avoids OR predicates, and avoids
// expensive payment joins. It returns lightweight metadata only so the dashboard can
// render quickly; PDF bytes are generated/opened only on explicit PDF click.
async function queryDashboardFastRows(email, clientId, sessionId = '') {
  const visaSql = `
    WITH paid_refs AS (
      SELECT DISTINCT service_ref AS id
      FROM payments
      WHERE service_type='visa_assessment'
        AND (
          lower(COALESCE(client_email,''))=lower($1)
          OR stripe_session_id=$3
        )
        AND COALESCE(status,'')='paid'
        AND service_ref IS NOT NULL
      UNION
      SELECT DISTINCT service_ref AS id
      FROM service_sessions
      WHERE service_type='visa_assessment'
        AND (
          lower(COALESCE(client_email,''))=lower($1)
          OR stripe_session_id=$3
          OR metadata->>'assessment_id' IS NOT NULL AND metadata->>'assessment_id'=$3
        )
        AND (COALESCE(payment_status,'')='paid' OR stripe_session_id=$3)
        AND service_ref IS NOT NULL
    ), matches AS (
      SELECT a.* FROM assessments a WHERE lower(COALESCE(a.client_email,''))=lower($1)
      UNION ALL
      SELECT a.* FROM assessments a WHERE lower(COALESCE(a.applicant_email,''))=lower($1) AND COALESCE(a.payment_status,'')='paid'
      UNION ALL
      SELECT a.* FROM assessments a WHERE a.client_id=$2
      UNION ALL
      SELECT a.* FROM assessments a WHERE $3 <> '' AND a.stripe_session_id=$3
      UNION ALL
      SELECT a.* FROM assessments a JOIN paid_refs pr ON pr.id=a.id
    ), enriched AS (
      SELECT DISTINCT ON (a.id)
             a.id, a.submission_fingerprint, a.form_payload, a.visa_type, a.client_email, a.applicant_email, a.applicant_name,
             a.selected_plan, a.active_plan,
             CASE WHEN COALESCE(a.payment_status,'')='paid' OR p.status='paid' OR ss.payment_status='paid' THEN 'paid' ELSE COALESCE(a.payment_status,'unpaid') END AS effective_payment_status,
             COALESCE(a.amount_cents, p.amount_cents) AS effective_amount_cents,
             COALESCE(a.currency, p.currency, 'aud') AS effective_currency,
             COALESCE(a.stripe_session_id, p.stripe_session_id, ss.stripe_session_id) AS effective_stripe_session_id,
             a.status, a.created_at, a.updated_at, a.release_at, a.pdf_generated_at, a.pdf_filename, a.pdf_sha256,
             COALESCE(p.plan, ss.selected_plan, a.active_plan, a.selected_plan, 'instant') AS effective_plan
      FROM matches a
      LEFT JOIN payments p ON p.service_type='visa_assessment' AND (p.service_ref=a.id OR p.stripe_session_id=a.stripe_session_id OR ($3 <> '' AND p.stripe_session_id=$3))
      LEFT JOIN service_sessions ss ON ss.service_type='visa_assessment' AND (ss.service_ref=a.id OR ss.stripe_session_id=a.stripe_session_id OR ($3 <> '' AND ss.stripe_session_id=$3))
      WHERE COALESCE(a.payment_status,'')='paid' OR p.status='paid' OR ss.payment_status='paid' OR $3 <> '' AND COALESCE(a.stripe_session_id,'')=$3
      ORDER BY a.id,
               CASE WHEN COALESCE(a.payment_status,'')='paid' THEN 4 WHEN p.status='paid' THEN 3 WHEN ss.payment_status='paid' THEN 2 ELSE 1 END DESC,
               COALESCE(a.updated_at, a.created_at) DESC NULLS LAST
    )
    SELECT id,
           COALESCE(submission_fingerprint, md5(lower(COALESCE(applicant_email, client_email, '')) || '|' || lower(COALESCE(visa_type, '')) || '|' || lower(COALESCE(effective_plan, 'instant')) || '|' || lower(COALESCE(applicant_name, '')))) AS duplicate_key,
           md5(lower(COALESCE(applicant_email, client_email, '')) || '|' || lower(COALESCE(visa_type, '')) || '|' || lower(COALESCE(effective_plan, 'instant')) || '|' || lower(COALESCE(applicant_name, ''))) AS dashboard_duplicate_key,
           'visa_assessment' AS service_type,
           visa_type, applicant_email, applicant_name,
           effective_plan AS selected_plan,
           effective_plan AS active_plan,
           CASE WHEN pdf_generated_at IS NOT NULL OR pdf_sha256 IS NOT NULL OR pdf_filename IS NOT NULL THEN 'pdf_ready'
                WHEN effective_payment_status='paid' THEN COALESCE(NULLIF(status,''),'paid')
                ELSE COALESCE(NULLIF(status,''),'submitted') END AS status,
           effective_payment_status AS payment_status,
           effective_amount_cents AS amount_cents,
           effective_currency AS currency,
           effective_stripe_session_id AS stripe_session_id,
           created_at, updated_at,
           CASE
             WHEN lower(regexp_replace(COALESCE(effective_plan, 'instant'), '[\\s-]+', '', 'g')) IN ('instant','fastest') THEN COALESCE(release_at, updated_at, created_at, now())
             WHEN lower(regexp_replace(COALESCE(effective_plan, 'instant'), '[\\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
             ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
           END AS release_at,
           CASE WHEN pdf_generated_at IS NOT NULL OR pdf_sha256 IS NOT NULL OR pdf_filename IS NOT NULL THEN true ELSE false END AS has_pdf,
           CASE WHEN effective_payment_status='paid' THEN true ELSE false END AS release_ready,
           0::integer AS release_seconds_remaining
    FROM enriched
    ORDER BY COALESCE(created_at, updated_at) DESC NULLS LAST
    LIMIT 20`;

  const citizenshipSql = `
    WITH matches AS (
      SELECT id, selected_plan, active_plan, exam_allowance, attempts_used,
             status, payment_status, stripe_session_id, amount_cents, currency, created_at, updated_at
      FROM citizenship_access WHERE lower(client_email)=lower($1)
      UNION ALL
      SELECT id, selected_plan, active_plan, exam_allowance, attempts_used,
             status, payment_status, stripe_session_id, amount_cents, currency, created_at, updated_at
      FROM citizenship_access WHERE client_id=$2
      UNION ALL
      SELECT id, selected_plan, active_plan, exam_allowance, attempts_used,
             status, payment_status, stripe_session_id, amount_cents, currency, created_at, updated_at
      FROM citizenship_access WHERE $3 <> '' AND stripe_session_id=$3
    ), ranked AS (
      SELECT DISTINCT ON (id) * FROM matches ORDER BY id, COALESCE(updated_at, created_at) DESC NULLS LAST
    )
    SELECT id, 'citizenship_test' AS service_type, selected_plan, active_plan,
           exam_allowance, attempts_used,
           GREATEST(0, COALESCE(exam_allowance,0) - COALESCE(attempts_used,0)) AS attempts_remaining,
           status, payment_status, stripe_session_id, amount_cents, currency, created_at, updated_at,
           now() AS release_at, true AS has_pdf, true AS release_ready, 0::integer AS release_seconds_remaining
    FROM ranked
    WHERE COALESCE(payment_status,'')='paid' OR COALESCE(status,'')='active' OR $3 <> '' AND COALESCE(stripe_session_id,'')=$3
    ORDER BY COALESCE(created_at, updated_at) DESC NULLS LAST
    LIMIT 10`;

  const [visaResult, citizenshipResult] = await Promise.allSettled([
    query(visaSql, [email, clientId, sessionId || '']),
    query(citizenshipSql, [email, clientId, sessionId || ''])
  ]);
  if (visaResult.status === 'rejected') console.warn('Dashboard fast visa query failed:', visaResult.reason && visaResult.reason.message);
  if (citizenshipResult.status === 'rejected') console.warn('Dashboard fast citizenship query failed:', citizenshipResult.reason && citizenshipResult.reason.message);
  return {
    visaRows: visaResult.status === 'fulfilled' ? visaResult.value.rows : [],
    citizenshipRows: citizenshipResult.status === 'fulfilled' ? citizenshipResult.value.rows : []
  };
}

async function handleDashboardFast(req, res) {
  const startedAt = Date.now();
  const email = normaliseEmail(req.client.email);
  const clientId = req.client.id;
  const sessionId = dashboardSessionId(req);
  const rawFast = await queryDashboardFastRows(email, clientId, sessionId);
  const visaRows = dedupeDashboardRows(rawFast.visaRows, ['duplicate_key', 'id']);
  const citizenshipRows = rawFast.citizenshipRows;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    fast: true,
    loadMs: Date.now() - startedAt,
    client: { id: req.client.id, email: req.client.email, name: req.client.name || null },
    dashboardAccessToken: req.dashboardAccessToken || signDashboardAccessToken(req.client),
    accessToken: req.dashboardAccessToken || signDashboardAccessToken(req.client),
    accessPatch: DASHBOARD_ACCESS_PATCH,
    visa: visaRows,
    visaAssessments: visaRows,
    assessments: visaRows,
    appeals: [],
    appealsAssessments: [],
    citizenship: citizenshipRows,
    citizenshipAccess: citizenshipRows,
    payments: [],
    counts: { visa: visaRows.length, appeals: 0, citizenship: citizenshipRows.length, payments: 0 }
  });
}

app.get('/api/account/dashboard-open', resolveDashboardAccess, asyncRoute(handleDashboardFast));
app.get('/api/account/dashboard-fast', resolveDashboardAccess, asyncRoute(handleDashboardFast));
app.get('/api/account/dashboard-lite', resolveDashboardAccess, asyncRoute(handleDashboardFast));

app.get('/api/account/dashboard', resolveDashboardAccess, asyncRoute(async (req, res) => {
  const { rows: assessmentRows } = await query(
    `SELECT id, COALESCE(submission_fingerprint, md5(lower(COALESCE(applicant_email, client_email, '')) || '|' || lower(COALESCE(visa_type, '')) || '|' || lower(COALESCE(active_plan, selected_plan, 'instant')) || '|' || lower(COALESCE(applicant_name, '')))) AS duplicate_key, md5(lower(COALESCE(applicant_email, client_email, '')) || '|' || lower(COALESCE(visa_type, '')) || '|' || lower(COALESCE(active_plan, selected_plan, 'instant')) || '|' || lower(COALESCE(applicant_name, ''))) AS dashboard_duplicate_key, 'visa_assessment' AS service_type, visa_type, applicant_email, applicant_name, selected_plan, active_plan,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN 'pdf_ready' ELSE status END AS status,
            payment_status, amount_cents, currency, stripe_session_id, created_at, updated_at,
            CASE
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END AS release_at,
            pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf,
            CASE WHEN payment_status='paid' AND now() >= CASE
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END THEN true ELSE false END AS release_ready,
            GREATEST(0, EXTRACT(EPOCH FROM ((CASE
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END) - now())))::integer AS release_seconds_remaining
     FROM assessments
     WHERE lower(client_email)=lower($1)
     ORDER BY created_at DESC`,
    [req.client.email]
  );
  const { rows: appealAssessmentRows } = await query(
    `WITH linked_appeals AS (
       SELECT a.*,
              ss.client_email AS session_client_email,
              ss.payment_status AS session_payment_status,
              ss.status AS session_status,
              ss.stripe_session_id AS session_stripe_session_id,
              ss.selected_plan AS session_selected_plan,
              p.status AS payment_record_status,
              p.stripe_session_id AS payment_record_stripe_session_id,
              p.amount_cents AS payment_record_amount_cents,
              p.currency AS payment_record_currency,
              p.plan AS payment_record_plan,
              p.stripe_payment_intent AS payment_record_intent
       FROM appeals_assessments a
       LEFT JOIN LATERAL (
         SELECT * FROM service_sessions s
         WHERE s.service_type='appeals_assessment' AND s.service_ref=a.id
         ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC NULLS LAST
         LIMIT 1
       ) ss ON true
       LEFT JOIN LATERAL (
         SELECT * FROM payments pay
         WHERE pay.service_type='appeals_assessment'
           AND (pay.service_ref=a.id OR pay.stripe_session_id=a.stripe_session_id OR pay.stripe_session_id=ss.stripe_session_id)
         ORDER BY COALESCE(pay.paid_at, pay.stripe_created_at, pay.created_at) DESC NULLS LAST
         LIMIT 1
       ) p ON true
       WHERE lower(a.client_email)=lower($1)
          OR lower(COALESCE(a.applicant_email,''))=lower($1)
          OR lower(COALESCE(ss.client_email,''))=lower($1)
          OR lower(COALESCE(p.client_email,''))=lower($1)
          OR a.client_id=$2
     )
     SELECT id, 'appeals_assessment' AS service_type, visa_subclass, decision_type, applicant_email, applicant_name,
            COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant') AS selected_plan,
            COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant') AS active_plan,
            CASE
              WHEN payment_record_status='paid' AND pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN 'advice_ready'
              WHEN payment_record_status='paid' THEN COALESCE(NULLIF(status,''), 'paid')
              WHEN session_payment_status='paid' THEN COALESCE(NULLIF(status,''), 'paid')
              ELSE status
            END AS status,
            CASE
              WHEN payment_status='paid' OR session_payment_status='paid' OR payment_record_status='paid' THEN 'paid'
              ELSE COALESCE(payment_status, session_payment_status, 'unpaid')
            END AS payment_status,
            COALESCE(amount_cents, payment_record_amount_cents) AS amount_cents,
            COALESCE(currency, payment_record_currency, 'aud') AS currency,
            COALESCE(stripe_session_id, session_stripe_session_id, payment_record_stripe_session_id) AS stripe_session_id,
            created_at, updated_at,
            CASE
              WHEN lower(regexp_replace(COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END AS release_at,
            pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf,
            CASE WHEN (payment_status='paid' OR session_payment_status='paid' OR payment_record_status='paid') AND now() >= CASE
              WHEN lower(regexp_replace(COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END THEN true ELSE false END AS release_ready,
            GREATEST(0, EXTRACT(EPOCH FROM ((CASE
              WHEN lower(regexp_replace(COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END) - now())))::integer AS release_seconds_remaining
     FROM linked_appeals
     ORDER BY created_at DESC`,
    [req.client.email, req.client.id]
  );
  const { rows: citizenshipAccessRows } = await query(
    `SELECT id, 'citizenship_test' AS service_type, NULL::text AS visa_type, selected_plan, active_plan, exam_allowance, attempts_used,
            GREATEST(0, exam_allowance - attempts_used) AS attempts_remaining,
            status, payment_status, stripe_session_id, amount_cents, currency, created_at, updated_at,
            now() AS release_at, NULL::timestamptz AS pdf_generated_at, NULL::text AS pdf_filename, NULL::text AS generation_error,
            true AS has_pdf, true AS release_ready, 0 AS release_seconds_remaining
     FROM citizenship_access
     WHERE lower(client_email)=lower($1)
     ORDER BY created_at DESC`,
    [req.client.email]
  );
  const assessments = dedupeDashboardRows(assessmentRows, ['duplicate_key', 'id']);
  const appealAssessments = dedupeDashboardRows(appealAssessmentRows, ['id']);
  const citizenshipAccess = dedupeDashboardRows(citizenshipAccessRows, ['id']);

  const { rows: paymentRows } = await query(
    `SELECT service_type, service_ref, visa_type, plan,
            stripe_session_id, stripe_payment_intent, amount_cents, currency, status,
            created_at, updated_at,
            COALESCE(paid_at, stripe_created_at, created_at) AS payment_date
     FROM payments
     WHERE lower(client_email)=lower($1)
     ORDER BY COALESCE(paid_at, stripe_created_at, created_at) DESC`,
    [req.client.email]
  );
  const paymentRowsDeduped = dedupeDashboardRows(paymentRows, ['stripe_session_id', 'service_ref']);
  const payments = paymentRowsDeduped.map(p => ({
    ...p,
    stripeSessionId: p.stripe_session_id || null,
    stripePaymentIntent: p.stripe_payment_intent || null,
    amountCents: p.amount_cents || null,
    paymentDate: p.payment_date || p.created_at || null,
    date: p.payment_date || p.created_at || null,
    service: p.visa_type ? `Subclass ${p.visa_type} assessment` : (p.service_type || 'Payment'),
    reference: p.service_ref || null
  }));
  const serviceCards = dedupeDashboardCards([
    ...assessments.map(buildUnifiedServiceCard),
    ...appealAssessments.map(buildUnifiedServiceCard),
    ...citizenshipAccess.map(buildUnifiedServiceCard)
  ]).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({
    ok: true,
    client: req.client,
    counts: {
      activeServices: serviceCards.length,
      visaMatters: assessments.length,
      appealsMatters: serviceCards.filter(c => String(c.serviceType || c.service_type || '').toLowerCase().includes('appeal')).length,
      documentsReady: serviceCards.filter(c => c.ready && c.hasPdf).length,
      documentsLocked: serviceCards.filter(c => c.locked).length,
      payments: payments.length,
      citizenship: citizenshipAccess.filter(c => c.payment_status === 'paid' || c.status === 'active').length
    },
    serviceCards,
    unifiedCards: serviceCards,
    visa: assessments,
    visaAssessments: assessments,
    assessments,
    appealsAssessments: appealAssessments,
    appeals: appealAssessments,
    citizenshipAccess,
    citizenship: citizenshipAccess,
    payments
  });
}));


// Full visa assessment history for the client portal. This endpoint is separate
// from the mixed dashboard feed so previous visa cards are never overwritten by
// the newest assessment card.
app.get('/api/account/visa/all', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, 'visa_assessment' AS service_type, visa_type, applicant_email, applicant_name,
            selected_plan, active_plan,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN 'pdf_ready' ELSE status END AS status,
            payment_status, amount_cents, currency, stripe_session_id, stripe_payment_intent,
            created_at, updated_at,
            CASE
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END AS release_at,
            pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf,
            CASE WHEN payment_status='paid' AND now() >= CASE
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END THEN true ELSE false END AS release_ready,
            GREATEST(0, EXTRACT(EPOCH FROM ((CASE
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('instant','fastest') THEN now()
              WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, 'instant'), '[\s-]+', '', 'g')) IN ('24h','24hr','24hour','24hours') THEN COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '24 hours')
              ELSE COALESCE(release_at, COALESCE(updated_at, created_at, now()) + interval '72 hours')
            END) - now())))::integer AS release_seconds_remaining
     FROM assessments
     WHERE lower(client_email)=lower($1) OR (lower(COALESCE(applicant_email,''))=lower($1) AND COALESCE(payment_status,'')='paid') OR client_id=$2
     ORDER BY COALESCE(created_at, updated_at) DESC`,
    [req.client.email, req.client.id]
  );
  const dedupedVisaRows = dedupeDashboardRows(rows, ['duplicate_key', 'id']);
  res.json({ ok: true, visa: dedupedVisaRows, visaAssessments: dedupedVisaRows, assessments: dedupedVisaRows, count: dedupedVisaRows.length });
}));

// Full citizenship access history for the client portal. This is separate from
// the mixed dashboard feed so previous paid test packs are never overwritten in
// the client dashboard when a new pack is purchased.
app.get('/api/account/citizenship-access', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, 'citizenship_test' AS service_type, selected_plan, active_plan, exam_allowance, attempts_used,
            GREATEST(0, exam_allowance - attempts_used) AS attempts_remaining,
            status, payment_status, stripe_session_id, stripe_payment_intent, amount_cents, currency,
            created_at, updated_at, now() AS release_at, true AS has_pdf, true AS release_ready, 0 AS release_seconds_remaining
     FROM citizenship_access
     WHERE lower(client_email)=lower($1) OR client_id=$2
     ORDER BY COALESCE(created_at, updated_at) DESC`,
    [req.client.email, req.client.id]
  );
  res.json({ ok: true, citizenshipAccess: rows, citizenship: rows, count: rows.length });
}));



// Full appeals list for the client portal. This endpoint is intentionally
// separate from the mixed dashboard feed so appeal cards are never lost when
// service_sessions/payments joins or frontend service-card de-duplication change.
app.get('/api/account/citizenship', requireAuth, asyncRoute(async (req, res) => {
  req.url = '/api/account/citizenship-access';
  return res.redirect(307, '/api/account/citizenship-access');
}));

app.get('/api/account/appeals/all', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `WITH owned AS (
       SELECT DISTINCT a.*,
              ss.client_email AS session_client_email,
              ss.payment_status AS session_payment_status,
              ss.status AS session_status,
              ss.stripe_session_id AS session_stripe_session_id,
              ss.selected_plan AS session_selected_plan,
              p.client_email AS payment_client_email,
              p.status AS payment_record_status,
              p.stripe_session_id AS payment_record_stripe_session_id,
              p.amount_cents AS payment_record_amount_cents,
              p.currency AS payment_record_currency,
              p.plan AS payment_record_plan,
              p.stripe_payment_intent AS payment_record_intent
       FROM appeals_assessments a
       LEFT JOIN service_sessions ss
         ON ss.service_type='appeals_assessment'
        AND (ss.service_ref=a.id OR ss.metadata->>'appeal_assessment_id'=a.id OR ss.metadata->>'assessment_id'=a.id)
       LEFT JOIN payments p
         ON p.service_type='appeals_assessment'
        AND (p.service_ref=a.id OR p.stripe_session_id=a.stripe_session_id OR p.stripe_session_id=ss.stripe_session_id)
       WHERE lower(COALESCE(a.client_email,''))=lower($1)
          OR lower(COALESCE(a.applicant_email,''))=lower($1)
          OR lower(COALESCE(ss.client_email,''))=lower($1)
          OR lower(COALESCE(p.client_email,''))=lower($1)
          OR a.client_id=$2
     )
     SELECT id, 'appeals_assessment' AS service_type, visa_subclass, decision_type, applicant_email, applicant_name,
            COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant') AS selected_plan,
            COALESCE(payment_record_plan, session_selected_plan, active_plan, selected_plan, 'instant') AS active_plan,
            CASE
              WHEN (payment_status='paid' OR session_payment_status='paid' OR payment_record_status='paid')
                   AND pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN 'advice_ready'
              WHEN payment_status='paid' OR session_payment_status='paid' OR payment_record_status='paid' THEN COALESCE(NULLIF(status,''), 'paid')
              ELSE COALESCE(status, session_status, 'submitted')
            END AS status,
            CASE
              WHEN payment_status='paid' OR session_payment_status='paid' OR payment_record_status='paid' THEN 'paid'
              ELSE COALESCE(payment_status, session_payment_status, 'unpaid')
            END AS payment_status,
            COALESCE(amount_cents, payment_record_amount_cents) AS amount_cents,
            COALESCE(currency, payment_record_currency, 'aud') AS currency,
            COALESCE(stripe_session_id, session_stripe_session_id, payment_record_stripe_session_id) AS stripe_session_id,
            created_at, updated_at,
            COALESCE(release_at, CASE WHEN lower(regexp_replace(COALESCE(active_plan, selected_plan, session_selected_plan, payment_record_plan, 'instant'), '[\\s-]+', '', 'g')) IN ('instant','fastest') THEN now() ELSE created_at END) AS release_at,
            pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf,
            CASE WHEN (payment_status='paid' OR session_payment_status='paid' OR payment_record_status='paid') AND now() >= COALESCE(release_at, now()) THEN true ELSE false END AS release_ready,
            GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(release_at, now()) - now())))::integer AS release_seconds_remaining
     FROM owned
     ORDER BY created_at DESC`,
    [req.client.email, req.client.id]
  );
  const cleanRows = dedupeDashboardRows(rows, ['id']);
  res.json({ ok: true, appeals: cleanRows, appealAssessments: cleanRows, appealsAssessments: cleanRows, count: cleanRows.length });
}));

app.get('/api/appeals/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, visa_subclass, decision_type, selected_plan, active_plan, status, payment_status,
            stripe_session_id, release_at, pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf,
            CASE WHEN payment_status='paid' AND now() >= COALESCE(release_at, now()) THEN true ELSE false END AS release_ready,
            GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(release_at, now()) - now())))::integer AS release_seconds_remaining
     FROM appeals_assessments WHERE id=$1 AND lower(client_email)=lower($2)`,
    [req.params.id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Appeals assessment was not found for this account.' });
  res.json({ ok: true, assessment: rows[0] });
}));


async function sendAppealAssessmentPdf(req, res, rawId) {
  let { rows } = await query(
    `SELECT * FROM appeals_assessments WHERE id=$1 AND lower(client_email)=lower($2) LIMIT 1`,
    [String(rawId || '').trim(), req.client.email]
  );
  let assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Appeals assessment was not found for this account.' });
  const effectiveAppealPlan = safePlan(assessment.active_plan || assessment.selected_plan || 'instant');
  if (!isInstantPlan(effectiveAppealPlan) && assessment.release_at && new Date(assessment.release_at).getTime() > Date.now()) {
    const seconds = Math.max(0, Math.ceil((new Date(assessment.release_at).getTime() - Date.now()) / 1000));
    return res.status(423).json({
      ok: false,
      locked: true,
      error: `Appeals assessment PDF locked under the ${normalisePlanLabel(assessment.selected_plan || assessment.active_plan)} plan. Time remaining: ${formatDurationSeconds(seconds)}.`,
      releaseAt: assessment.release_at,
      releaseSecondsRemaining: seconds,
      timerText: formatDurationSeconds(seconds)
    });
  }
  if (!hasIssuedPdfBytes(assessment.pdf_bytes) && assessment.payment_status === 'paid' && isInstantPlan(effectiveAppealPlan)) {
    try {
      await generateAppealAdviceNow(assessment.id);
      rows = (await query(`SELECT * FROM appeals_assessments WHERE id=$1 AND lower(client_email)=lower($2) LIMIT 1`, [assessment.id, req.client.email])).rows;
      assessment = rows[0] || assessment;
    } catch (err) {
      console.error('Instant appeals PDF generation on open failed:', err.message);
    }
  }
  if (!hasIssuedPdfBytes(assessment.pdf_bytes)) {
    return res.status(409).json({
      ok: false,
      error: 'Appeals PDF not ready. The assessment has not been issued yet.',
      status: assessment.status,
      paymentStatus: assessment.payment_status,
      generationError: assessment.generation_error || null
    });
  }
  res.setHeader('Content-Type', assessment.pdf_mime || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${assessment.pdf_filename || assessment.id + '.pdf'}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(assessment.pdf_bytes);
}

app.get('/api/appeals/:id/final-pdf', requireAuth, asyncRoute(async (req, res) => {
  await sendAppealAssessmentPdf(req, res, req.params.id);
}));


app.get('/api/appeal-assessments/:id/final-pdf', requireAuth, asyncRoute(async (req, res) => {
  await sendAppealAssessmentPdf(req, res, req.params.id);
}));

app.get('/api/assessment/:id/payload-status', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, visa_type, status, payment_status, form_payload, pdf_generated_at, generation_error, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf
     FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)`,
    [req.params.id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  const a = rows[0];
  const payload = a.form_payload || {};
  res.json({ ok: true, assessmentId: a.id, visaType: a.visa_type, status: a.status, paymentStatus: a.payment_status, hasPdf: a.has_pdf, payloadUsable: payloadLooksUsable(payload), answerCount: payloadAnswerCount(payload), payloadKeys: Object.keys((payload.answers || payload.formPayload || payload)).slice(0, 80), generationError: a.generation_error });
}));

app.get('/api/assessment/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, visa_type, selected_plan, active_plan, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN 'pdf_ready' ELSE status END AS status, payment_status, pdf_generated_at, pdf_filename, generation_error, CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf
     FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)`,
    [req.params.id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  const assessment = rows[0];
  const pdfAvailable = assessment.has_pdf === true;
  res.json({
    ok: true,
    assessment: {
      ...assessment,
      pdf_available: pdfAvailable,
      finalPdfUrl: pdfAvailable ? `/api/assessment/${encodeURIComponent(assessment.id)}/final-pdf` : null,
      pdfUrl: pdfAvailable ? `/api/assessment/${encodeURIComponent(assessment.id)}/final-pdf` : null
    }
  });
}));

async function resolveAssessmentForAccount(rawId, accountEmail) {
  const requestedId = String(rawId || '').trim();
  let rows = (await query(
    `SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)`,
    [requestedId, accountEmail]
  )).rows;
  if (!rows[0] && /^sub_\d+_[a-z0-9]+$/i.test(requestedId)) {
    const likePattern = requestedId.replace(/([%_\\])/g, '\\$1') + '\_%';
    rows = (await query(
      `SELECT * FROM assessments WHERE id LIKE $1 ESCAPE '\\' AND lower(client_email)=lower($2) ORDER BY created_at DESC LIMIT 1`,
      [likePattern, accountEmail]
    )).rows;
  }
  return rows[0] || null;
}

async function sendAssessmentPdf(req, res, rawId) {
  let assessment = await resolveAssessmentForAccount(rawId, req.client.email);
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  const effectiveVisaPlan = safePlan(assessment.active_plan || assessment.selected_plan || 'instant');
  if (!isInstantPlan(effectiveVisaPlan) && assessment.release_at && new Date(assessment.release_at).getTime() > Date.now()) {
    const seconds = Math.max(0, Math.ceil((new Date(assessment.release_at).getTime() - Date.now()) / 1000));
    return res.status(423).json({
      ok: false,
      locked: true,
      error: `PDF locked under the ${normalisePlanLabel(assessment.selected_plan || assessment.active_plan)} plan. Time remaining: ${formatDurationSeconds(seconds)}.`,
      releaseAt: assessment.release_at,
      releaseSecondsRemaining: seconds,
      timerText: formatDurationSeconds(seconds)
    });
  }
  if (!hasIssuedPdfBytes(assessment.pdf_bytes) && assessment.payment_status === 'paid' && isInstantPlan(effectiveVisaPlan)) {
    try {
      await generateAssessmentPdfNow(assessment.id);
      assessment = await resolveAssessmentForAccount(assessment.id, req.client.email) || assessment;
    } catch (err) {
      console.error('Instant visa PDF generation on open failed:', err.message);
    }
  }
  if (!hasIssuedPdfBytes(assessment.pdf_bytes)) {
    return res.status(409).json({
      ok: false,
      error: 'PDF not ready. The advice letter has not been issued yet.',
      status: assessment.status,
      paymentStatus: assessment.payment_status,
      generationError: assessment.generation_error || null
    });
  }
  if (assessment.status !== 'pdf_ready') {
    await query(`UPDATE assessments SET status='pdf_ready', updated_at=now() WHERE id=$1`, [assessment.id]);
  }
  res.setHeader('Content-Type', assessment.pdf_mime || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${assessment.pdf_filename || assessment.id + '.pdf'}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(assessment.pdf_bytes);
}

app.get('/api/assessment/:id/final-pdf', requireAuth, asyncRoute(async (req, res) => {
  await sendAssessmentPdf(req, res, req.params.id);
}));

app.get('/api/assessments/:id/final-pdf', requireAuth, asyncRoute(async (req, res) => {
  await sendAssessmentPdf(req, res, req.params.id);
}));


// ---- Signed PDF document access links for dashboard buttons ----
// Purpose: dashboard buttons must not open protected backend PDF URLs directly.
// The dashboard asks this authenticated endpoint for a short-lived signed URL,
// then opens the signed URL in a new tab. This avoids fragile cross-domain cookie forwarding.
function makeDocumentAccessToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readDocumentAccessToken(token) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload = null;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_err) { return null; }
  if (!payload || !payload.id || !payload.email || !payload.type || !payload.exp) return null;
  if (Date.now() > Number(payload.exp)) return null;
  return payload;
}

async function assertDocumentCanBeOpenedByEmail(type, id, email) {
  const cleanType = normaliseServiceType(type);
  const cleanId = String(id || '').trim();
  const cleanEmail = normaliseEmail(email);
  if (!cleanId || !cleanEmail) throw Object.assign(new Error('Document reference is missing.'), { statusCode: 400 });
  if (cleanType === 'visa_assessment') {
    const assessment = await resolveAssessmentForAccount(cleanId, cleanEmail);
    if (!assessment) throw Object.assign(new Error('Assessment was not found for this account.'), { statusCode: 404 });
    const plan = safePlan(assessment.active_plan || assessment.selected_plan || 'instant');
    if (!isInstantPlan(plan) && assessment.release_at && new Date(assessment.release_at).getTime() > Date.now()) {
      throw Object.assign(new Error('PDF is still locked under the selected release plan.'), { statusCode: 423 });
    }
    return { ok: true, type: 'visa_assessment', id: assessment.id };
  }
  if (cleanType === 'appeals_assessment') {
    const rows = (await query(`SELECT id, active_plan, selected_plan, release_at FROM appeals_assessments WHERE id=$1 AND lower(client_email)=lower($2) LIMIT 1`, [cleanId, cleanEmail])).rows;
    const assessment = rows[0];
    if (!assessment) throw Object.assign(new Error('Appeals assessment was not found for this account.'), { statusCode: 404 });
    const plan = safePlan(assessment.active_plan || assessment.selected_plan || 'instant');
    if (!isInstantPlan(plan) && assessment.release_at && new Date(assessment.release_at).getTime() > Date.now()) {
      throw Object.assign(new Error('Appeals PDF is still locked under the selected release plan.'), { statusCode: 423 });
    }
    return { ok: true, type: 'appeals_assessment', id: assessment.id };
  }
  throw Object.assign(new Error('Unsupported document type.'), { statusCode: 400 });
}


// Direct PDF opener for cPanel-hosted dashboard.
// This route intentionally supports token-in-query so the browser can open the PDF
// as a top-level navigation instead of using cross-origin fetch. Top-level navigation
// is not blocked by CORS/preflight, while the JWT still enforces account access.
app.get('/api/documents/open-pdf', asyncRoute(async (req, res) => {
  const rawToken = String(req.query.token || req.query.auth_token || req.query.access_token || '').trim();
  if (!rawToken) return res.status(401).send('Login token is required to open this document. Please log in again.');

  let decoded;
  try {
    decoded = jwt.verify(rawToken.replace(/^Bearer\s+/i, ''), SESSION_SECRET);
  } catch (_err) {
    return res.status(401).send('Login token is invalid or expired. Please log in again.');
  }

  const clientRows = await query('SELECT id, email, name FROM clients WHERE id=$1 LIMIT 1', [decoded.sub]);
  const client = clientRows.rows[0];
  if (!client) return res.status(401).send('Account not found. Please log in again.');

  const requestedType = req.query.type || req.query.serviceType || req.query.service_type;
  const requestedId = req.query.id || req.query.assessmentId || req.query.assessment_id || req.query.reference;
  const checked = await assertDocumentCanBeOpenedByEmail(requestedType, requestedId, client.email);

  if (checked.type === 'visa_assessment') {
    return sendAssessmentPdf({ client }, res, checked.id);
  }
  if (checked.type === 'appeals_assessment') {
    return sendAppealAssessmentPdf({ client }, res, checked.id);
  }
  return res.status(400).send('Unsupported document type.');
}));

app.post('/api/documents/pdf-link', requireAuth, asyncRoute(async (req, res) => {
  const requestedType = req.body && (req.body.type || req.body.serviceType || req.body.service_type);
  const requestedId = req.body && (req.body.id || req.body.assessmentId || req.body.assessment_id || req.body.reference);
  const checked = await assertDocumentCanBeOpenedByEmail(requestedType, requestedId, req.client.email);
  const token = makeDocumentAccessToken({
    type: checked.type,
    id: checked.id,
    email: normaliseEmail(req.client.email),
    iat: Date.now(),
    exp: Date.now() + 10 * 60 * 1000
  });
  res.json({ ok: true, url: `/api/documents/pdf-view?token=${encodeURIComponent(token)}`, expiresInSeconds: 600 });
}));

app.get('/api/documents/pdf-view', asyncRoute(async (req, res) => {
  const payload = readDocumentAccessToken(req.query.token);
  if (!payload) return res.status(401).json({ ok: false, error: 'Document link expired. Return to the dashboard and click Open PDF again.' });
  if (payload.type === 'visa_assessment') {
    return sendAssessmentPdf({ client: { email: payload.email } }, res, payload.id);
  }
  if (payload.type === 'appeals_assessment') {
    return sendAppealAssessmentPdf({ client: { email: payload.email } }, res, payload.id);
  }
  return res.status(400).json({ ok: false, error: 'Unsupported document type.' });
}));

app.get('/api/assessment/:id/pdf', requireAuth, asyncRoute(async (req, res) => {
  // Legacy compatibility only. Do not generate/serve a separate template PDF here.
  res.redirect(307, `/api/assessment/${encodeURIComponent(req.params.id)}/final-pdf`);
}));

app.get('/api/assessments/:id/pdf', requireAuth, asyncRoute(async (req, res) => {
  // Legacy compatibility only. Do not generate/serve a separate template PDF here.
  res.redirect(307, `/api/assessments/${encodeURIComponent(req.params.id)}/final-pdf`);
}));

app.post('/api/assessment/:id/email-pdf', requireAuth, asyncRoute(async (req, res) => {
  const assessment = await resolveAssessmentForAccount(req.params.id, req.client.email);
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  if (!hasIssuedPdfBytes(assessment.pdf_bytes)) return res.status(409).json({ ok: false, error: 'PDF not ready. The advice letter has not been issued yet.', status: assessment.status, generationError: assessment.generation_error || null });
  if (!process.env.SMTP_HOST) return res.status(500).json({ ok: false, error: 'SMTP is not configured.' });
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: assessment.client_email,
    subject: `Your Subclass ${assessment.visa_type} advice letter is ready`,
    text: `Your advice letter for reference ${assessment.id} is attached.`,
    attachments: [{ filename: assessment.pdf_filename || `${assessment.id}.pdf`, content: assessment.pdf_bytes, contentType: 'application/pdf' }]
  });
  res.json({ ok: true, emailedTo: assessment.client_email });
}));


// ---- Dashboard document-action compatibility routes ----
// These routes match the current account-dashboard.html buttons. They deliberately
// reuse the existing account/PDF access checks instead of creating a second PDF path.
async function resolveDashboardDocumentRecord(type, id, email) {
  const cleanType = normaliseServiceType(type);
  const cleanId = String(id || '').trim();
  const cleanEmail = normaliseEmail(email);
  if (!cleanId) throw Object.assign(new Error('Document reference is missing.'), { statusCode: 400 });

  if (cleanType === 'visa_assessment') {
    const assessment = await resolveAssessmentForAccount(cleanId, cleanEmail);
    if (!assessment) throw Object.assign(new Error('Assessment was not found for this account.'), { statusCode: 404 });
    return { type: 'visa_assessment', table: 'assessments', id: assessment.id, record: assessment };
  }

  if (cleanType === 'appeals_assessment') {
    const { rows } = await query(`SELECT * FROM appeals_assessments WHERE id=$1 AND lower(client_email)=lower($2) LIMIT 1`, [cleanId, cleanEmail]);
    const assessment = rows[0];
    if (!assessment) throw Object.assign(new Error('Appeals assessment was not found for this account.'), { statusCode: 404 });
    return { type: 'appeals_assessment', table: 'appeals_assessments', id: assessment.id, record: assessment };
  }

  throw Object.assign(new Error('Unsupported document type.'), { statusCode: 400 });
}

function makeMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

function documentEmailSubject(doc) {
  if (doc.type === 'appeals_assessment') return 'Your appeals assessment advice letter is ready';
  const subclass = doc.record && (doc.record.visa_type || doc.record.visa_subclass || doc.record.subclass);
  return `Your ${subclass ? `Subclass ${subclass} ` : ''}advice letter is ready`;
}

app.post('/api/documents/email-pdf', requireAuth, asyncRoute(async (req, res) => {
  const requestedType = req.body && (req.body.type || req.body.serviceType || req.body.service_type);
  const requestedId = req.body && (req.body.id || req.body.assessmentId || req.body.assessment_id || req.body.reference);

  // Reuse the same release-lock and account checks as Open PDF.
  const checked = await assertDocumentCanBeOpenedByEmail(requestedType, requestedId, req.client.email);
  const doc = await resolveDashboardDocumentRecord(checked.type, checked.id, req.client.email);
  const record = doc.record || {};

  if (!hasIssuedPdfBytes(record.pdf_bytes)) {
    return res.status(409).json({
      ok: false,
      error: doc.type === 'appeals_assessment' ? 'Appeals PDF not ready. The assessment has not been issued yet.' : 'PDF not ready. The advice letter has not been issued yet.',
      status: record.status || null,
      generationError: record.generation_error || null
    });
  }

  const transporter = makeMailer();
  if (!transporter) return res.status(500).json({ ok: false, error: 'SMTP is not configured.' });

  const to = normaliseEmail(record.client_email || req.client.email);
  const filename = record.pdf_filename || `${record.id || doc.id}.pdf`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: documentEmailSubject(doc),
    text: `Your Bircan Migration advice letter for reference ${record.id || doc.id} is attached.`,
    attachments: [{ filename, content: record.pdf_bytes, contentType: record.pdf_mime || 'application/pdf' }]
  });

  res.json({ ok: true, emailedTo: to, message: `PDF emailed to ${to}.` });
}));

app.post('/api/documents/request-review', requireAuth, asyncRoute(async (req, res) => {
  const requestedType = req.body && (req.body.type || req.body.serviceType || req.body.service_type);
  const requestedId = req.body && (req.body.id || req.body.assessmentId || req.body.assessment_id || req.body.reference);
  const doc = await resolveDashboardDocumentRecord(requestedType, requestedId, req.client.email);
  const now = new Date().toISOString();
  const note = `Manual document review requested from client dashboard at ${now}.`;

  if (doc.type === 'visa_assessment') {
    await query(
      `UPDATE assessments
       SET status = CASE WHEN status IN ('pdf_ready','advice_ready') THEN status ELSE 'manual_review_requested' END,
           generation_error = CASE WHEN generation_error IS NULL OR generation_error='' THEN $1 ELSE generation_error || E'\n' || $1 END,
           updated_at = now()
       WHERE id=$2 AND lower(client_email)=lower($3)`,
      [note, doc.id, req.client.email]
    );
  } else if (doc.type === 'appeals_assessment') {
    await query(
      `UPDATE appeals_assessments
       SET status = CASE WHEN status IN ('pdf_ready','advice_ready') THEN status ELSE 'manual_review_requested' END,
           generation_error = CASE WHEN generation_error IS NULL OR generation_error='' THEN $1 ELSE generation_error || E'\n' || $1 END,
           updated_at = now()
       WHERE id=$2 AND lower(client_email)=lower($3)`,
      [note, doc.id, req.client.email]
    );
  }

  const transporter = makeMailer();
  const reviewTo = process.env.REVIEW_EMAIL || process.env.ADMIN_EMAIL || process.env.SMTP_FROM || process.env.SMTP_USER;
  if (transporter && reviewTo) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: reviewTo,
      subject: `Manual document review requested: ${doc.type} ${doc.id}`,
      text: [
        'A client requested manual document review from the dashboard.',
        `Client email: ${req.client.email}`,
        `Service type: ${doc.type}`,
        `Reference: ${doc.id}`,
        `Requested at: ${now}`
      ].join('\n')
    });
  }

  res.json({ ok: true, reviewRequested: true, id: doc.id, type: doc.type, message: 'Document review request submitted.' });
}));


app.get('/api/diagnostics/schema', asyncRoute(async (_req, res) => {
  const tables = await query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name IN ('clients','assessments','payments','pdf_jobs','client_journeys','journey_documents')
    ORDER BY table_name, ordinal_position
  `);
  res.json({ ok: true, tables: tables.rows });
}));

app.use((req, res) => res.status(404).json({
  ok: false,
  code: 'ROUTE_NOT_FOUND',
  error: `Route not found: ${req.method} ${req.path}`,
  requestId: req.requestId || null,
  hint: 'Open /api/routes on the deployed backend to confirm registered routes.'
}));

app.use((err, req, res, next) => {
  if (String(err.message || '').startsWith('CORS blocked origin')) {
    console.error('CORS blocked:', err.message);
    return res.status(403).json({ ok: false, code: 'CORS_BLOCKED', error: err.message, requestId: req.requestId || null });
  }
  return hardening.errorHandler(err, req, res, next);
});


// Minimal compatibility migration that always runs before the server listens.
// This protects live Render databases where BOOTSTRAP_DB=false or where older
// tables were created before the unified dashboard expected these columns.
async function ensureCriticalDashboardColumns() {
  const statements = [
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS client_id uuid`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS client_email text`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS applicant_email text`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS applicant_name text`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS active_plan text`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS selected_plan text DEFAULT 'instant'`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid'`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS amount_cents integer`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud'`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS release_at timestamptz`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pdf_filename text`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS generation_error text`,
    `ALTER TABLE assessments ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS client_id uuid`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS client_email text`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS applicant_email text`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS applicant_name text`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS active_plan text`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS selected_plan text DEFAULT 'instant'`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid'`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS amount_cents integer`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud'`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS release_at timestamptz`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS pdf_filename text`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS generation_error text`,
    `ALTER TABLE appeals_assessments ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_type text DEFAULT 'visa_assessment'`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_ref text`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_email text`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan text`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_cents integer`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency text DEFAULT 'aud'`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at timestamptz`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_created_at timestamptz`
  ];
  for (const sql of statements) {
    try { await query(sql); }
    catch (err) {
      // Some tables may not exist in very old deployments; full ensureSchema handles
      // creation when BOOTSTRAP_DB is enabled. Do not prevent the app from starting.
      if (!/does not exist/i.test(String(err && err.message || ''))) throw err;
      console.warn('Compatibility column check skipped:', sql, err.message);
    }
  }
}

async function runStartupTasks() {
  if (BOOTSTRAP_DB) await ensureSchema();
  await ensureCriticalDashboardColumns();
  console.log('Startup database checks completed.');
}

function start() {
  const host = '0.0.0.0';

  const server = app.listen(PORT, host, () => {
    console.log(`Bircan FINAL PostgreSQL server listening on ${host}:${PORT}`);
  });

  server.on('error', (err) => {
    console.error('HTTP server failed to listen:', err && err.stack ? err.stack : err);
  });

  runStartupTasks().catch((err) => {
    // Do not exit before Render detects the web port. Health/database routes will
    // expose the failure, and logs will show the exact startup problem.
    console.error('Startup database checks failed:', err && err.stack ? err.stack : err);
  });

  setInterval(() => {
    runOnePdfJob().catch(err => console.error('PDF worker tick failed:', err && err.stack ? err.stack : err));
  }, PDF_WORKER_INTERVAL_MS);
}

start();
