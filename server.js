const express = require('express');
const path = require('path');
const fs = require('fs');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const DATA_DIR = path.join(__dirname, 'data');
const ENTITLEMENTS_FILE = path.join(DATA_DIR, 'entitlements.json');

const PLAN_CONFIG = {
  '20': { total: 20, priceId: process.env.STRIPE_PRICE_CITIZENSHIP_20 || '' },
  '50': { total: 50, priceId: process.env.STRIPE_PRICE_CITIZENSHIP_50 || '' },
  '100': { total: 100, priceId: process.env.STRIPE_PRICE_CITIZENSHIP_100 || '' }
};

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ENTITLEMENTS_FILE)) fs.writeFileSync(ENTITLEMENTS_FILE, JSON.stringify({ entitlements: {} }, null, 2));
}

function readStore() {
  ensureDataStore();
  return JSON.parse(fs.readFileSync(ENTITLEMENTS_FILE, 'utf8'));
}

function writeStore(store) {
  ensureDataStore();
  fs.writeFileSync(ENTITLEMENTS_FILE, JSON.stringify(store, null, 2));
}

function getEntitlement(browserId) {
  const store = readStore();
  return store.entitlements[browserId] || null;
}

function upsertEntitlement(browserId, entitlement) {
  const store = readStore();
  store.entitlements[browserId] = entitlement;
  writeStore(store);
  return entitlement;
}

function removeEntitlement(browserId) {
  const store = readStore();
  delete store.entitlements[browserId];
  writeStore(store);
}

function validatePlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLAN_CONFIG, String(plan));
}

function sanitizeBrowserId(browserId) {
  if (typeof browserId !== 'string') return '';
  return browserId.trim().slice(0, 200);
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).send('Stripe is not configured.');
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).send('Webhook secret is missing.');

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const browserId = sanitizeBrowserId(session.metadata?.browserId || '');
    const plan = String(session.metadata?.plan || '');
    if (browserId && validatePlan(plan)) {
      upsertEntitlement(browserId, {
        browserId,
        total: PLAN_CONFIG[plan].total,
        remaining: PLAN_CONFIG[plan].total,
        mode: 'paid',
        paid: true,
        plan,
        checkoutSessionId: session.id,
        paymentStatus: session.payment_status,
        customerEmail: session.customer_details?.email || null,
        createdAt: new Date().toISOString(),
        source: 'webhook'
      });
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stripeConfigured: Boolean(STRIPE_SECRET_KEY),
    webhookConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
    plans: Object.fromEntries(Object.entries(PLAN_CONFIG).map(([key, value]) => [key, { total: value.total, hasPriceId: Boolean(value.priceId) }]))
  });
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe secret key is missing in .env.' });

    const plan = String(req.body.plan || '');
    const browserId = sanitizeBrowserId(req.body.browserId);
    if (!validatePlan(plan)) return res.status(400).json({ error: 'Invalid plan selected.' });
    if (!browserId) return res.status(400).json({ error: 'Browser ID is required.' });
    if (!PLAN_CONFIG[plan].priceId) return res.status(500).json({ error: `Missing Stripe price ID for plan ${plan}.` });

    const successUrl = `${BASE_URL}/citizenship-success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${BASE_URL}/citizenship-cancel.html`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PLAN_CONFIG[plan].priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: browserId,
      metadata: { browserId, plan },
      payment_method_types: ['card']
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not create Stripe Checkout session.' });
  }
});

app.get('/api/stripe/verify-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe secret key is missing in .env.' });
    const sessionId = String(req.query.session_id || '');
    if (!sessionId) return res.status(400).json({ error: 'session_id is required.' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const browserId = sanitizeBrowserId(session.metadata?.browserId || session.client_reference_id || '');
    const plan = String(session.metadata?.plan || '');

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'This Checkout Session is not paid.', payment_status: session.payment_status });
    }
    if (!browserId || !validatePlan(plan)) {
      return res.status(400).json({ error: 'Session metadata is incomplete.' });
    }

    const existing = getEntitlement(browserId);
    const entitlement = existing && existing.mode === 'paid'
      ? existing
      : upsertEntitlement(browserId, {
          browserId,
          total: PLAN_CONFIG[plan].total,
          remaining: PLAN_CONFIG[plan].total,
          mode: 'paid',
          paid: true,
          plan,
          checkoutSessionId: session.id,
          paymentStatus: session.payment_status,
          customerEmail: session.customer_details?.email || null,
          createdAt: new Date().toISOString(),
          source: 'verify-session'
        });

    res.json({ verified: true, entitlement, session: { id: session.id, payment_status: session.payment_status, customer_email: session.customer_details?.email || null } });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not verify Stripe session.' });
  }
});

app.get('/api/citizenship-plan', (req, res) => {
  const browserId = sanitizeBrowserId(req.query.browser_id || '');
  if (!browserId) return res.status(400).json({ error: 'browser_id is required.' });
  res.json({ entitlement: getEntitlement(browserId) });
});

app.post('/api/preview-plan', (req, res) => {
  const plan = String(req.body.plan || '');
  const browserId = sanitizeBrowserId(req.body.browserId);
  if (!validatePlan(plan)) return res.status(400).json({ error: 'Invalid plan selected.' });
  if (!browserId) return res.status(400).json({ error: 'Browser ID is required.' });

  const entitlement = upsertEntitlement(browserId, {
    browserId,
    total: PLAN_CONFIG[plan].total,
    remaining: PLAN_CONFIG[plan].total,
    mode: 'preview',
    paid: false,
    plan,
    createdAt: new Date().toISOString(),
    source: 'preview'
  });

  res.json({ entitlement });
});

app.post('/api/reset-plan', (req, res) => {
  const browserId = sanitizeBrowserId(req.body.browserId);
  if (!browserId) return res.status(400).json({ error: 'Browser ID is required.' });
  removeEntitlement(browserId);
  res.json({ ok: true });
});

app.post('/api/citizenship/start-exam', (req, res) => {
  const browserId = sanitizeBrowserId(req.body.browserId);
  if (!browserId) return res.status(400).json({ error: 'Browser ID is required.' });
  const entitlement = getEntitlement(browserId);
  if (!entitlement) return res.status(403).json({ error: 'No active plan found for this browser.' });
  if (Number(entitlement.remaining) <= 0) return res.status(403).json({ error: 'No attempts remain on this plan.' });

  entitlement.remaining = Number(entitlement.remaining) - 1;
  entitlement.lastStartedAt = new Date().toISOString();
  upsertEntitlement(browserId, entitlement);

  res.json({ ok: true, entitlement });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'citizenship-test.html'));
});

app.listen(PORT, () => {
  ensureDataStore();
  console.log(`Bircan Migration Stripe test server running on ${BASE_URL}`);
});
