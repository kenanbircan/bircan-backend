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
      status text NOT NULL DEFAULT 'payment_pending',
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
  await query(`ALTER TABLE assessments ADD COLUMN IF NOT EXISTS status text DEFAULT 'payment_pending'`);
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
    version: '10.0.2-payment-audit-safe-id-hardened',
    postgres: true,
    jsonFallback: false,
    stripeConfigured: Boolean(stripe),
    smtpConfigured: Boolean(process.env.SMTP_HOST),
    appBaseUrl: APP_BASE_URL,
    corsPatch: 'matched-frontend-backend-final-x-auth-token',
    pdfMode: 'instant-on-demand-plus-queue-fallback',
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

app.post('/api/assessment/submit', requireAuth, asyncRoute(async (req, res) => {
  const visaType = String(req.body.visaType || req.body.visa_type || '').replace(/[^0-9A-Za-z]/g, '') || 'unknown';
  const plan = safePlan(req.body.plan || req.body.selectedPlan || req.body.selected_plan || 'instant');
  const applicantEmail = normaliseEmail(req.body.applicantEmail || req.body.applicant_email || req.body.email || req.client.email);
  if (applicantEmail !== normaliseEmail(req.client.email)) {
    return res.status(409).json({ ok: false, error: `This assessment email is ${applicantEmail}, but you are logged in as ${req.client.email}. Please use the same email address.` });
  }
  const id = makeAssessmentId(visaType);
  await query(
    `INSERT INTO assessments (id, client_id, client_email, applicant_email, applicant_name, visa_type, selected_plan, active_plan, status, payment_status, form_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'payment_pending','unpaid',$8)`,
    [id, req.client.id, req.client.email, applicantEmail, req.body.applicantName || req.body.applicant_name || null, visaType, plan, req.body.formPayload || req.body.answers || req.body]
  );
  res.json({ ok: true, assessmentId: id, status: 'payment_pending', plan });
}));

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
  await query('UPDATE assessments SET stripe_session_id=$1, updated_at=now() WHERE id=$2', [session.id, assessment.id]);
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

    await client.query(
      `UPDATE assessments
       SET status=CASE WHEN pdf_bytes IS NULL THEN 'preparing' ELSE 'ready' END,
           payment_status='paid', stripe_session_id=$1, stripe_payment_intent=$2,
           amount_cents=$3, currency=$4, active_plan=selected_plan, generation_error=NULL, updated_at=now()
       WHERE id=$5`,
      [session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', assessmentId]
    );

    // Do not insert into payments inside this transaction.
    // Some live databases have an old payments.id column with NOT NULL but no default.
    // A failing audit insert must never roll back the paid assessment attachment.

    await client.query(
      `INSERT INTO pdf_jobs (assessment_id, status, run_after)
       VALUES ($1,'queued',now())
       ON CONFLICT (assessment_id) DO UPDATE SET status=CASE WHEN pdf_jobs.status='completed' THEN 'completed' ELSE 'queued' END, run_after=now(), updated_at=now()`,
      [assessmentId]
    );
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
  const result = await generateAssessmentPdfNow(assessmentId, req.client.email);
  const downloadUrl = `/api/assessment/${encodeURIComponent(result.id || assessmentId)}/pdf`;
  res.json({
    ok: true,
    ready: true,
    assessment: result,
    assessmentId: result.id || assessmentId,
    downloadUrl,
    pdfUrl: downloadUrl
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
  await query(`UPDATE assessments SET status='preparing', generation_error=NULL, updated_at=now() WHERE id=$1`, [assessmentId]);
  await query(`INSERT INTO pdf_jobs (assessment_id, status, run_after) VALUES ($1,'queued',now()) ON CONFLICT (assessment_id) DO UPDATE SET status='queued', run_after=now(), last_error=NULL, updated_at=now()`, [assessmentId]);
  const result = await generateAssessmentPdfNow(assessmentId, req.client.email);
  res.json({ ok: true, status: 'ready', assessment: result });
}));

async function generateAssessmentPdfNow(assessmentId, accountEmail = null) {
  if (!assessmentId) throw new Error('assessmentId is required');

  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM assessments WHERE id=$1 ${accountEmail ? 'AND lower(client_email)=lower($2)' : ''} FOR UPDATE`,
      accountEmail ? [assessmentId, accountEmail] : [assessmentId]
    );
    const assessment = rows[0];
    if (!assessment) throw new Error('Assessment was not found.');
    if (assessment.payment_status !== 'paid') throw new Error('Payment is not verified for this assessment.');
    if (assessment.pdf_bytes) {
      if (assessment.status !== 'ready') await client.query(`UPDATE assessments SET status='ready', updated_at=now() WHERE id=$1`, [assessmentId]);
      await client.query(`UPDATE pdf_jobs SET status='completed', updated_at=now() WHERE assessment_id=$1`, [assessmentId]);
      return toPublicAssessment({ ...assessment, status: 'ready', has_pdf: true });
    }

    await client.query(
      `UPDATE assessments SET status='preparing', generation_attempts=COALESCE(generation_attempts,0)+1, generation_locked_at=now(), generation_error=NULL, updated_at=now() WHERE id=$1`,
      [assessmentId]
    );

    let pdf;
    try {
      pdf = await buildAssessmentPdfBuffer(assessment);
    } catch (err) {
      await client.query(`UPDATE assessments SET status='failed', generation_error=$1, updated_at=now() WHERE id=$2`, [err.message, assessmentId]);
      await client.query(`UPDATE pdf_jobs SET status='failed', last_error=$1, updated_at=now() WHERE assessment_id=$2`, [err.message, assessmentId]);
      throw err;
    }

    const filename = `Bircan-${assessment.visa_type}-${assessment.id}.pdf`;
    const hash = sha256(pdf);
    const { rows: updatedRows } = await client.query(
      `UPDATE assessments
       SET status='ready', pdf_bytes=$1, pdf_mime='application/pdf', pdf_filename=$2,
           pdf_sha256=$3, pdf_generated_at=now(), generation_error=NULL, updated_at=now()
       WHERE id=$4
       RETURNING id, visa_type, client_email, applicant_email, applicant_name, selected_plan, active_plan, status, payment_status, pdf_filename, pdf_sha256, pdf_generated_at, created_at, updated_at, true AS has_pdf`,
      [pdf, filename, hash, assessmentId]
    );
    await client.query(`UPDATE pdf_jobs SET status='completed', updated_at=now(), last_error=NULL WHERE assessment_id=$1`, [assessmentId]);
    return updatedRows[0];
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
    status: a.pdf_bytes || a.has_pdf ? 'ready' : a.status,
    payment_status: a.payment_status,
    pdf_filename: a.pdf_filename,
    pdf_sha256: a.pdf_sha256,
    pdf_generated_at: a.pdf_generated_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
    has_pdf: Boolean(a.pdf_bytes || a.has_pdf),
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
            CASE WHEN pdf_bytes IS NOT NULL THEN 'ready' ELSE status END AS status,
            payment_status, amount_cents, currency, stripe_session_id, created_at, updated_at,
            pdf_generated_at, pdf_filename, generation_error,
            CASE WHEN pdf_bytes IS NULL THEN false ELSE true END AS has_pdf
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
      documentsReady: assessments.filter(a => a.has_pdf).length,
      payments: payments.length,
      citizenship: 0
    },
    assessments,
    payments
  });
}));

app.get('/api/assessment/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, visa_type, selected_plan, active_plan, CASE WHEN pdf_bytes IS NOT NULL THEN 'ready' ELSE status END AS status, payment_status, pdf_generated_at, pdf_filename, generation_error, CASE WHEN pdf_bytes IS NULL THEN false ELSE true END AS has_pdf
     FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)`,
    [req.params.id, req.client.email]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  res.json({ ok: true, assessment: rows[0] });
}));

app.get('/api/assessment/:id/pdf', requireAuth, asyncRoute(async (req, res) => {
  let { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [req.params.id, req.client.email]);
  let assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });

  if (!assessment.pdf_bytes && assessment.payment_status === 'paid') {
    await generateAssessmentPdfNow(req.params.id, req.client.email);
    rows = (await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [req.params.id, req.client.email])).rows;
    assessment = rows[0];
  }

  if (!assessment.pdf_bytes) return res.status(409).json({ ok: false, error: 'PDF not ready. The advice letter has not been generated yet.', status: assessment.status, generationError: assessment.generation_error });
  res.setHeader('Content-Type', assessment.pdf_mime || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${assessment.pdf_filename || assessment.id + '.pdf'}"`);
  res.send(assessment.pdf_bytes);
}));

app.post('/api/assessment/:id/email-pdf', requireAuth, asyncRoute(async (req, res) => {
  let { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [req.params.id, req.client.email]);
  let assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  if (!assessment.pdf_bytes && assessment.payment_status === 'paid') {
    await generateAssessmentPdfNow(req.params.id, req.client.email);
    rows = (await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [req.params.id, req.client.email])).rows;
    assessment = rows[0];
  }
  if (!assessment.pdf_bytes) return res.status(409).json({ ok: false, error: 'PDF not ready.' });
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
