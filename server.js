require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { query, tx } = require('./db');
const { buildAssessmentPdfBuffer, sha256 } = require('./pdf');
const { generateMigrationAdvice, supportedSubclasses } = require('./adviceEngine');

const app = express();
const PORT = process.env.PORT || 4242;
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.JWT_SECRET || 'CHANGE_ME_IN_RENDER_ENV';
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://bircanmigration.au';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY_LIVE;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
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

function makeAssessmentId(visaType) {
  return `sub_${Date.now()}_${String(visaType || 'visa').toLowerCase()}_${Math.random().toString(16).slice(2, 10)}`;
}

function resolveVisaPriceId(_visaType, plan) {
  const key = safePlan(plan) === 'instant' ? 'INSTANT' : safePlan(plan) === '24h' ? '24H' : '3D';
  return process.env[`STRIPE_PRICE_VISA_${key}`] || process.env[`STRIPE_PRICE_VISA_${key}_TEST`] || process.env[`STRIPE_PRICE_VISA_${key}_LIVE`];
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
      updated_at timestamptz NOT NULL DEFAULT now()
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
    version: '11.2.0-subclass190-deterministic-engine-integrated',
    postgres: true,
    jsonFallback: false,
    stripeConfigured: Boolean(stripe),
    smtpConfigured: Boolean(process.env.SMTP_HOST),
    appBaseUrl: APP_BASE_URL,
    corsPatch: 'real-pdf-pipeline-cookie-plus-bearer',
    pdfMode: 'state-machine-issued-pdf-only-190-deterministic',
    allowedOrigins
  });
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
  res.json({ ok: true, token, client });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = normaliseEmail(req.body.email);
  const password = String(req.body.password || '');
  const { rows } = await query('SELECT id, email, name, password_hash FROM clients WHERE email=$1', [email]);
  const client = rows[0];
  if (!client || !(await bcrypt.compare(password, client.password_hash))) return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
  const token = sign(client);
  setSessionCookie(res, token);
  res.json({ ok: true, token, client: { id: client.id, email: client.email, name: client.name } });
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

app.post('/api/assessment/create-checkout-session', requireAuth, asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const assessmentId = req.body.assessmentId || req.body.assessment_id;
  const { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [assessmentId, req.client.email]);
  const assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
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
  await query(`UPDATE assessments SET stripe_session_id=$1, status='checkout_created', updated_at=now() WHERE id=$2`, [session.id, assessment.id]);
  res.json({ ok: true, url: session.url, sessionId: session.id, assessmentId: assessment.id, plan: assessment.selected_plan });
}));


async function recordPaymentAuditSafe(assessmentId, email, session) {
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

    const values = {
      client_id: assessment.client_id || null,
      client_email: email,
      service_type: 'visa_assessment',
      service_ref: assessmentId,
      visa_type: assessment.visa_type || null,
      plan: assessment.selected_plan || assessment.active_plan || null,
      stripe_session_id: session.id || null,
      stripe_payment_intent: session.payment_intent || null,
      amount_cents: session.amount_total || null,
      currency: session.currency || 'aud',
      status: 'paid',
      raw_payload: session,
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
      placeholders.push('now()');
    }

    if (!names.includes('client_email') && columns.get('client_email')?.is_nullable === 'NO') {
      return { ok: false, skipped: true, reason: 'payments_client_email_required_but_missing' };
    }

    await query(
      `INSERT INTO payments (${names.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`,
      params
    );
    return { ok: true };
  } catch (err) {
    console.error('Payment audit insert skipped safely:', err.message);
    return { ok: false, skipped: true, error: err.message };
  }
}

async function attachPaidSession(session, options = {}) {
  const md = session.metadata || {};
  if (md.service_type !== 'visa_assessment') return { attached: false, reason: 'not_visa_assessment' };
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

    const nextAssessmentStatus = assessment.pdf_bytes ? 'pdf_ready' : 'pdf_queued';
    await client.query(
      `UPDATE assessments
       SET status=$1,
           payment_status='paid', stripe_session_id=$2, stripe_payment_intent=$3,
           amount_cents=$4, currency=$5, active_plan=selected_plan, generation_error=NULL, updated_at=now()
       WHERE id=$6`,
      [nextAssessmentStatus, session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', assessmentId]
    );

    // Do not insert into payments inside this transaction.
    // Some live databases have an old payments.id column with NOT NULL but no default.
    // A failing audit insert must never roll back the paid assessment attachment.

    if (!assessment.pdf_bytes) {
      await client.query(
        `INSERT INTO pdf_jobs (assessment_id, status, run_after)
         VALUES ($1,'queued',now())
         ON CONFLICT (assessment_id) DO UPDATE SET status='queued', run_after=now(), locked_at=NULL, last_error=NULL, updated_at=now()`,
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
  if (options.triggerGeneration) {
    if (options.waitForPdf) {
      pdfResult = await generateAssessmentPdfNow(assessmentId, email);
    } else {
      setImmediate(() => generateAssessmentPdfNow(assessmentId).catch(err => console.error('Immediate PDF generation failed:', err.message)));
    }
  }
  return { attached: true, assessmentId, pdfReady: Boolean(pdfResult && pdfResult.has_pdf !== false), pdf: pdfResult, paymentAudit };
}

app.post('/api/assessment/verify-payment', requireAuth, asyncRoute(async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.body.sessionId || req.body.session_id || req.query.session_id;
  if (!sessionId || String(sessionId).includes('{CHECKOUT_SESSION_ID}')) return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const result = await attachPaidSession(session, { triggerGeneration: true, waitForPdf: VERIFY_PAYMENT_WAIT_FOR_PDF });
  res.json({ ok: true, status: 'paid', sessionId, assessmentId: result.assessmentId, pdfReady: result.pdfReady });
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

  const redirectUrl = `${APP_BASE_URL}/account-dashboard.html?payment=verified&assessment_id=${encodeURIComponent(result.assessmentId || '')}&session_id=${encodeURIComponent(sessionId)}`;
  res.json({
    ok: true,
    status: 'paid',
    paymentLinked: true,
    sessionId,
    assessmentId: result.assessmentId,
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
  await query(`INSERT INTO pdf_jobs (assessment_id, status, run_after) VALUES ($1,'queued',now()) ON CONFLICT (assessment_id) DO UPDATE SET status='queued', run_after=now(), last_error=NULL, updated_at=now()`, [assessmentId]);
  const result = await generateAssessmentPdfNow(assessmentId, req.client.email, { force: true });
  res.json({ ok: true, status: 'pdf_ready', assessment: result });
}));



// ---- Subclass 190 deterministic decision engine v1 ----
// This layer is intentionally embedded in server.js so Render cannot miss extra engine files.
// It does not let GPT decide the legal outcome. It forces validity/risk classifications
// before the PDF renderer receives the advice bundle.
function deepTextSearch(obj, patterns) {
  const hay = JSON.stringify(obj || {}).toLowerCase();
  return patterns.some(p => hay.includes(String(p).toLowerCase()));
}

function firstValue(obj, keys) {
  const flat = flattenObject(obj || {});
  const wanted = keys.map(k => String(k).toLowerCase());
  for (const [k, v] of Object.entries(flat)) {
    const lk = String(k).toLowerCase();
    if (wanted.some(w => lk.includes(w)) && v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function parseMaybeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function looksPlausibleRecentMigrationDate(v) {
  const d = parseMaybeDate(v);
  if (!d) return false;
  const y = d.getUTCFullYear();
  return y >= 2012 && y <= new Date().getUTCFullYear() + 1;
}

function yesLike(v) {
  return /^(yes|y|true|held|approved|current|valid|positive)$/i.test(String(v || '').trim());
}

function noOrBadLike(v) {
  return /(no|none|unknown|unsure|withdrawn|expired|refused|invalid|not held|not provided|missing)/i.test(String(v || ''));
}

function buildSubclass190DecisionEngineOutput(assessment) {
  const payload = assessment && assessment.form_payload ? assessment.form_payload : {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload || {};
  const flat = payload.flatAnswers || flattenObject(answers);

  const dob = firstValue(answers, ['dateOfBirth', 'date_of_birth', 'dob', 'birth']);
  const invitationDate = firstValue(answers, ['invitationDate', 'invitation_date', 'skillselect invitation date', 'invited date']);
  const nominationDate = firstValue(answers, ['nominationDate', 'nomination_date', 'state nomination date']);
  const skillsDate = firstValue(answers, ['skillsAssessmentDate', 'skills assessment date', 'assessment date']);

  const invitationHeld = firstValue(answers, ['invitationReceived', 'invitation received', 'skillselect invitation', 'invitation held', 'invited']);
  const nominationHeld = firstValue(answers, ['nominationStatus', 'state nomination', 'territory nomination', 'nomination held', 'nomination status']);
  const skillsHeld = firstValue(answers, ['skillsAssessment', 'skills assessment', 'positive skills', 'assessment outcome']);
  const englishEvidence = firstValue(answers, ['english', 'competent english', 'passport country', 'ielts', 'pte']);
  const pointsClaim = firstValue(answers, ['points', 'pointsTotal', 'claimed points', 'pass mark']);
  const occupation = firstValue(answers, ['nominatedOccupation', 'occupation', 'anzsco']) || 'nominated occupation';

  const hasSection48 = deepTextSearch(answers, ['section 48', 's48', 'known section 48', 'bar present']);
  const noFurtherStay = deepTextSearch(answers, ['no further stay', '8503', '8534', '8535', 'condition present and unresolved']);
  const integrityRisk = deepTextSearch(answers, ['pic 4020', 'integrity issue', 'false document', 'misleading information']);
  const healthRisk = deepTextSearch(answers, ['health issue', 'medical issue', 'health requirement requiring further review']);
  const characterRisk = deepTextSearch(answers, ['character issue', 'police issue', 'court', 'criminal', 'character requirement requiring further review']);
  const childIncluded = deepTextSearch(answers, ['dependent child', 'custody', 'secondary applicant', 'family member']);

  const findings = [];
  function add(ruleId, criterion, status, legalEffect, severity, evidence, consequence, recommendation) {
    findings.push({ ruleId, criterion, status, legalEffect, severity, evidence, consequence, recommendation });
  }

  const invitationBad = !yesLike(invitationHeld) || noOrBadLike(invitationHeld) || !looksPlausibleRecentMigrationDate(invitationDate);
  add('190_INVITATION_RECEIVED', 'Valid SkillSelect invitation', invitationBad ? 'fail' : 'pass', 'INVALID APPLICATION', 'blocker', invitationBad ? 'No verifiable SkillSelect invitation letter with a plausible invitation date was identified.' : 'Invitation information appears present.', invitationBad ? 'A Subclass 190 application must not proceed without a valid invitation. The application is not lodgeable on the information provided.' : 'No blocker detected for this criterion.', invitationBad ? 'Obtain the official SkillSelect invitation letter showing subclass, invitation date, nominated occupation and points score.' : 'Verify the original invitation document before lodgement.');

  const nominationBad = !yesLike(nominationHeld) || noOrBadLike(nominationHeld) || !looksPlausibleRecentMigrationDate(nominationDate);
  add('190_STATE_NOMINATION_CURRENT', 'Current state or territory nomination', nominationBad ? 'fail' : 'pass', 'INVALID APPLICATION', 'blocker', nominationBad ? 'No current state or territory nomination approval was verified. The questionnaire suggests the nomination may be withdrawn, expired, unknown or unsupported.' : 'Nomination information appears present.', nominationBad ? 'A current nomination is central to the Subclass 190 pathway. The matter is not lodgeable unless a current nomination is verified.' : 'No blocker detected for this criterion.', nominationBad ? 'Secure and verify a current state or territory nomination approval matching the nominated occupation.' : 'Review the official nomination approval before lodgement.');

  const skillsBad = !yesLike(skillsHeld) || noOrBadLike(skillsHeld) || !looksPlausibleRecentMigrationDate(skillsDate);
  add('190_SKILLS_ASSESSMENT_POSITIVE', 'Suitable skills assessment for nominated occupation', skillsBad ? 'fail' : 'pass', 'REFUSAL LIKELY', 'critical', skillsBad ? 'No positive and valid skills assessment was verified for the nominated occupation.' : 'Skills assessment information appears present.', skillsBad ? 'If a valid skills assessment was not held at the required time, refusal risk is critical.' : 'No critical defect detected for this criterion.', skillsBad ? `Obtain and verify the skills assessment outcome for ${occupation}, including assessing authority, outcome date, expiry and occupation match.` : 'Check occupation match and validity at invitation date.');

  const englishBad = !englishEvidence || noOrBadLike(englishEvidence);
  add('190_COMPETENT_ENGLISH', 'Competent English', englishBad ? 'unknown' : 'pass', englishBad ? 'EVIDENCE GAP' : 'SATISFIED SUBJECT TO VERIFICATION', englishBad ? 'high' : 'low', englishBad ? 'No English test result or eligible passport evidence was verified.' : 'English evidence is stated but must be verified.', englishBad ? 'Competent English cannot be safely treated as met until evidence is reviewed.' : 'No issue detected subject to original evidence review.', englishBad ? 'Provide English test results or eligible passport evidence.' : 'Verify original English evidence.');

  const pointsNum = Number(String(pointsClaim || '').replace(/[^0-9.]/g, ''));
  const pointsBad = !pointsClaim || noOrBadLike(pointsClaim) || !(pointsNum >= 65);
  add('190_POINTS_MINIMUM_65', 'Points test threshold', pointsBad ? 'fail' : 'pass', pointsBad ? 'REFUSAL LIKELY' : 'SATISFIED SUBJECT TO VERIFICATION', 'critical', pointsBad ? 'No reliable points calculation at or above 65 points was verified.' : `Claimed/calculated points appear to be ${pointsNum}.`, pointsBad ? 'If the points score is below the pass mark or cannot be evidenced, refusal risk is critical.' : 'No critical issue detected subject to evidence.', pointsBad ? 'Prepare a full points calculation and verify each claimed component with supporting evidence.' : 'Verify evidence supporting each points component.');

  let ageStatus = 'unknown';
  let ageEvidence = 'Date of birth and/or invitation date could not be reliably verified.';
  const dobD = parseMaybeDate(dob), invD = parseMaybeDate(invitationDate);
  if (dobD && invD && looksPlausibleRecentMigrationDate(invitationDate)) {
    const age = invD.getUTCFullYear() - dobD.getUTCFullYear() - ((invD.getUTCMonth() < dobD.getUTCMonth() || (invD.getUTCMonth() === dobD.getUTCMonth() && invD.getUTCDate() < dobD.getUTCDate())) ? 1 : 0);
    ageStatus = age < 45 ? 'pass' : 'fail';
    ageEvidence = `Calculated age at invitation appears to be ${age}.`;
  }
  add('190_AGE_UNDER_45', 'Age under 45 at invitation', ageStatus, ageStatus === 'fail' ? 'REFUSAL LIKELY' : 'EVIDENCE GAP', ageStatus === 'fail' ? 'critical' : 'medium', ageEvidence, ageStatus === 'fail' ? 'The age criterion is not met if the applicant was 45 or older at invitation.' : 'Age cannot be finally assessed until identity and invitation date are verified.', 'Verify passport biodata page and the official invitation date.');

  const onshoreBad = hasSection48 || noFurtherStay;
  add('190_SECTION_48_NO_FURTHER_STAY', 'Section 48 / No Further Stay / onshore validity restrictions', onshoreBad ? 'fail' : 'unknown', onshoreBad ? 'INVALID APPLICATION' : 'EVIDENCE GAP', onshoreBad ? 'blocker' : 'high', onshoreBad ? 'The questionnaire flags a section 48 and/or No Further Stay issue.' : 'Current visa status and onshore restrictions were not fully verified.', onshoreBad ? 'If the applicant is barred or subject to an unresolved No Further Stay condition while in Australia, lodgement may be invalid.' : 'Validity cannot be confirmed without current visa and refusal/cancellation history.', onshoreBad ? 'Resolve the bar/condition or identify a lawful pathway before any lodgement action.' : 'Provide VEVO, current visa grant notice and any refusal/cancellation/waiver documents.');

  add('190_HEALTH_PIC', 'Health requirement', healthRisk ? 'risk' : 'unknown', healthRisk ? 'DISCRETIONARY RISK' : 'EVIDENCE GAP', healthRisk ? 'high' : 'medium', healthRisk ? 'Health issue disclosed but no medical evidence reviewed.' : 'Health position not verified.', healthRisk ? 'Health issues may affect grant and may require waiver analysis where available.' : 'Health cannot be finally assessed until examinations are completed.', 'Provide health examination results and relevant medical reports.');
  add('190_CHARACTER_PIC', 'Character requirement', characterRisk ? 'risk' : 'unknown', characterRisk ? 'DISCRETIONARY RISK' : 'EVIDENCE GAP', characterRisk ? 'high' : 'medium', characterRisk ? 'Character issue disclosed but police/court documents were not reviewed.' : 'Character position not verified.', characterRisk ? 'Character concerns may affect grant and require legal assessment.' : 'Character cannot be finally assessed without clearances.', 'Provide police certificates, court records and any character submissions.');
  add('190_PIC_4020', 'Integrity / PIC 4020 risk', integrityRisk ? 'risk' : 'unknown', integrityRisk ? 'REFUSAL LIKELY' : 'EVIDENCE GAP', integrityRisk ? 'critical' : 'medium', integrityRisk ? 'Integrity concern disclosed but prior Department records were not reviewed.' : 'Integrity position not verified.', integrityRisk ? 'PIC 4020 concerns are serious and may lead to refusal and exclusion periods.' : 'Integrity risk cannot be excluded without reviewing prior records.', 'Review all prior applications, documents and Department correspondence before proceeding.');
  add('190_FAMILY_MEMBERS', 'Family members / secondary applicants', childIncluded ? 'unknown' : 'unknown', 'EVIDENCE GAP', childIncluded ? 'medium' : 'low', childIncluded ? 'Dependent/family member issue disclosed, with relationship/custody/dependency evidence not verified.' : 'Family composition not fully verified.', childIncluded ? 'Secondary applicants may fail if relationship, custody or dependency evidence is insufficient.' : 'Family member position should be confirmed before final advice.', 'Provide birth/marriage certificates, custody documents and dependency evidence as relevant.');

  const blockers = findings.filter(f => f.status === 'fail' && f.severity === 'blocker');
  const criticalFails = findings.filter(f => f.status === 'fail' && f.severity === 'critical');
  const criticalRisks = findings.filter(f => f.status === 'risk' && f.severity === 'critical');
  let lodgementPosition = 'LODGEABLE_WITH_EVIDENCE_GAPS';
  let riskLevel = 'MEDIUM';
  if (blockers.length) { lodgementPosition = 'NOT_LODGEABLE'; riskLevel = 'CRITICAL'; }
  else if (criticalFails.length || criticalRisks.length) { lodgementPosition = 'LODGEABLE_HIGH_RISK'; riskLevel = 'HIGH'; }

  return {
    engine: 'subclass190-deterministic-v1',
    subclass: '190',
    lodgementPosition,
    lodgementPositionLabel: lodgementPosition === 'NOT_LODGEABLE' ? 'NOT LODGEABLE' : lodgementPosition.replace(/_/g, ' '),
    riskLevel,
    primaryReason: (blockers[0] || criticalFails[0] || criticalRisks[0] || findings[0] || {}).criterion || 'Evidence gaps remain',
    blockers,
    findings,
    evidenceRequired: [
      'SkillSelect invitation letter showing subclass, invitation date, nominated occupation and points score',
      'Current state or territory nomination approval letter',
      'Positive skills assessment outcome letter with assessing authority, occupation, date and validity',
      'Evidence the nominated occupation is eligible and aligns with the nomination',
      'English test result or eligible passport evidence',
      'Full points calculation with documents for each claimed component',
      'Passport biodata page and identity documents',
      'VEVO, current visa grant notice and any refusal/cancellation/waiver documents',
      'Health examination results and medical reports if relevant',
      'Police certificates, court records and character documents if relevant',
      'Prior Department correspondence and documents relevant to any PIC 4020/integrity concern',
      'Birth/marriage/custody/dependency documents for included family members'
    ]
  };
}

function subclass190DecisionToAdviceBundle(decision, assessment, originalBundle = {}) {
  const intro = decision.lodgementPosition === 'NOT_LODGEABLE'
    ? 'The deterministic Subclass 190 decision engine has identified one or more validity blockers. On the information provided, the matter is not lodgeable and should not proceed to lodgement until the blockers are resolved and original evidence is reviewed.'
    : 'The deterministic Subclass 190 decision engine has identified material evidence gaps and legal risks. The matter requires document verification before any lodgement strategy is confirmed.';

  const criteriaText = decision.findings.map(f => ({
    heading: f.criterion,
    title: f.criterion,
    finding: `${f.status.toUpperCase()} — ${f.evidence}`,
    legalConsequence: f.consequence,
    evidenceGap: f.evidence,
    recommendation: f.recommendation,
    status: f.status,
    legalEffect: f.legalEffect,
    severity: f.severity,
    ruleId: f.ruleId
  }));

  const forced = {
    ...originalBundle,
    deterministicEngineApplied: true,
    engine: decision.engine,
    riskLevel: decision.riskLevel,
    risk_level: decision.riskLevel,
    lodgementPosition: decision.lodgementPositionLabel,
    lodgement_position: decision.lodgementPositionLabel,
    finalPosition: {
      lodgementPosition: decision.lodgementPosition,
      lodgementPositionLabel: decision.lodgementPositionLabel,
      riskLevel: decision.riskLevel,
      primaryReason: decision.primaryReason,
      requiresManualReview: true,
      canGenerateAdviceLetter: true
    },
    title: `Preliminary Migration Advice – Subclass 190 Skilled Nominated Visa (${assessment.applicant_name || 'Applicant'})`,
    summaryOfFindings: intro,
    summary: intro,
    executiveSummary: intro,
    keyRisks: decision.blockers.length
      ? decision.blockers.map(b => `${b.criterion}: ${b.legalEffect}`)
      : decision.findings.filter(f => ['critical', 'high'].includes(f.severity)).map(f => `${f.criterion}: ${f.legalEffect}`),
    validityAssessment: {
      heading: 'Application validity assessment',
      result: decision.lodgementPositionLabel,
      riskLevel: decision.riskLevel,
      blockers: decision.blockers.map(b => ({ criterion: b.criterion, consequence: b.consequence, recommendation: b.recommendation }))
    },
    applicationValidityAssessment: `Result: ${decision.lodgementPositionLabel}. ${decision.blockers.length ? 'Validity blockers identified: ' + decision.blockers.map(b => b.criterion).join('; ') + '.' : 'No deterministic validity blocker identified, subject to evidence verification.'}`,
    criterionFindings: criteriaText,
    criteriaFindings: criteriaText,
    findings: criteriaText,
    evidenceRequired: decision.evidenceRequired,
    evidenceChecklist: {
      mandatoryBeforeLodgement: decision.evidenceRequired,
      requiredBeforeFinalAdvice: decision.evidenceRequired,
      recommendedSupportingDocuments: []
    },
    recommendedNextSteps: decision.lodgementPosition === 'NOT_LODGEABLE'
      ? [
          'Do not lodge a Subclass 190 application at this time.',
          'Resolve each validity blocker identified in the Application validity assessment.',
          'Provide the mandatory evidence listed below for legal review.',
          'Only reconsider lodgement after invitation, nomination, onshore validity and core criteria have been verified.'
        ]
      : [
          'Do not rely on this matter for lodgement until all evidence gaps are resolved.',
          'Provide the mandatory evidence listed below for legal review.',
          'Complete a points calculation and document verification before final advice.'
        ],
    qualityFlags: [
      `Deterministic 190 engine applied: ${decision.engine}`,
      `Forced lodgement position: ${decision.lodgementPositionLabel}`,
      `Forced risk level: ${decision.riskLevel}`,
      'GPT language layer must not override rule findings.'
    ],
    gptAdviceBundle: {
      permitted: true,
      role: 'language_only',
      cannotOverrideRules: true,
      forbidden: ['inventing evidence', 'changing rule status', 'upgrading NOT_LODGEABLE matters', 'removing validity blockers']
    }
  };

  return forced;
}

async function generateControlledAdviceBundle(assessment) {
  const original = await generateMigrationAdvice(assessment);
  if (String(assessment.visa_type || '').replace(/[^0-9]/g, '') === '190') {
    const decision = buildSubclass190DecisionEngineOutput(assessment);
    return subclass190DecisionToAdviceBundle(decision, assessment, original);
  }
  return original;
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
      const adviceBundle = await generateControlledAdviceBundle(assessment);
      pdf = await buildAssessmentPdfBuffer(assessment, adviceBundle);
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
    `SELECT id, visa_type, applicant_email, applicant_name, selected_plan, active_plan,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN 'pdf_ready' ELSE status END AS status,
            payment_status, amount_cents, currency, stripe_session_id, created_at, updated_at,
            pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NOT NULL AND octet_length(pdf_bytes) > 1024 THEN true ELSE false END AS has_pdf
     FROM assessments
     WHERE lower(client_email)=lower($1)
     ORDER BY created_at DESC`,
    [req.client.email]
  );
  const { rows: payments } = await query(
    `SELECT service_type, service_ref, visa_type, plan, stripe_session_id, amount_cents, currency, status, created_at
     FROM payments WHERE lower(client_email)=lower($1) ORDER BY created_at DESC`,
    [req.client.email]
  );
  res.json({
    ok: true,
    client: req.client,
    counts: {
      visaMatters: assessments.length,
      documentsReady: assessments.filter(a => a.has_pdf === true).length,
      payments: payments.length,
      citizenship: 0
    },
    assessments,
    payments
  });
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
    WHERE table_schema=current_schema() AND table_name IN ('clients','assessments','payments','pdf_jobs')
    ORDER BY table_name, ordinal_position
  `);
  res.json({ ok: true, tables: tables.rows });
}));

app.use((req, res) => res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.path}` }));

app.use((err, _req, res, _next) => {
  console.error('Unhandled server error:', err);
  if (String(err.message || '').startsWith('CORS blocked origin')) return res.status(403).json({ ok: false, error: err.message });
  res.status(500).json({ ok: false, error: publicError(err) });
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
