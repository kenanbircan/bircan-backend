import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Stripe from 'stripe';
import {
  createSubmission,
  getSubmission,
  listSubmissions,
  updateSubmission,
  getStats
} from './src/storage.js';
import { generateAssessmentPdf } from './src/pdf.js';
import { sendAdminNotification, sendClientReceipt } from './src/mailer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const adminKey = process.env.ADMIN_KEY || 'change-this-admin-key';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key || '';
  if (key !== adminKey) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

const PRODUCT_CONFIG = {
  partner_report: { label: 'Partner Visa Assessment Report', envPrice: 'STRIPE_PRICE_PARTNER_REPORT', amount: 9900 },
  appeal_review: { label: 'Urgent Appeal Review', envPrice: 'STRIPE_PRICE_APPEAL_REVIEW', amount: 19900 },
  citizenship_review: { label: 'Citizenship Eligibility Review', envPrice: 'STRIPE_PRICE_CITIZENSHIP_REVIEW', amount: 7900 },
  citizenship_premium: { label: 'Premium Citizenship Test Practice', envPrice: 'STRIPE_PRICE_CITIZENSHIP_PREMIUM', amount: 1900 },
  consultation: { label: 'Consultation Booking Deposit', envPrice: 'STRIPE_PRICE_CONSULTATION', amount: 14900 },
};

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-phase3',
    hasStripe: Boolean(stripe),
    hasMail: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    storage: 'json-files',
    time: new Date().toISOString()
  });
});

app.post('/api/submissions', async (req, res) => {
  try {
    const payload = req.body || {};
    const submission = createSubmission({
      type: payload.type || 'general',
      productKey: payload.productKey || null,
      name: payload.name || '',
      email: payload.email || '',
      phone: payload.phone || '',
      status: 'new',
      paymentStatus: 'unpaid',
      score: typeof payload.score === 'number' ? payload.score : null,
      summary: payload.summary || '',
      formData: payload.formData || {},
      sourcePath: payload.sourcePath || '',
      metadata: payload.metadata || {}
    });

    let pdfPath = null;
    if (payload.generatePdf) {
      pdfPath = await generateAssessmentPdf(submission);
      updateSubmission(submission.id, { pdfPath });
    }

    sendAdminNotification(submission).catch(() => {});
    res.json({ ok: true, submissionId: submission.id, pdfPath: pdfPath ? `/api/submissions/${submission.id}/pdf` : null });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Failed to save submission' });
  }
});

app.get('/api/submissions/:id', (req, res) => {
  const submission = getSubmission(req.params.id);
  if (!submission) return res.status(404).json({ ok: false, error: 'Submission not found' });
  res.json({ ok: true, submission });
});

app.get('/api/submissions/:id/pdf', async (req, res) => {
  const submission = getSubmission(req.params.id);
  if (!submission) return res.status(404).json({ ok: false, error: 'Submission not found' });

  let pdfPath = submission.pdfPath;
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    pdfPath = await generateAssessmentPdf(submission);
    updateSubmission(submission.id, { pdfPath });
  }
  return res.sendFile(pdfPath);
});

app.post('/api/payments/checkout-session', async (req, res) => {
  try {
    const { productKey, submissionId, customerEmail, customerName } = req.body || {};
    const product = PRODUCT_CONFIG[productKey];
    if (!product) return res.status(400).json({ ok: false, error: 'Unknown product' });

    const successUrl = `${appUrl}/success.html?product=${encodeURIComponent(productKey)}${submissionId ? `&submissionId=${encodeURIComponent(submissionId)}` : ''}`;
    const cancelUrl = `${appUrl}/cancel.html?product=${encodeURIComponent(productKey)}`;

    if (!stripe) {
      return res.json({ ok: true, mock: true, url: successUrl });
    }

    const priceId = process.env[product.envPrice];
    const sessionConfig = {
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
      metadata: {
        productKey,
        submissionId: submissionId || '',
        customerName: customerName || ''
      },
      line_items: priceId ? [{ price: priceId, quantity: 1 }] : [{
        price_data: {
          currency: 'aud',
          product_data: { name: product.label },
          unit_amount: product.amount
        },
        quantity: 1
      }]
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);
    if (submissionId) {
      updateSubmission(submissionId, { stripeSessionId: session.id, productKey });
    }
    res.json({ ok: true, url: session.url });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Checkout session failed' });
  }
});

app.post('/api/payments/mark-paid', async (req, res) => {
  try {
    const { submissionId, productKey } = req.body || {};
    if (!submissionId) return res.status(400).json({ ok: false, error: 'submissionId required' });
    const submission = getSubmission(submissionId);
    if (!submission) return res.status(404).json({ ok: false, error: 'Submission not found' });
    updateSubmission(submissionId, { paymentStatus: 'paid', productKey: productKey || submission.productKey || null, paidAt: new Date().toISOString() });
    const updated = getSubmission(submissionId);
    sendClientReceipt(updated).catch(() => {});
    res.json({ ok: true, submission: updated });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Unable to mark paid' });
  }
});

app.post('/api/contact', (req, res) => {
  try {
    const payload = req.body || {};
    const submission = createSubmission({
      type: 'contact',
      productKey: payload.productKey || null,
      name: payload.name || '',
      email: payload.email || '',
      phone: payload.phone || '',
      status: 'new',
      paymentStatus: 'n/a',
      summary: payload.message || '',
      formData: payload,
      sourcePath: '/contact',
      metadata: {}
    });
    sendAdminNotification(submission).catch(() => {});
    res.json({ ok: true, submissionId: submission.id });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Contact submission failed' });
  }
});

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  res.json({ ok: true, stats: getStats() });
});

app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const type = req.query.type || '';
  const status = req.query.status || '';
  const submissions = listSubmissions({ type, status });
  res.json({ ok: true, submissions });
});

app.patch('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  const updated = updateSubmission(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ ok: false, error: 'Submission not found' });
  res.json({ ok: true, submission: updated });
});

app.get('/admin', (_req, res) => res.redirect('/admin/'));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const target = path.join(publicDir, req.path);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return res.sendFile(target);
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`Bircan Migration Phase 3 running on ${appUrl}`);
});
