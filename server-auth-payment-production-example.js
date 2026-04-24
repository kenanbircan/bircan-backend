/*
Production account-based Stripe access example for the citizenship test page.
Merge these routes into your existing server.js. Replace the in-memory Maps with a real database before launch.
Required packages: express, cors, stripe, bcryptjs, jsonwebtoken
Required env:
  STRIPE_SECRET_KEY=sk_live_or_test_...
  STRIPE_WEBHOOK_SECRET=whsec_...
  JWT_SECRET=long_random_secret
  FRONTEND_URL=https://your-domain.com
  STRIPE_PRICE_CITIZENSHIP_20=price_...
  STRIPE_PRICE_CITIZENSHIP_50=price_...
  STRIPE_PRICE_CITIZENSHIP_100=price_...
*/

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;

const PLAN_MAP = {
  '20': { total: 20, priceId: process.env.STRIPE_PRICE_CITIZENSHIP_20, label: '20 exam pack' },
  '50': { total: 50, priceId: process.env.STRIPE_PRICE_CITIZENSHIP_50, label: '50 exam pack' },
  '100': { total: 100, priceId: process.env.STRIPE_PRICE_CITIZENSHIP_100, label: '100 exam pack' }
};

// DEMO STORAGE ONLY. Replace with your database.
const usersById = new Map();
const usersByEmail = new Map();
const usersByUsername = new Map();
const entitlementsByUserId = new Map();

app.use(cors({ origin: [FRONTEND_URL, 'http://localhost:5500', 'http://127.0.0.1:5500'], credentials: true }));

// Stripe webhook must use raw body before express.json.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata && session.metadata.userId;
    const plan = session.metadata && session.metadata.plan;
    const planData = PLAN_MAP[plan];
    if (userId && planData) {
      const existing = entitlementsByUserId.get(userId) || { userId, plan, total: 0, used: 0, remaining: 0 };
      const total = Number(existing.total || 0) + planData.total;
      const used = Number(existing.used || 0);
      entitlementsByUserId.set(userId, {
        userId,
        plan,
        planLabel: planData.label,
        total,
        used,
        remaining: Math.max(0, total - used),
        stripeCustomerId: session.customer,
        stripeSessionId: session.id,
        paidAt: new Date().toISOString()
      });
    }
  }
  res.json({ received: true });
});

app.use(express.json());

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email };
}
function signUser(u) {
  return jwt.sign({ sub: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' });
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Login required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = usersById.get(payload.sub);
    if (!user) return res.status(401).json({ ok: false, error: 'User not found.' });
    req.user = user;
    next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: 'Login expired. Please login again.' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (username.length < 3) return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters.' });
  if (!email.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email required.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  if (usersByEmail.has(email) || usersByUsername.has(username)) return res.status(409).json({ ok: false, error: 'Account already exists. Please login.' });
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  const passwordHash = await bcrypt.hash(password, 12);
  const user = { id, username, email, passwordHash, createdAt: new Date().toISOString() };
  usersById.set(id, user); usersByEmail.set(email, user); usersByUsername.set(username, user);
  res.json({ ok: true, user: publicUser(user), token: signUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = usersByEmail.get(login) || usersByUsername.get(login);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ ok: false, error: 'Invalid login details.' });
  res.json({ ok: true, user: publicUser(user), token: signUser(user) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/create-checkout-session', requireAuth, async (req, res) => {
  const plan = String(req.body.plan || '');
  const planData = PLAN_MAP[plan];
  if (!planData || !planData.priceId) return res.status(400).json({ ok: false, error: 'Invalid or unconfigured plan.' });
  const successUrl = req.body.successUrl || `${FRONTEND_URL}/citizenship-test.html?plan=${plan}&session_id={CHECKOUT_SESSION_ID}#paid-exams`;
  const cancelUrl = req.body.cancelUrl || `${FRONTEND_URL}/citizenship-test.html?payment_cancelled=1#pricing`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: req.user.email,
    line_items: [{ price: planData.priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId: req.user.id, plan }
  });
  res.json({ ok: true, url: session.url });
});

app.get('/checkout/verify-session', requireAuth, async (req, res) => {
  const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
  if (session.payment_status !== 'paid') return res.status(402).json({ ok: false, error: 'Payment has not been completed.' });
  if (session.metadata.userId !== req.user.id) return res.status(403).json({ ok: false, error: 'This payment belongs to a different account.' });
  const entitlement = entitlementsByUserId.get(req.user.id);
  if (!entitlement) return res.status(202).json({ ok: false, error: 'Payment received but entitlement is not ready yet. Check webhook configuration.' });
  res.json({ ok: true, entitlement });
});

app.get('/api/citizenship/my-entitlement', requireAuth, (req, res) => {
  const entitlement = entitlementsByUserId.get(req.user.id);
  if (!entitlement) return res.status(404).json({ ok: false, error: 'No paid exam pack is attached to this account.' });
  res.json({ ok: true, entitlement });
});

// Your existing /api/citizenship/start-paid should call requireAuth and check entitlementsByUserId/database.
app.post('/api/citizenship/start-paid', requireAuth, (req, res) => {
  const entitlement = entitlementsByUserId.get(req.user.id);
  if (!entitlement || entitlement.remaining <= 0) return res.status(403).json({ ok: false, error: 'No paid attempts remaining.' });
  // Return your existing generated 20-question exam here.
  res.status(501).json({ ok: false, error: 'Connect this route to your existing exam generator.' });
});

app.listen(process.env.PORT || 4242, () => console.log('Server running'));
