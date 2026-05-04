require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { query, tx } = require('./db');
const { buildAssessmentPdfBuffer, buildAppealAdvicePdfBuffer, sha256 } = require('./pdf');
const { generateMigrationAdvice, supportedSubclasses } = require('./adviceEngine');
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
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.JWT_SECRET || 'CHANGE_ME_IN_RENDER_ENV';
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://bircanmigration.au';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY_LIVE;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const appealUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12 } });
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (_err) { pdfParse = null; }
const BOOTSTRAP_DB = String(process.env.BOOTSTRAP_DB || 'true').toLowerCase() !== 'false';
const PDF_WORKER_INTERVAL_MS = Math.max(3000, Number(process.env.PDF_WORKER_INTERVAL_MS || 10000));
const VERIFY_PAYMENT_WAIT_FOR_PDF = String(process.env.VERIFY_PAYMENT_WAIT_FOR_PDF || 'true').toLowerCase() !== 'false';

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
  const p = String(plan || '').toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
  if (['24h', '24hr', '24hour', '24hours'].includes(p)) return '24h';
  if (['3d', '3day', '3days'].includes(p)) return '3d';
  return 'instant';
}

// ---- Payload pipeline hardening v6 ----
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function normaliseValue(v) { if (v === undefined) return undefined; if (v === null) return null; if (typeof v === 'string') return v.trim(); if (Array.isArray(v)) return v.map(normaliseValue).filter(x => x !== undefined && x !== ''); if (isPlainObject(v)) { const out = {}; for (const [k, val] of Object.entries(v)) { const nv = normaliseValue(val); if (nv !== undefined && nv !== '') out[k] = nv; } return out; } return v; }
function flattenObject(input, prefix = '', out = {}) { if (!isPlainObject(input)) return out; for (const [key, value] of Object.entries(input)) { if (['password','token','auth','authorization','bm_session'].includes(String(key).toLowerCase())) continue; const name = prefix ? `${prefix}.${key}` : key; if (isPlainObject(value)) flattenObject(value, name, out); else if (Array.isArray(value)) out[name] = value.map(v => isPlainObject(v) ? JSON.stringify(v) : v).join('; '); else if (value !== undefined && value !== null && value !== '') out[name] = value; } return out; }
function buildAssessmentPayload(body, client) { const b = isPlainObject(body) ? body : {}; const source = isPlainObject(b.formPayload) ? b.formPayload : isPlainObject(b.form_payload) ? b.form_payload : isPlainObject(b.answers) ? b.answers : isPlainObject(b.formData) ? b.formData : isPlainObject(b.form_data) ? b.form_data : isPlainObject(b.payload) ? b.payload : isPlainObject(b.data) ? b.data : b; const answers = normaliseValue(source) || {}; const flatAnswers = flattenObject(answers); const meta = { submittedAt: new Date().toISOString(), clientEmail: normaliseEmail(client && client.email), applicantEmail: normaliseEmail(b.applicantEmail || b.applicant_email || b.email || (client && client.email)), applicantName: b.applicantName || b.applicant_name || b.fullName || b.full_name || b.name || answers.applicantName || answers.fullName || answers.name || null, visaType: String(b.visaType || b.visa_type || b.subclass || b.visaSubclass || answers.visaType || answers.visa_type || '').replace(/[^0-9A-Za-z]/g, '') || 'unknown', selectedPlan: safePlan(b.plan || b.selectedPlan || b.selected_plan || b.assessmentPlan || answers.plan || answers.selectedPlan || 'instant'), sourceShape: b.formPayload ? 'formPayload' : b.form_payload ? 'form_payload' : b.answers ? 'answers' : b.formData ? 'formData' : b.payload ? 'payload' : 'rawBody' }; return { meta, answers, flatAnswers, rawSubmission: normaliseValue(b) }; }
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

const corsOptions = {
  origin(origin, cb) {
    if (!origin || origin === 'null') return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (/^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return cb(null, true);
    console.error('CORS blocked origin:', origin);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Auth-Token'],
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
  const loggedInEmail = normaliseEmail(client.email);
  const metadata = {
    ...(session.metadata || {}),
    original_started_email: (session.metadata && session.metadata.original_started_email) || startedEmail || null,
    portal_login_email: loggedInEmail || null,
    portal_login_confirmed_at: new Date().toISOString(),
    fresh_login_confirmed: true
  };

  await query(
    `UPDATE service_sessions
     SET client_id=$1, client_email=$2, metadata=COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at=now()
     WHERE id=$4`,
    [client.id, client.email, JSON.stringify(metadata), session.id]
  );

  if (session.service_type === 'appeals_assessment' && session.service_ref) {
    await query(
      `UPDATE appeals_assessments
       SET client_id=$1, client_email=$2, updated_at=now()
       WHERE id=$3`,
      [client.id, client.email, session.service_ref]
    );
  }

  return { ...session, client_id: client.id, client_email: client.email, metadata };
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


function resolveVisaPriceId(_visaType, plan) {
  const key = safePlan(plan) === 'instant' ? 'INSTANT' : safePlan(plan) === '24h' ? '24H' : '3D';
  return process.env[`STRIPE_PRICE_VISA_${key}`] || process.env[`STRIPE_PRICE_VISA_${key}_TEST`] || process.env[`STRIPE_PRICE_VISA_${key}_LIVE`];
}


function resolveAppealPriceId(plan) {
  const key = safePlan(plan) === 'instant' ? 'INSTANT' : safePlan(plan) === '24h' ? '24H' : '3D';
  return process.env[`STRIPE_PRICE_APPEAL_${key}`] || process.env[`STRIPE_PRICE_APPEAL_${key}_TEST`] || process.env[`STRIPE_PRICE_APPEAL_${key}_LIVE`];
}

function normaliseCitizenshipPlan(plan) {
  const raw = String(plan || '').toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
  if (['20', '20exam', '20exams', 'starter'].includes(raw)) return '20';
  if (['50', '50exam', '50exams', 'standard'].includes(raw)) return '50';
  if (['100', '100exam', '100exams', 'premium'].includes(raw)) return '100';
  if (['unlimited', 'unlimitedexams', 'unlimitedexam', 'all'].includes(raw)) return 'unlimited';
  return '20';
}

function citizenshipExamAllowance(plan) {
  const p = normaliseCitizenshipPlan(plan);
  if (p === '50') return 50;
  if (p === '100') return 100;
  if (p === 'unlimited') return 999999;
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
  if (!session) throw Object.assign(new Error('Service session was not found. Start the service first, then continue to payment.'), { statusCode: 404 });
  const startedEmail = normaliseEmail(session.client_email);
  const loggedInEmail = normaliseEmail(req.client.email);

  // Production handoff fix:
  // The applicant/refusal email and the portal login email may be different.
  // Do not block checkout just because the public appeal form was started with
  // another email. Attach the unpaid service session to the authenticated portal
  // account, but preserve the original applicant email in metadata and in the
  // underlying appeals_assessments.applicant_email column.
  const existingMetadata = session.metadata || {};
  if (existingMetadata.require_fresh_login && !existingMetadata.portal_login_confirmed_at) {
    throw Object.assign(new Error('Login must be completed before Stripe payment. Please log in through the secure portal first.'), { statusCode: 401 });
  }

  const nextMetadata = {
    ...existingMetadata,
    original_started_email: existingMetadata.original_started_email || startedEmail || null,
    portal_login_email: loggedInEmail || null
  };

  await query(
    `UPDATE service_sessions
     SET client_id=$1, client_email=$2, metadata=COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at=now()
     WHERE id=$4`,
    [req.client.id, req.client.email, JSON.stringify(nextMetadata), session.id]
  );
  session.client_id = req.client.id;
  session.client_email = req.client.email;
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
  const plan = row.selected_plan || row.active_plan || row.plan || 'instant';
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
    plan: safePlan(plan),
    planLabel: normalisePlanLabel(plan),
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
  await query(`CREATE INDEX IF NOT EXISTS idx_citizenship_access_client_email ON citizenship_access (lower(client_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citizenship_access_stripe_session ON citizenship_access (stripe_session_id)`);

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

  await ensureClientJourneySchema(query);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique ON payments (stripe_session_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_jobs_assessment_id_unique ON pdf_jobs (assessment_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assessments_client_email ON assessments (lower(client_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_pdf_jobs_status_run_after ON pdf_jobs (status, run_after)`);
}


app.get('/api/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1');
  res.json({
    ok: true,
    service: 'bircan-final-postgres-server',
    supportedAdviceSubclasses: supportedSubclasses(),
    supportedDecisionEngineSubclasses: supportedDelegateSimulatorSubclasses(),
    version: '12.2.0-appeals-pdf-advice-after-stripe',
    postgres: true,
    jsonFallback: false,
    stripeConfigured: Boolean(stripe),
    smtpConfigured: Boolean(process.env.SMTP_HOST),
    appBaseUrl: APP_BASE_URL,
    corsPatch: 'real-pdf-pipeline-cookie-plus-bearer',
    pdfMode: 'state-machine-issued-pdf-only',
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
  const assessmentId = getRequestedAssessmentId(req);
  if (assessmentId) pendingVisaAssessment = await attachVisaAssessmentToClientById(assessmentId, client);
  const pendingServiceSession = await markServiceSessionLoginConfirmed(req, client);

  res.json({
    ok: true,
    token,
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
  const assessmentId = getRequestedAssessmentId(req);
  if (assessmentId) pendingVisaAssessment = await attachVisaAssessmentToClientById(assessmentId, client);
  const pendingServiceSession = await markServiceSessionLoginConfirmed(req, client);

  res.json({
    ok: true,
    token,
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
  const plan = built.meta.selectedPlan;
  const applicantEmail = built.meta.applicantEmail || normaliseEmail(req.client.email);
  const applicantName = built.meta.applicantName;
  if (applicantEmail !== normaliseEmail(req.client.email)) {
    return res.status(409).json({ ok: false, error: `This assessment email is ${applicantEmail}, but you are logged in as ${req.client.email}. Please use the same email address.` });
  }
  if (!payloadLooksUsable(built)) {
    return res.status(400).json({ ok: false, code: 'ASSESSMENT_PAYLOAD_MISSING', error: 'Assessment answers were not received by the server. Please submit the assessment form again before checkout.', receivedKeys: Object.keys(req.body || {}) });
  }
  const id = makeAssessmentId(visaType);
  await query(
    `INSERT INTO assessments (id, client_id, client_email, applicant_email, applicant_name, visa_type, selected_plan, active_plan, status, payment_status, form_payload, pdf_bytes, pdf_generated_at, generation_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'submitted','unpaid',$8,NULL,NULL,NULL)`,
    [id, req.client.id, req.client.email, applicantEmail, applicantName || null, visaType, plan, built]
  );
  res.json({ ok: true, assessmentId: id, status: 'submitted', plan, payloadSaved: true, answerCount: payloadAnswerCount(built) });
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
    return res.status(400).json({ ok: false, error: 'Valid email is required before login.' });
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
  const plan = built.meta.selectedPlan;
  const id = makeAssessmentId(visaType);
  await query(
    `INSERT INTO assessments (
       id, client_id, client_email, applicant_email, applicant_name,
       visa_type, selected_plan, active_plan, status, payment_status,
       form_payload, pdf_bytes, pdf_generated_at, generation_error
     ) VALUES ($1,NULL,$2,$2,$3,$4,$5,$5,'submitted','unpaid',$6,NULL,NULL,NULL)`,
    [id, email, built.meta.applicantName || null, visaType, plan, built]
  );

  const serviceSession = await upsertServiceSession({ serviceType: 'visa_assessment', serviceRef: id, email, plan, metadata: { visa_type: visaType } });

  res.json({
    ok: true,
    service: 'visa_assessment',
    serviceSessionId: serviceSession.id,
    service_session_id: serviceSession.id,
    assessmentId: id,
    assessment_id: id,
    visaType,
    plan,
    payloadSaved: true,
    answerCount: payloadAnswerCount(built),
    next: `/login.html?service=visa&service_session_id=${encodeURIComponent(serviceSession.id)}&assessment_id=${encodeURIComponent(id)}`
  });
}

app.post('/api/public/visa-assessment/start', asyncRoute(handlePublicVisaAssessmentStart));
app.post('/api/visa-assessment/start', asyncRoute(handlePublicVisaAssessmentStart));
app.post('/api/assessment/public-start', asyncRoute(handlePublicVisaAssessmentStart));




async function handleAppealsAssessmentCreate(req, res) {
  const plan = safePlan(req.body.plan || req.body.selectedPlan || req.body.selected_plan || 'instant');
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

  const generatedId = makeAppealAssessmentId();
  const insertResult = await query(
    `INSERT INTO appeals_assessments (
       id, client_email, applicant_email, applicant_name, visa_subclass, decision_type,
       decision_date, tribunal_deadline, current_location, has_previous_appeal,
       appeal_grounds, urgency_notes, selected_plan, active_plan, status, payment_status,
       uploaded_filename, uploaded_mime_type, uploaded_size, uploaded_file, public_draft_key, release_at
     ) VALUES (
       $1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,'submitted','unpaid',$13,$14,$15,$16,$17,${appealReleaseAtSql(plan)}
     )
     ON CONFLICT (public_draft_key) WHERE public_draft_key IS NOT NULL DO UPDATE SET
       updated_at=now(),
       selected_plan=EXCLUDED.selected_plan,
       active_plan=EXCLUDED.active_plan
     RETURNING id, (xmax = 0) AS inserted`,
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
      publicDraftKey
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
    next: `/login.html?service=appeals&service_session_id=${encodeURIComponent(serviceSession.id)}&appeal_assessment_id=${encodeURIComponent(id)}`
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



app.post('/api/service/checkout-session', requireAuth, asyncRoute(async (req, res) => {
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
    const price = resolveVisaPriceId(assessment.visa_type, assessment.selected_plan);
    if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for visa plan ${assessment.selected_plan}.` });
    const stripeSession = await stripe.checkout.sessions.create({
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
        plan: assessment.selected_plan,
        client_email: req.client.email
      }
    }, { idempotencyKey: `service-visa-checkout-${serviceSession.id}-${assessment.selected_plan}` });
    await query(`UPDATE assessments SET stripe_session_id=$1, status='checkout_created', active_plan=selected_plan, amount_cents=$2, currency=$3, updated_at=now() WHERE id=$4`, [stripeSession.id, stripeSession.amount_total || null, stripeSession.currency || 'aud', assessment.id]);
    await markServiceSessionCheckoutCreated(serviceSession.id, stripeSession.id);
    await recordPaymentAuditSafe(assessment.id, req.client.email, stripeSession);
    return res.json({ ok: true, service: 'visa_assessment', url: stripeSession.url, sessionId: stripeSession.id, serviceSessionId: serviceSession.id, assessmentId: assessment.id, plan: assessment.selected_plan });
  }

  if (serviceSession.service_type === 'appeals_assessment') {
    const assessmentId = serviceSession.service_ref;
    const { rows } = await query('SELECT * FROM appeals_assessments WHERE id=$1', [assessmentId]);
    const assessment = rows[0];
    if (!assessment) return res.status(404).json({ ok: false, error: 'Appeals assessment was not found.' });
    const plan = safePlan(serviceSession.selected_plan || assessment.selected_plan || 'instant');
    const price = resolveAppealPriceId(plan);
    if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for appeals plan ${plan}.` });
    await query(`UPDATE appeals_assessments SET client_id=$1, client_email=$2, selected_plan=$3, active_plan=$3, release_at=${appealReleaseAtSql(plan)}, updated_at=now() WHERE id=$4`, [req.client.id, req.client.email, plan, assessmentId]);
    const stripeSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.client.email,
      client_reference_id: assessmentId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_BASE_URL}/payment-complete.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/appeals-assessment.html?cancelled=1&service_session_id=${encodeURIComponent(serviceSession.id)}&appeal_assessment_id=${encodeURIComponent(assessmentId)}`,
      metadata: { service_type: 'appeals_assessment', service_session_id: serviceSession.id, service_ref: assessmentId, assessment_id: assessmentId, appeal_assessment_id: assessmentId, visa_type: assessment.visa_subclass || 'appeals', plan, client_email: req.client.email }
    }, { idempotencyKey: `service-appeals-checkout-${serviceSession.id}-${plan}` });
    await query(`UPDATE appeals_assessments SET stripe_session_id=$1, status='checkout_created', amount_cents=$2, currency=$3, updated_at=now() WHERE id=$4`, [stripeSession.id, stripeSession.amount_total || appealAmountCents(plan), stripeSession.currency || 'aud', assessmentId]);
    await markServiceSessionCheckoutCreated(serviceSession.id, stripeSession.id);
    await recordAppealPaymentAuditSafe(assessmentId, req.client.email, stripeSession);
    return res.json({ ok: true, service: 'appeals_assessment', url: stripeSession.url, sessionId: stripeSession.id, serviceSessionId: serviceSession.id, assessmentId, plan });
  }

  if (serviceSession.service_type === 'citizenship_test') {
    const plan = normaliseCitizenshipPlan(serviceSession.selected_plan || req.body.plan || '20');
    const price = resolveCitizenshipPriceId(plan);
    if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for citizenship plan ${plan}.` });
    const accessId = serviceSession.service_ref || makeCitizenshipAccessId(plan);
    await query(
      `INSERT INTO citizenship_access (id, client_id, client_email, selected_plan, active_plan, exam_allowance, attempts_used, status, payment_status)
       VALUES ($1,$2,$3,$4,$4,$5,0,'checkout_created','unpaid')
       ON CONFLICT (id) DO UPDATE SET client_id=$2, client_email=$3, selected_plan=$4, active_plan=$4, exam_allowance=$5, updated_at=now()`,
      [accessId, req.client.id, req.client.email, plan, citizenshipExamAllowance(plan)]
    );
    await upsertServiceSession({ id: serviceSession.id, serviceType: 'citizenship_test', serviceRef: accessId, email: req.client.email, clientId: req.client.id, plan, status: 'draft_created', metadata: { citizenship_access_id: accessId } });
    const stripeSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.client.email,
      client_reference_id: accessId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_BASE_URL}/payment-complete.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/citizenship.html?cancelled=1&service_session_id=${encodeURIComponent(serviceSession.id)}&plan=${encodeURIComponent(plan)}`,
      metadata: { service_type: 'citizenship_test', service_session_id: serviceSession.id, service_ref: accessId, citizenship_access_id: accessId, plan, client_email: req.client.email }
    }, { idempotencyKey: `service-citizenship-checkout-${serviceSession.id}-${plan}` });
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
  const plan = normaliseCitizenshipPlan(req.body.plan || req.body.selectedPlan || '20');
  const serviceSession = await upsertServiceSession({ serviceType: 'citizenship_test', email, plan, metadata: { source: 'citizenship_public_start' } });
  res.json({ ok: true, service: 'citizenship_test', serviceSessionId: serviceSession.id, service_session_id: serviceSession.id, plan, next: `/login.html?service=citizenship&service_session_id=${encodeURIComponent(serviceSession.id)}` });
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

  const plan = safePlan(requestedPlan || assessment.selected_plan || 'instant');
  const price = resolveAppealPriceId(plan);
  if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for appeals plan ${plan}. Add STRIPE_PRICE_APPEAL_${plan === 'instant' ? 'INSTANT' : plan === '24h' ? '24H' : '3D'} in Render.` });

  await query(
    `UPDATE appeals_assessments
     SET client_id=$1, client_email=$2, selected_plan=$3, active_plan=$3, release_at=${appealReleaseAtSql(plan)}, updated_at=now()
     WHERE id=$4`,
    [req.client.id, req.client.email, plan, assessmentId]
  );

  const session = await stripe.checkout.sessions.create({
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
  }, { idempotencyKey: `appeals-checkout-${assessmentId}-${plan}` });

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
    const fake = {
      ...session,
      metadata: { ...(session.metadata || {}), service_type: 'appeals_assessment' }
    };
    const stripeCreatedAt = session.created ? new Date(Number(session.created) * 1000) : new Date();
    await query(
      `INSERT INTO payments (client_id, client_email, service_type, service_ref, visa_type, plan, stripe_session_id, stripe_payment_intent, amount_cents, currency, status, raw_payload, paid_at, stripe_created_at)
       VALUES ($1,$2,'appeals_assessment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT (stripe_session_id) DO UPDATE SET
         client_id=COALESCE(EXCLUDED.client_id, payments.client_id),
         client_email=COALESCE(EXCLUDED.client_email, payments.client_email),
         service_type='appeals_assessment',
         service_ref=COALESCE(EXCLUDED.service_ref, payments.service_ref),
         visa_type=COALESCE(EXCLUDED.visa_type, payments.visa_type),
         plan=COALESCE(EXCLUDED.plan, payments.plan),
         stripe_payment_intent=COALESCE(EXCLUDED.stripe_payment_intent, payments.stripe_payment_intent),
         amount_cents=COALESCE(EXCLUDED.amount_cents, payments.amount_cents),
         currency=COALESCE(EXCLUDED.currency, payments.currency),
         status=COALESCE(EXCLUDED.status, payments.status),
         raw_payload=COALESCE(EXCLUDED.raw_payload, payments.raw_payload),
         updated_at=now()`,
      [
        assessment.client_id || null,
        normaliseEmail(email || assessment.client_email),
        assessmentId,
        assessment.visa_subclass || 'appeals',
        assessment.selected_plan || 'instant',
        session.id || null,
        session.payment_intent || null,
        session.amount_total || assessment.amount_cents || appealAmountCents(assessment.selected_plan),
        session.currency || assessment.currency || 'aud',
        session.payment_status === 'paid' || session.status === 'complete' ? 'paid' : (session.payment_status || session.status || 'pending'),
        fake,
        stripeCreatedAt
      ]
    );
    return { ok: true };
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
    const stripeCreatedAt = session.created ? new Date(Number(session.created) * 1000) : new Date();
    await query(
      `INSERT INTO payments (client_id, client_email, service_type, service_ref, visa_type, plan, stripe_session_id, stripe_payment_intent, amount_cents, currency, status, raw_payload, paid_at, stripe_created_at)
       SELECT client_id, client_email, 'citizenship_test', id, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $9
       FROM citizenship_access
       WHERE id=$1
       ON CONFLICT (stripe_session_id) DO UPDATE SET
         client_id=COALESCE(EXCLUDED.client_id, payments.client_id),
         client_email=COALESCE(EXCLUDED.client_email, payments.client_email),
         service_type='citizenship_test',
         service_ref=COALESCE(EXCLUDED.service_ref, payments.service_ref),
         plan=COALESCE(EXCLUDED.plan, payments.plan),
         stripe_payment_intent=COALESCE(EXCLUDED.stripe_payment_intent, payments.stripe_payment_intent),
         amount_cents=COALESCE(EXCLUDED.amount_cents, payments.amount_cents),
         currency=COALESCE(EXCLUDED.currency, payments.currency),
         status=COALESCE(EXCLUDED.status, payments.status),
         raw_payload=COALESCE(EXCLUDED.raw_payload, payments.raw_payload),
         updated_at=now()`,
      [
        accessId,
        normaliseCitizenshipPlan(plan),
        session.id || null,
        session.payment_intent || null,
        session.amount_total || null,
        session.currency || 'aud',
        session.payment_status === 'paid' || session.status === 'complete' ? 'paid' : (session.payment_status || session.status || 'pending'),
        session,
        stripeCreatedAt
      ]
    );
    return { ok: true };
  } catch (err) {
    console.error('Citizenship payment audit insert/update skipped safely:', err.message);
    return { ok: false, skipped: true, error: err.message };
  }
}

async function handleCitizenshipCheckoutSession(req, res) {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const plan = normaliseCitizenshipPlan(req.body.plan || req.body.selectedPlan || req.body.selected_plan || req.query.plan || '20');
  const price = resolveCitizenshipPriceId(plan);
  if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for citizenship plan ${plan}. Add STRIPE_PRICE_CITIZENSHIP_${plan.toUpperCase()} in Render.` });

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

  const session = await stripe.checkout.sessions.create({
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
  }, { idempotencyKey: `citizenship-checkout-${req.client.id}-${plan}-${accessId}` });

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
  const accessId = md.citizenship_access_id || session.client_reference_id;
  const email = normaliseEmail(md.client_email || session.customer_email);
  if (!accessId) throw new Error('Stripe citizenship session is missing citizenship_access_id metadata.');
  if (!email) throw new Error('Stripe citizenship session is missing client email.');

  const { rows } = await query('SELECT * FROM citizenship_access WHERE id=$1', [accessId]);
  const access = rows[0];
  if (!access) throw new Error(`Citizenship access not found for Stripe session ${session.id}`);
  if (normaliseEmail(access.client_email) !== email) throw new Error('Stripe email does not match citizenship account email.');

  const paid = !session.payment_status || session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) throw new Error(`Stripe session is not paid yet. Current status: ${session.payment_status || session.status || 'unknown'}`);

  const plan = normaliseCitizenshipPlan(md.plan || access.selected_plan || '20');
  await query(
    `UPDATE citizenship_access
     SET status='active', payment_status='paid', stripe_session_id=$1, stripe_payment_intent=$2,
         amount_cents=$3, currency=$4, active_plan=$5, exam_allowance=$6, raw_payload=$7, updated_at=now()
     WHERE id=$8`,
    [session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', plan, citizenshipExamAllowance(plan), session, accessId]
  );

  const paymentAudit = await recordCitizenshipPaymentAuditSafe(accessId, email, session, plan);
  return { attached: true, assessmentId: accessId, accessId, type: 'citizenship_test', plan, pdfReady: false, paymentAudit };
}

app.post('/api/citizenship/checkout-session', requireAuth, asyncRoute(handleCitizenshipCheckoutSession));
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

app.post('/api/assessment/create-checkout-session', requireAuth, asyncRoute(async (req, res) => {
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
      plan: assessment.selected_plan,
      redirectUrl: `${APP_BASE_URL}/account-dashboard.html?assessment_id=${encodeURIComponent(assessment.id)}`
    });
  }

  const price = resolveVisaPriceId(assessment.visa_type, assessment.selected_plan);
  if (!price) return res.status(500).json({ ok: false, error: `Missing Stripe price for visa plan ${assessment.selected_plan}.` });

  const session = await stripe.checkout.sessions.create({
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
      plan: assessment.selected_plan,
      client_email: req.client.email
    }
  }, { idempotencyKey: `visa-checkout-${assessment.id}-${assessment.selected_plan}` });

  await query(
    `UPDATE assessments
     SET stripe_session_id=$1,
         status='checkout_created',
         active_plan=selected_plan,
         amount_cents=$2,
         currency=$3,
         updated_at=now()
     WHERE id=$4`,
    [session.id, session.amount_total || null, session.currency || 'aud', assessment.id]
  );

  await recordPaymentAuditSafe(assessment.id, req.client.email, session);
  res.json({ ok: true, url: session.url, sessionId: session.id, assessmentId: assessment.id, assessment_id: assessment.id, plan: assessment.selected_plan });
}));


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

    const hasUniqueStripeSession = columns.has('stripe_session_id') && values.stripe_session_id;
    const conflictSql = hasUniqueStripeSession
      ? `ON CONFLICT (stripe_session_id) DO UPDATE SET ${updateAssignments.join(', ')}`
      : `ON CONFLICT DO NOTHING`;

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

async function attachPaidSession(session, options = {}) {
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
    if (normaliseEmail(assessment.client_email) !== email) throw new Error('Stripe email does not match assessment account email.');

    const paid = !session.payment_status || session.payment_status === 'paid' || session.status === 'complete';
    if (!paid) throw new Error(`Stripe session is not paid yet. Current status: ${session.payment_status || session.status || 'unknown'}`);

    const paidPlan = safePlan(assessment.selected_plan || assessment.active_plan || (session.metadata || {}).plan || 'instant');
    const nextAssessmentStatus = assessment.pdf_bytes ? 'pdf_ready' : (isInstantPlan(paidPlan) ? 'pdf_queued' : 'release_scheduled');
    await client.query(
      `UPDATE assessments
       SET status=$1,
           payment_status='paid', stripe_session_id=$2, stripe_payment_intent=$3,
           amount_cents=$4, currency=$5, active_plan=selected_plan,
           release_at=${releaseIntervalSqlForPlan(paidPlan)}, generation_error=NULL, updated_at=now()
       WHERE id=$6`,
      [nextAssessmentStatus, session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', assessmentId]
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
  return { attached: true, assessmentId, pdfReady: Boolean(pdfResult && pdfResult.has_pdf !== false), pdf: pdfResult, paymentAudit };
}

app.post('/api/assessment/verify-payment', asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.body.sessionId || req.body.session_id || req.query.session_id;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  const session = await stripe.checkout.sessions.retrieve(sessionId);
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
    client
  });
}));

app.get('/api/assessment/verify-payment', asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.query.session_id || req.query.sessionId;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const result = await attachPaidSession(session, { triggerGeneration: true, waitForPdf: VERIFY_PAYMENT_WAIT_FOR_PDF });

  const email = normaliseEmail((session.metadata || {}).client_email || session.customer_email);
  let client = null;
  if (email) {
    const clientRows = await query('SELECT id, email, name FROM clients WHERE lower(email)=lower($1)', [email]);
    client = clientRows.rows[0] || null;
    if (client) setSessionCookie(res, sign(client));
  }

  res.json({ ok: true, status: 'paid', sessionId, service: result.type || (session.metadata || {}).service_type || 'visa_assessment', assessmentId: result.assessmentId, accessId: result.accessId || null, citizenshipAccessId: result.accessId || null, plan: result.plan || null, pdfReady: result.pdfReady, client });
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


async function finaliseStripePayment(req, res) {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });

  const sessionId = req.body.sessionId || req.body.session_id || req.body.checkoutSessionId || req.query.session_id || req.query.sessionId;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) {
    return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
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
      const legalEngineInputs = buildLegalEnginePdfInputs(assessment);
      if (legalEngineInputs) {
        const enrichedAdviceBundle = attachPathwayComparisonToAdviceBundle(
          legalEngineInputs.adviceBundle,
          legalEngineInputs.assessmentForPdf || assessment
        );
        pdf = await buildAssessmentPdfBuffer(legalEngineInputs.assessmentForPdf, enhanceAdviceBundleForCommercialOutput(enrichedAdviceBundle, legalEngineInputs.assessmentForPdf || assessment));
      } else {
        const adviceBundle = await generateMigrationAdvice(assessment);
        const enrichedAdviceBundle = attachPathwayComparisonToAdviceBundle(adviceBundle, assessment);
        pdf = await buildAssessmentPdfBuffer(assessment, enhanceAdviceBundleForCommercialOutput(enrichedAdviceBundle, assessment));
      }
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

app.get('/api/account/dashboard', requireAuth, asyncRoute(async (req, res) => {
  const { rows: assessments } = await query(
    `SELECT id, 'visa_assessment' AS service_type, visa_type, applicant_email, applicant_name, selected_plan, active_plan,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN 'pdf_ready' ELSE status END AS status,
            payment_status, amount_cents, currency, stripe_session_id, created_at, updated_at,
            COALESCE(release_at, created_at) AS release_at,
            pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf,
            CASE WHEN payment_status='paid' AND now() >= COALESCE(release_at, now()) THEN true ELSE false END AS release_ready,
            GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(release_at, now()) - now())))::integer AS release_seconds_remaining
     FROM assessments
     WHERE lower(client_email)=lower($1)
     ORDER BY created_at DESC`,
    [req.client.email]
  );
  const { rows: appealAssessments } = await query(
    `SELECT id, 'appeals_assessment' AS service_type, visa_subclass, decision_type, applicant_email, applicant_name, selected_plan, active_plan,
            status, payment_status, amount_cents, currency, stripe_session_id, created_at, updated_at,
            release_at, pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf,
            CASE WHEN payment_status='paid' AND now() >= COALESCE(release_at, now()) THEN true ELSE false END AS release_ready,
            GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(release_at, now()) - now())))::integer AS release_seconds_remaining
     FROM appeals_assessments
     WHERE lower(client_email)=lower($1)
     ORDER BY created_at DESC`,
    [req.client.email]
  );
  const { rows: citizenshipAccess } = await query(
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
  const payments = paymentRows.map(p => ({
    ...p,
    stripeSessionId: p.stripe_session_id || null,
    stripePaymentIntent: p.stripe_payment_intent || null,
    amountCents: p.amount_cents || null,
    paymentDate: p.payment_date || p.created_at || null,
    date: p.payment_date || p.created_at || null,
    service: p.visa_type ? `Subclass ${p.visa_type} assessment` : (p.service_type || 'Payment'),
    reference: p.service_ref || null
  }));
  const serviceCards = [
    ...assessments.map(buildUnifiedServiceCard),
    ...appealAssessments.map(buildUnifiedServiceCard),
    ...citizenshipAccess.map(buildUnifiedServiceCard)
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({
    ok: true,
    client: req.client,
    counts: {
      activeServices: serviceCards.length,
      visaMatters: assessments.length,
      appealsMatters: appealAssessments.length,
      documentsReady: serviceCards.filter(c => c.ready && c.hasPdf).length,
      documentsLocked: serviceCards.filter(c => c.locked).length,
      payments: payments.length,
      citizenship: citizenshipAccess.filter(c => c.payment_status === 'paid' || c.status === 'active').length
    },
    serviceCards,
    unifiedCards: serviceCards,
    assessments,
    appealsAssessments: appealAssessments,
    appeals: appealAssessments,
    citizenshipAccess,
    citizenship: citizenshipAccess,
    payments
  });
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
  const { rows } = await query(
    `SELECT * FROM appeals_assessments WHERE id=$1 AND lower(client_email)=lower($2) LIMIT 1`,
    [String(rawId || '').trim(), req.client.email]
  );
  const assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Appeals assessment was not found for this account.' });
  if (assessment.release_at && new Date(assessment.release_at).getTime() > Date.now()) {
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
  const assessment = await resolveAssessmentForAccount(rawId, req.client.email);
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  if (assessment.release_at && new Date(assessment.release_at).getTime() > Date.now()) {
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

async function start() {
  if (BOOTSTRAP_DB) await ensureSchema();
  setInterval(() => runOnePdfJob().catch(err => console.error('PDF worker tick failed:', err)), PDF_WORKER_INTERVAL_MS);
  app.listen(PORT, () => console.log(`Bircan FINAL PostgreSQL server listening on ${PORT}`));
}

start().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
