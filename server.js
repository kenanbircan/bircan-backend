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

const allowedOrigins = (process.env.ALLOWED_ORIGINS || [
  'https://bircanmigration.au',
  'https://www.bircanmigration.au',
  'https://bircanmigration.com.au',
  'https://www.bircanmigration.com.au',
  'https://assessment.bircanmigration.au',
  'http://localhost:3000',
  'http://localhost:4242'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true
}));

// Stripe webhook must use raw body.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret) : JSON.parse(req.body.toString());
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await attachPaidSession(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

function sign(client) {
  return jwt.sign({ sub: client.id, email: client.email }, SESSION_SECRET, { expiresIn: '7d' });
}

function setSessionCookie(res, token) {
  res.cookie('bm_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
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
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  }
}

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function makeAssessmentId(visaType) {
  return `sub_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function resolveVisaPriceId(visaType, plan) {
  const p = String(plan || '').toLowerCase();
  const key = p === 'instant' ? 'INSTANT' : p === '24h' ? '24H' : '3D';
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

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({
      ok: true,
      service: 'bircan-postgres-single-source-server',
      postgres: true,
      jsonFallback: false,
      stripeConfigured: Boolean(stripe),
      appBaseUrl: APP_BASE_URL
    });
  } catch (err) {
    res.status(500).json({ ok: false, postgres: false, error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const email = normaliseEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || password.length < 6) return res.status(400).json({ ok: false, error: 'Valid email and 6+ character password required.' });
  const existing = await query('SELECT id FROM clients WHERE email=$1', [email]);
  if (existing.rows[0]) return res.status(409).json({ ok: false, error: 'Account already exists. Please log in.' });
  const client = await upsertClient(email, password, req.body.name);
  setSessionCookie(res, sign(client));
  res.json({ ok: true, client });
});

app.post('/api/auth/login', async (req, res) => {
  const email = normaliseEmail(req.body.email);
  const password = String(req.body.password || '');
  const { rows } = await query('SELECT id, email, name, password_hash FROM clients WHERE email=$1', [email]);
  const client = rows[0];
  if (!client || !(await bcrypt.compare(password, client.password_hash))) {
    return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
  }
  setSessionCookie(res, sign(client));
  res.json({ ok: true, client: { id: client.id, email: client.email, name: client.name } });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ ok: true, client: req.client }));

app.post('/api/assessment/submit', requireAuth, async (req, res) => {
  const visaType = String(req.body.visaType || req.body.visa_type || '').replace(/[^0-9A-Za-z]/g, '') || 'unknown';
  const selectedPlan = String(req.body.plan || req.body.selectedPlan || 'instant').toLowerCase();
  const plan = selectedPlan === '24h' ? '24h' : selectedPlan === '3d' || selectedPlan === '3days' ? '3d' : 'instant';
  const applicantEmail = normaliseEmail(req.body.applicantEmail || req.body.email || req.client.email);
  if (applicantEmail !== normaliseEmail(req.client.email)) {
    return res.status(409).json({ ok: false, error: `This assessment email is ${applicantEmail}, but you are logged in as ${req.client.email}. Please use the same email address.` });
  }
  const id = makeAssessmentId(visaType);
  await query(
    `INSERT INTO assessments (id, client_id, client_email, applicant_email, applicant_name, visa_type, selected_plan, active_plan, status, form_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'payment_pending',$8)`,
    [id, req.client.id, req.client.email, applicantEmail, req.body.applicantName || null, visaType, plan, req.body.formPayload || req.body.answers || req.body]
  );
  res.json({ ok: true, assessmentId: id, status: 'payment_pending', plan });
});

app.post('/api/assessment/create-checkout-session', requireAuth, async (req, res) => {
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
  });
  await query('UPDATE assessments SET stripe_session_id=$1, updated_at=now() WHERE id=$2', [session.id, assessment.id]);
  res.json({ ok: true, url: session.url, sessionId: session.id });
});

async function attachPaidSession(session) {
  const md = session.metadata || {};
  if (md.service_type !== 'visa_assessment') return;
  const assessmentId = md.assessment_id;
  const email = normaliseEmail(md.client_email || session.customer_email);
  await tx(async (client) => {
    const assessmentRes = await client.query('SELECT * FROM assessments WHERE id=$1 FOR UPDATE', [assessmentId]);
    const assessment = assessmentRes.rows[0];
    if (!assessment) throw new Error(`Assessment not found for Stripe session ${session.id}`);
    if (normaliseEmail(assessment.client_email) !== email) throw new Error('Stripe email does not match assessment account email.');

    await client.query(
      `UPDATE assessments
       SET status='preparing', payment_status='paid', stripe_session_id=$1, stripe_payment_intent=$2,
           amount_cents=$3, currency=$4, active_plan=selected_plan, generation_error=NULL, updated_at=now()
       WHERE id=$5`,
      [session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', assessmentId]
    );

    await client.query(
      `INSERT INTO payments (client_id, client_email, service_type, service_ref, visa_type, plan, stripe_session_id, stripe_payment_intent, amount_cents, currency, status, raw_payload)
       VALUES ($1,$2,'visa_assessment',$3,$4,$5,$6,$7,$8,$9,'paid',$10)
       ON CONFLICT (stripe_session_id) DO NOTHING`,
      [assessment.client_id, email, assessmentId, assessment.visa_type, assessment.selected_plan, session.id, session.payment_intent || null, session.amount_total || null, session.currency || 'aud', session]
    );

    await client.query(
      `INSERT INTO pdf_jobs (assessment_id, status, run_after)
       VALUES ($1,'queued',now())
       ON CONFLICT DO NOTHING`,
      [assessmentId]
    );
  });
}

app.post('/api/assessment/verify-payment', requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
  const sessionId = req.body.sessionId || req.query.session_id;
  if (!sessionId || sessionId.includes('{CHECKOUT_SESSION_ID}')) return res.status(400).json({ ok: false, error: 'Valid Stripe session_id is required.' });
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  await attachPaidSession(session);
  res.json({ ok: true, status: 'paid', sessionId });
});

app.post('/api/assessment/generate-pdf', requireAuth, async (req, res) => {
  const assessmentId = req.body.assessmentId || req.body.assessment_id || req.body.id;
  const result = await generateAssessmentPdfNow(assessmentId, req.client.email);
  res.json({ ok: true, assessment: result });
});

app.get('/api/assessment/generate-pdf', (req, res) => {
  res.status(405).json({ ok: false, error: 'Use POST /api/assessment/generate-pdf with assessmentId. GET is intentionally guarded.' });
});

app.post('/api/assessment/retry-generation', requireAuth, async (req, res) => {
  const assessmentId = req.body.assessmentId || req.body.assessment_id || req.body.id;
  const { rows } = await query('SELECT id FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [assessmentId, req.client.email]);
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  await query(`UPDATE assessments SET status='preparing', generation_error=NULL, updated_at=now() WHERE id=$1`, [assessmentId]);
  await query(`INSERT INTO pdf_jobs (assessment_id, status, run_after) VALUES ($1,'queued',now()) ON CONFLICT DO NOTHING`, [assessmentId]);
  res.json({ ok: true, status: 'queued' });
});

async function generateAssessmentPdfNow(assessmentId, accountEmail = null) {
  if (!assessmentId) throw new Error('assessmentId is required');
  const { rows } = await query(
    `SELECT * FROM assessments WHERE id=$1 ${accountEmail ? 'AND lower(client_email)=lower($2)' : ''}`,
    accountEmail ? [assessmentId, accountEmail] : [assessmentId]
  );
  const assessment = rows[0];
  if (!assessment) throw new Error('Assessment was not found.');
  if (assessment.payment_status !== 'paid') throw new Error('Payment is not verified for this assessment.');
  if (assessment.pdf_bytes) return assessment;

  await query(`UPDATE assessments SET status='preparing', generation_attempts=generation_attempts+1, generation_locked_at=now(), generation_error=NULL, updated_at=now() WHERE id=$1`, [assessmentId]);
  try {
    const pdf = await buildAssessmentPdfBuffer(assessment);
    const filename = `Bircan-${assessment.visa_type}-${assessment.id}.pdf`;
    const hash = sha256(pdf);
    const { rows: updatedRows } = await query(
      `UPDATE assessments
       SET status='ready', pdf_bytes=$1, pdf_mime='application/pdf', pdf_filename=$2,
           pdf_sha256=$3, pdf_generated_at=now(), generation_error=NULL, updated_at=now()
       WHERE id=$4
       RETURNING id, visa_type, client_email, applicant_email, selected_plan, active_plan, status, pdf_filename, pdf_sha256, pdf_generated_at`,
      [pdf, filename, hash, assessmentId]
    );
    await query(`UPDATE pdf_jobs SET status='completed', updated_at=now() WHERE assessment_id=$1 AND status IN ('queued','processing')`, [assessmentId]);
    return updatedRows[0];
  } catch (err) {
    await query(`UPDATE assessments SET status='failed', generation_error=$1, updated_at=now() WHERE id=$2`, [err.message, assessmentId]);
    await query(`UPDATE pdf_jobs SET status='failed', attempts=attempts+1, last_error=$1, updated_at=now() WHERE assessment_id=$2 AND status IN ('queued','processing')`, [err.message, assessmentId]);
    throw err;
  }
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
    const retry = job.attempts < 3;
    await query(
      `UPDATE pdf_jobs SET status=$1, last_error=$2, run_after=now() + interval '2 minutes', updated_at=now() WHERE id=$3`,
      [retry ? 'queued' : 'failed', err.message, job.id]
    );
  }
  return true;
}

setInterval(() => runOnePdfJob().catch(err => console.error('PDF worker tick failed:', err)), Number(process.env.PDF_WORKER_INTERVAL_MS || 10000));

app.get('/api/account/dashboard', requireAuth, async (req, res) => {
  const { rows: assessments } = await query(
    `SELECT id, visa_type, applicant_email, applicant_name, selected_plan, active_plan, status,
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
});

app.get('/api/assessment/:id/pdf', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [req.params.id, req.client.email]);
  const assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
  if (!assessment.pdf_bytes) return res.status(409).json({ ok: false, error: 'PDF not ready. The advice letter has not been generated yet.', status: assessment.status, generationError: assessment.generation_error });
  res.setHeader('Content-Type', assessment.pdf_mime || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${assessment.pdf_filename || assessment.id + '.pdf'}"`);
  res.send(assessment.pdf_bytes);
});

app.post('/api/assessment/:id/email-pdf', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [req.params.id, req.client.email]);
  const assessment = rows[0];
  if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
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
    attachments: [{ filename: assessment.pdf_filename, content: assessment.pdf_bytes, contentType: 'application/pdf' }]
  });
  res.json({ ok: true, emailedTo: assessment.client_email });
});

app.use((req, res) => res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`Bircan PostgreSQL single source server listening on ${PORT}`));
